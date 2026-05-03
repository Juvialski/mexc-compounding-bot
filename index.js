const ccxt = require('ccxt');
const express = require('express');
const { RSI, SMA, ATR, ADX, OBV } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Elite Sniper Bot: Operational'));
app.listen(port);

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' }
});

// --- SETTINGS ---
const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskFactor = 0.05;      // 5% of balance per trade
const obiThreshold = 0.70;    // Higher sensitivity for "Elite" signals
const historyLimit = 5;       
let obiHistory = [];

// --- DYNAMIC STATE ---
let contractSize = 1;
let isTrading = false;

/**
 * Fetch Institutional Market Context
 */
async function getMarketContext() {
    // 1h candles for Trend, 15m for execution
    const ohlcv1h = await mexc.fetchOHLCV(symbol, '1h', undefined, 50);
    const ohlcv15m = await mexc.fetchOHLCV(symbol, '15m', undefined, 50);

    const closes1h = ohlcv1h.map(c => c[4]);
    const closes15m = ohlcv15m.map(c => c[4]);
    const highs15m = ohlcv15m.map(c => c[2]);
    const lows15m = ohlcv15m.map(c => c[3]);
    const volumes15m = ohlcv15m.map(c => c[5]);

    // 1. Trend Filter (1h SMA 20)
    const smaValue = SMA.calculate({ period: 20, values: closes1h }).pop();
    const currentPrice = closes15m[closes15m.length - 1];
    const trend = currentPrice > smaValue ? 'BULLISH' : 'BEARISH';

    // 2. Trend Strength (ADX 14) -> Must be > 25 for strong move
    const adxData = ADX.calculate({
        high: highs15m,
        low: lows15m,
        close: closes15m,
        period: 14
    }).pop();
    const trendStrength = adxData ? adxData.adx : 0;

    // 3. Momentum (RSI 14)
    const rsiValue = RSI.calculate({ period: 14, values: closes15m }).pop();

    // 4. Volume Confirmation (OBV) -> Checking if OBV is higher than 3 candles ago
    const obvValues = OBV.calculate({ close: closes15m, volume: volumes15m });
    const currentObv = obvValues[obvValues.length - 1];
    const prevObv = obvValues[obvValues.length - 4];
    const isVolumeConfirming = trend === 'BULLISH' ? currentObv > prevObv : currentObv < prevObv;

    // 5. Volatility for Stop Loss (ATR 14)
    const atrValue = ATR.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m }).pop();

    return { 
        trend, 
        trendStrength, 
        rsi: rsiValue, 
        atr: atrValue, 
        isVolumeConfirming,
        currentPrice 
    };
}

async function runBot() {
    if (isTrading) return; 
    isTrading = true;

    try {
        const ctx = await getMarketContext();
        const positions = await mexc.fetchPositions([symbol]);
        const longPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'long');
        const shortPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'short');

        const balance = await mexc.fetchBalance();
        const usdtBalance = balance.total['USDT'] || 0;

        // Order Book Imbalance Calculation
        const orderbook = await mexc.fetchOrderBook(symbol, 10);
        const sumBids = orderbook.bids.reduce((a, b) => a + b[1], 0);
        const sumAsks = orderbook.asks.reduce((a, b) => a + b[1], 0);
        const currentObi = (sumBids - sumAsks) / (sumBids + sumAsks);
        
        obiHistory.push(currentObi);
        if (obiHistory.length > historyLimit) obiHistory.shift();
        const avgObi = obiHistory.reduce((a, b) => a + b, 0) / obiHistory.length;

        console.log(`[LOG] Price: ${ctx.currentPrice} | ADX: ${ctx.trendStrength.toFixed(1)} | OBV OK: ${ctx.isVolumeConfirming} | OBI: ${avgObi.toFixed(2)}`);

        // --- ELITE EXIT LOGIC (ATR & RSI EXHAUSTION) ---
        if (longPos) {
            const stopLoss = ctx.currentPrice - (ctx.atr * 2); 
            if (ctx.currentPrice < stopLoss || ctx.rsi > 85) {
                console.log(">>> INSTITUTIONAL EXIT: Closing Long");
                await mexc.createMarketSellOrder(symbol, longPos.contracts, { 'openType': 1, 'positionType': 1 });
            }
        }
        if (shortPos) {
            const stopLoss = ctx.currentPrice + (ctx.atr * 2);
            if (ctx.currentPrice > stopLoss || ctx.rsi < 15) {
                console.log(">>> INSTITUTIONAL EXIT: Closing Short");
                await mexc.createMarketBuyOrder(symbol, shortPos.contracts, { 'openType': 1, 'positionType': 2 });
            }
        }

        // --- ELITE ENTRY LOGIC (THE GOLDEN SETUP) ---
        const buyingPower = usdtBalance * riskFactor * leverage;
        const contractsToTrade = Math.floor((buyingPower / ctx.currentPrice) / contractSize) * contractSize;

        if (contractsToTrade > 0 && !longPos && !shortPos) {
            
            // LONG: Bullish Trend + Strong ADX + Whale Volume + Positive OBI
            if (ctx.trend === 'BULLISH' && ctx.trendStrength > 25 && ctx.isVolumeConfirming && avgObi > obiThreshold && ctx.rsi < 65) {
                console.log(`>>> ELITE LONG SIGNAL CONFIRMED: Sniping ${contractsToTrade} units`);
                await mexc.createMarketBuyOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 1 });
                obiHistory = [];
            } 
            
            // SHORT: Bearish Trend + Strong ADX + Whale Volume + Negative OBI
            else if (ctx.trend === 'BEARISH' && ctx.trendStrength > 25 && ctx.isVolumeConfirming && avgObi < -obiThreshold && ctx.rsi > 35) {
                console.log(`>>> ELITE SHORT SIGNAL CONFIRMED: Sniping ${contractsToTrade} units`);
                await mexc.createMarketSellOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 2 });
                obiHistory = [];
            }
        }

    } catch (e) {
        console.error("Critical Loop Error:", e.message);
    } finally {
        isTrading = false;
    }
}

async function startBot() {
    try {
        const markets = await mexc.loadMarkets();
        contractSize = markets[symbol].contractSize;
        await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 1 }); 
        await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 2 }); 
        console.log(`ELITE SNIPER DEPLOYED: Listening for institutional patterns on ${symbol}...`);
        setInterval(runBot, 10000); 
    } catch (error) {
        console.error("STARTUP ERROR:", error.message);
    }
}

startBot();
