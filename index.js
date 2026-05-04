const ccxt = require('ccxt');
const express = require('express');
const { RSI, SMA, ATR, ADX, OBV } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Elite Sniper: Full Power Mode Active'));
app.listen(port);

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' }
});

const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskFactor = 0.95; // Keeping 95% Full Power Mode per request
const obiThreshold = 0.20; // FIXED: Lowered for realistic crypto orderbooks
const historyLimit = 5;         
let obiHistory = [];
let isTrading = false;
let peakPrice = 0; 

async function getMarketContext() {
    // Fetching 50 candles to ensure indicators have enough data to calculate
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

        // IMPROVEMENT: Fetching deeper orderbook (50 levels) to avoid spoofing fakeouts
        const orderbook = await mexc.fetchOrderBook(symbol, 50);
        const sumBids = orderbook.bids.reduce((a, b) => a + b[1], 0);
        const sumAsks = orderbook.asks.reduce((a, b) => a + b[1], 0);
        const currentObi = (sumBids - sumAsks) / (sumBids + sumAsks);
        obiHistory.push(currentObi);
        if (obiHistory.length > historyLimit) obiHistory.shift();
        const avgObi = obiHistory.reduce((a, b) => a + b, 0) / obiHistory.length;

        console.log(`[LOG] Price: ${ctx.currentPrice} | Bal: $${usdtBalance.toFixed(2)} | RSI: ${ctx.rsi.toFixed(1)} | ATR: ${ctx.atr.toFixed(2)} | Pos: ${longPos ? 'LONG' : shortPos ? 'SHORT' : 'NONE'}`);

        // --- LONG POSITION MANAGEMENT ---
        if (longPos) {
            const entryPrice = parseFloat(longPos.entryPrice);
            if (peakPrice === 0 || ctx.currentPrice > peakPrice) peakPrice = ctx.currentPrice;

            // Base Stop Loss (2 ATR)
            let stopLoss = entryPrice - (ctx.atr * 2);
            
            // Move Stop Loss to Break-Even if profit exceeds 1.5 ATR
            if (ctx.currentPrice > entryPrice + (ctx.atr * 1.5)) stopLoss = Math.max(stopLoss, entryPrice);
            
            // IMPROVEMENT: Dynamic ATR Trailing Stop instead of fixed percentage
            const trailingStop = peakPrice - (ctx.atr * 1.5);
            stopLoss = Math.max(stopLoss, trailingStop);

            if (ctx.currentPrice < stopLoss || ctx.rsi > 85) {
                console.log(`>>> FULL EXIT LONG. Exit Price: ${ctx.currentPrice} | Final SL/Trailing: ${stopLoss.toFixed(2)}`);
                await mexc.createMarketSellOrder(symbol, longPos.contracts, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                peakPrice = 0;
            }
        }

        // --- SHORT POSITION MANAGEMENT ---
        if (shortPos) {
            const entryPrice = parseFloat(shortPos.entryPrice);
            if (peakPrice === 0 || ctx.currentPrice < peakPrice) peakPrice = ctx.currentPrice;

            // Base Stop Loss (2 ATR)
            let stopLoss = entryPrice + (ctx.atr * 2);
            
            // Move Stop Loss to Break-Even if profit exceeds 1.5 ATR
            if (ctx.currentPrice < entryPrice - (ctx.atr * 1.5)) stopLoss = Math.min(stopLoss, entryPrice);
            
            // IMPROVEMENT: Dynamic ATR Trailing Stop instead of fixed percentage
            const trailingStop = peakPrice + (ctx.atr * 1.5);
            stopLoss = Math.min(stopLoss, trailingStop);

            if (ctx.currentPrice > stopLoss || ctx.rsi < 15) {
                console.log(`>>> FULL EXIT SHORT. Exit Price: ${ctx.currentPrice} | Final SL/Trailing: ${stopLoss.toFixed(2)}`);
                await mexc.createMarketBuyOrder(symbol, shortPos.contracts, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                peakPrice = 0;
            }
        }

        // --- ENTRY LOGIC ---
        const market = await mexc.market(symbol);
        const contractSize = market.contractSize; 
        const btcToTrade = (usdtBalance * riskFactor * leverage) / ctx.currentPrice;
        let contractsToTrade = Math.floor(btcToTrade / contractSize);

        if (contractsToTrade >= 1 && !longPos && !shortPos && usdtBalance > 5) {
            // FIXED: Relaxed RSI to < 80 for longs, > 20 for shorts to catch momentum
            if (ctx.trend === 'BULLISH' && ctx.trendStrength > 25 && ctx.isVolumeConfirming && avgObi > obiThreshold && ctx.rsi < 80) {
                console.log(`>>> FULL POWER LONG: ${contractsToTrade} Contracts`);
                await mexc.createMarketBuyOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                obiHistory = [];
                peakPrice = ctx.currentPrice; 
            } 
            else if (ctx.trend === 'BEARISH' && ctx.trendStrength > 25 && ctx.isVolumeConfirming && avgObi < -obiThreshold && ctx.rsi > 20) {
                console.log(`>>> FULL POWER SHORT: ${contractsToTrade} Contracts`);
                await mexc.createMarketSellOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                obiHistory = [];
                peakPrice = ctx.currentPrice;
            }
        }
    } catch (e) {
        console.error("Loop Error:", e.message);
    } finally {
        isTrading = false;
    }
}

async function startBot() {
    try {
        await mexc.loadMarkets();
        try { 
            // Set leverage for both Long and Short sides
            await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 1 }); 
            await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 2 }); 
        } catch (e) {
            // Usually throws if leverage is already set, safe to ignore
        }
        console.log(`SUCCESS: ELITE SNIPER (95% RISK) ACTIVE ON ${symbol}`);
        
        // IMPROVEMENT: Increased to 30 seconds to avoid MEXC rate-limiting/banning
        setInterval(runBot, 30000); 
    } catch (error) {
        console.error("STARTUP ERROR:", error.message);
    }
}

startBot();
