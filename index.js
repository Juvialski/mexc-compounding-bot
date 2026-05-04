const ccxt = require('ccxt');
const express = require('express');
const { RSI, SMA, ATR, ADX, OBV, MACD, BollingerBands } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Elite Sniper V5: Pure Swing Mode Active'));
app.listen(port);

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' },
    enableRateLimit: true 
});

const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskFactor = 0.95; 
const obiThreshold = 0.20; 
const historyLimit = 5;         
let obiHistory = [];
let isTrading = false;
let peakPrice = 0; 

async function getMarketContext() {
    // Only fetching 1h and 15m now. 1m scalp data is completely removed.
    const [ohlcv1h, ohlcv15m] = await Promise.all([
        mexc.fetchOHLCV(symbol, '1h', undefined, 50),
        mexc.fetchOHLCV(symbol, '15m', undefined, 50)
    ]);
    
    // --- SWING CONTEXT (15m) ---
    const closes1h = ohlcv1h.map(c => c[4]);
    const closes15m = ohlcv15m.map(c => c[4]);
    const highs15m = ohlcv15m.map(c => c[2]);
    const lows15m = ohlcv15m.map(c => c[3]);
    const volumes15m = ohlcv15m.map(c => c[5]);

    const smaValue1h = SMA.calculate({ period: 20, values: closes1h }).pop();
    const currentPrice = closes15m[closes15m.length - 1];
    const trend1h = currentPrice > smaValue1h ? 'BULLISH' : 'BEARISH';
    
    const adxData15m = ADX.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 }).pop();
    const trendStrength15m = adxData15m ? adxData15m.adx : 0;
    const rsi15m = RSI.calculate({ period: 14, values: closes15m }).pop();
    const atr15m = ATR.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m }).pop();
    const macd15m = MACD.calculate({ values: closes15m, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }).pop();
    const bb15m = BollingerBands.calculate({ period: 20, values: closes15m, stdDev: 2 }).pop();
    
    const obvValues15m = OBV.calculate({ close: closes15m, volume: volumes15m });
    const isVolumeConfirming15m = trend1h === 'BULLISH' ? obvValues15m[obvValues15m.length - 1] > obvValues15m[obvValues15m.length - 4] : obvValues15m[obvValues15m.length - 1] < obvValues15m[obvValues15m.length - 4];

    return { 
        currentPrice, 
        swing: { trend: trend1h, strength: trendStrength15m, rsi: rsi15m, atr: atr15m, macd: macd15m, bb: bb15m, volConfirm: isVolumeConfirming15m }
    };
}

async function runBot() {
    if (isTrading) return; 
    isTrading = true;

    try {
        const openOrders = await mexc.fetchOpenOrders(symbol);
        
        // --- LIMIT ORDER SAFETY NET ---
        if (openOrders.length > 0) {
            console.log(`[LOG] Unfilled Limit Orders detected. Canceling to refresh state...`);
            for (let order of openOrders) {
                try { await mexc.cancelOrder(order.id, symbol); } catch(e) {}
            }
            return; 
        }

        const ctx = await getMarketContext();
        const balance = await mexc.fetchBalance();
        const usdtBalance = balance.total['USDT'] || 0;

        const positions = await mexc.fetchPositions([symbol]);
        const longPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'long');
        const shortPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'short');

        const orderbook = await mexc.fetchOrderBook(symbol, 50);
        const bestBid = orderbook.bids[0][0]; 
        const bestAsk = orderbook.asks[0][0]; 
        
        const sumBids = orderbook.bids.reduce((a, b) => a + b[1], 0);
        const sumAsks = orderbook.asks.reduce((a, b) => a + b[1], 0);
        const currentObi = (sumBids - sumAsks) / (sumBids + sumAsks);
        obiHistory.push(currentObi);
        if (obiHistory.length > historyLimit) obiHistory.shift();
        const avgObi = obiHistory.reduce((a, b) => a + b, 0) / obiHistory.length;

        console.log(`[LOG] Price: ${ctx.currentPrice} | Mode: PURE SWING | Bid: ${bestBid} | Ask: ${bestAsk}`);

        // --- PURE SWING EXIT PARAMETERS ---
        const activeAtr = ctx.swing.atr; 
        const trailMultiplier = 1.5; // Generous trailing room
        const stopMultiplier = 2.0;  // Hard stop

        // --- LONG POSITION MANAGEMENT ---
        if (longPos) {
            if (peakPrice === 0 || ctx.currentPrice > peakPrice) peakPrice = ctx.currentPrice;
            const entryPrice = parseFloat(longPos.entryPrice);

            let stopLoss = entryPrice - (activeAtr * stopMultiplier);
            
            if (ctx.currentPrice > entryPrice + (activeAtr * trailMultiplier)) stopLoss = Math.max(stopLoss, entryPrice);
            const trailingStop = peakPrice - (activeAtr * trailMultiplier);
            stopLoss = Math.max(stopLoss, trailingStop);

            const isSwingExit = ctx.swing.rsi > 80 && ctx.swing.macd.histogram < 0;

            if (ctx.currentPrice < stopLoss || isSwingExit) {
                console.log(`>>> EXIT LONG (SWING). MARKET STOP TRIGGERED. Price: ${ctx.currentPrice}`);
                await mexc.createMarketSellOrder(symbol, longPos.contracts, { 'reduceOnly': true });
                peakPrice = 0;
            }
        }

        // --- SHORT POSITION MANAGEMENT ---
        if (shortPos) {
            if (peakPrice === 0 || ctx.currentPrice < peakPrice) peakPrice = ctx.currentPrice;
            const entryPrice = parseFloat(shortPos.entryPrice);

            let stopLoss = entryPrice + (activeAtr * stopMultiplier);
            
            if (ctx.currentPrice < entryPrice - (activeAtr * trailMultiplier)) stopLoss = Math.min(stopLoss, entryPrice);
            const trailingStop = peakPrice + (activeAtr * trailMultiplier);
            stopLoss = Math.min(stopLoss, trailingStop);

            const isSwingExit = ctx.swing.rsi < 20 && ctx.swing.macd.histogram > 0;

            if (ctx.currentPrice > stopLoss || isSwingExit) {
                console.log(`>>> EXIT SHORT (SWING). MARKET STOP TRIGGERED. Price: ${ctx.currentPrice}`);
                await mexc.createMarketBuyOrder(symbol, shortPos.contracts, { 'reduceOnly': true });
                peakPrice = 0;
            }
        }

        // --- ENTRY LOGIC (PURE SWING ONLY) ---
        const market = await mexc.market(symbol);
        const contractSize = market.contractSize; 
        const btcToTrade = (usdtBalance * riskFactor * leverage) / ctx.currentPrice;
        let contractsToTrade = Math.floor(btcToTrade / contractSize);

        if (contractsToTrade >= 1 && !longPos && !shortPos && usdtBalance > 5) {
            
            const isOverextendedLong = ctx.currentPrice >= ctx.swing.bb.upper;
            const isOverextendedShort = ctx.currentPrice <= ctx.swing.bb.lower;

            if (ctx.currentPrice > ctx.swing.bb.middle && ctx.swing.rsi > 70 && ctx.swing.macd.histogram < 0 && avgObi < 0) {
                console.log(`>>> SWING REVERSAL SHORT LIMIT: ${contractsToTrade} Contracts at ${bestAsk}`);
                await mexc.createLimitSellOrder(symbol, contractsToTrade, bestAsk, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                obiHistory = [];
                peakPrice = ctx.currentPrice;
            }
            else if (ctx.currentPrice < ctx.swing.bb.middle && ctx.swing.rsi < 30 && ctx.swing.macd.histogram > 0 && avgObi > 0) {
                console.log(`>>> SWING REVERSAL LONG LIMIT: ${contractsToTrade} Contracts at ${bestBid}`);
                await mexc.createLimitBuyOrder(symbol, contractsToTrade, bestBid, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                obiHistory = [];
                peakPrice = ctx.currentPrice;
            }
            else if (ctx.swing.trend === 'BULLISH' && !isOverextendedLong && ctx.swing.macd.histogram > 0 && ctx.swing.strength > 25 && ctx.swing.volConfirm && avgObi > obiThreshold) {
                console.log(`>>> SWING TREND LONG LIMIT: ${contractsToTrade} Contracts at ${bestBid}`);
                await mexc.createLimitBuyOrder(symbol, contractsToTrade, bestBid, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                obiHistory = [];
                peakPrice = ctx.currentPrice; 
            } 
            else if (ctx.swing.trend === 'BEARISH' && !isOverextendedShort && ctx.swing.macd.histogram < 0 && ctx.swing.strength > 25 && ctx.swing.volConfirm && avgObi < -obiThreshold) {
                console.log(`>>> SWING TREND SHORT LIMIT: ${contractsToTrade} Contracts at ${bestAsk}`);
                await mexc.createLimitSellOrder(symbol, contractsToTrade, bestAsk, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
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
            await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 1 }); 
            await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 2 }); 
        } catch (e) {}
        console.log(`SUCCESS: ELITE SNIPER V5 (PURE SWING) ACTIVE ON ${symbol}`);
        
        // Polling every 5s purely for fast Limit entry detection. No scalping allowed.
        setInterval(runBot, 5000); 
    } catch (error) {
        console.error("STARTUP ERROR:", error.message);
    }
}

startBot();
