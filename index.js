const ccxt = require('ccxt');
const express = require('express');
const { RSI, SMA, ATR, ADX, OBV } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Elite Sniper: Integer Precision Fixed'));
app.listen(port);

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' }
});

const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskFactor = 0.20; // 20% of balance per trade ($10 for a $50 account)
const obiThreshold = 0.70; 
const historyLimit = 5;       
let obiHistory = [];
let isTrading = false;

async function getMarketContext() {
    const ohlcv1h = await mexc.fetchOHLCV(symbol, '1h', undefined, 50);
    const ohlcv15m = await mexc.fetchOHLCV(symbol, '15m', undefined, 50);
    const closes1h = ohlcv1h.map(c => c[4]);
    const closes15m = ohlcv15m.map(c => c[4]);
    const highs15m = ohlcv15m.map(c => c[2]);
    const lows15m = ohlcv15m.map(c => c[3]);
    const volumes15m = ohlcv15m.map(c => c[5]);

    const smaValue = SMA.calculate({ period: 20, values: closes1h }).pop();
    const currentPrice = closes15m[closes15m.length - 1];
    const trend = currentPrice > smaValue ? 'BULLISH' : 'BEARISH';
    const adxData = ADX.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 }).pop();
    const trendStrength = adxData ? adxData.adx : 0;
    const rsiValue = RSI.calculate({ period: 14, values: closes15m }).pop();
    const obvValues = OBV.calculate({ close: closes15m, volume: volumes15m });
    const currentObv = obvValues[obvValues.length - 1];
    const prevObv = obvValues[obvValues.length - 4];
    const isVolumeConfirming = trend === 'BULLISH' ? currentObv > prevObv : currentObv < prevObv;
    const atrValue = ATR.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m }).pop();

    return { trend, trendStrength, rsi: rsiValue, atr: atrValue, isVolumeConfirming, currentPrice };
}

async function runBot() {
    if (isTrading) return; 
    isTrading = true;

    try {
        const ctx = await getMarketContext();
        const balance = await mexc.fetchBalance();
        const usdtBalance = balance.total['USDT'] || 0;

        const positions = await mexc.fetchPositions([symbol]);
        const longPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'long');
        const shortPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'short');

        const orderbook = await mexc.fetchOrderBook(symbol, 10);
        const currentObi = (orderbook.bids.reduce((a, b) => a + b[1], 0) - orderbook.asks.reduce((a, b) => a + b[1], 0)) / (orderbook.bids.reduce((a, b) => a + b[1], 0) + orderbook.asks.reduce((a, b) => a + b[1], 0));
        obiHistory.push(currentObi);
        if (obiHistory.length > historyLimit) obiHistory.shift();
        const avgObi = obiHistory.reduce((a, b) => a + b, 0) / obiHistory.length;

        console.log(`[LOG] Bal: $${usdtBalance.toFixed(2)} | Price: ${ctx.currentPrice} | ADX: ${ctx.trendStrength.toFixed(1)} | OBV: ${ctx.isVolumeConfirming} | OBI: ${avgObi.toFixed(2)}`);

        // --- EXIT LOGIC ---
        if (longPos) {
            if (ctx.currentPrice < (ctx.currentPrice - (ctx.atr * 1.8)) || ctx.rsi > 85) {
                console.log(">>> CLOSING LONG");
                await mexc.createMarketSellOrder(symbol, longPos.contracts, { 'params': { 'openType': 1, 'positionType': 1 } });
            }
        }
        if (shortPos) {
            if (ctx.currentPrice > (ctx.currentPrice + (ctx.atr * 1.8)) || ctx.rsi < 15) {
                console.log(">>> CLOSING SHORT");
                await mexc.createMarketBuyOrder(symbol, shortPos.contracts, { 'params': { 'openType': 1, 'positionType': 2 } });
            }
        }

        // --- FIXED CONTRACT CALCULATION ---
        const market = mexc.market(symbol);
        const contractSize = market.contractSize; // Usually 0.0001 for BTC
        
        // Calculate how many BTC units we want
        const btcToTrade = (usdtBalance * riskFactor * leverage) / ctx.currentPrice;
        
        // Convert BTC units into WHOLE contracts
        // Formula: Contracts = BTC_Amount / Contract_Size
        let contractsToTrade = Math.floor(btcToTrade / contractSize);

        // Ensure we trade at least 1 contract if we have enough money
        if (contractsToTrade < 1 && usdtBalance > 10) contractsToTrade = 1;

        if (contractsToTrade >= 1 && !longPos && !shortPos) {
            const params = { 'openType': 1 };
            
            if (ctx.trend === 'BULLISH' && ctx.trendStrength > 25 && ctx.isVolumeConfirming && avgObi > obiThreshold && ctx.rsi < 65) {
                console.log(`>>> SNIPING LONG: ${contractsToTrade} Contracts`);
                params['positionType'] = 1;
                await mexc.createMarketBuyOrder(symbol, contractsToTrade, params);
                obiHistory = [];
            } 
            else if (ctx.trend === 'BEARISH' && ctx.trendStrength > 25 && ctx.isVolumeConfirming && avgObi < -obiThreshold && ctx.rsi > 35) {
                console.log(`>>> SNIPING SHORT: ${contractsToTrade} Contracts`);
                params['positionType'] = 2;
                await mexc.createMarketSellOrder(symbol, contractsToTrade, params);
                obiHistory = [];
            }
        }

    } catch (e) {
        console.error("Order Error:", e.message);
    } finally {
        isTrading = false;
    }
}

async function startBot() {
    try {
        await mexc.loadMarkets();
        try { await mexc.setLeverage(leverage, symbol); } catch (e) {}
        console.log(`FIXED ELITE SNIPER: Trading in Whole Contracts on ${symbol}`);
        setInterval(runBot, 10000); 
    } catch (error) {
        console.error("STARTUP ERROR:", error.message);
    }
}

startBot();
