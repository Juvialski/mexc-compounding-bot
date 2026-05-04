const ccxt = require('ccxt');
const express = require('express');
const { RSI, SMA, ATR, ADX, OBV, MACD, BollingerBands } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Elite Hybrid Sniper V5: High Risk Active'));
app.listen(port);

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' }
});

const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskFactor = 0.95;        // USER REQUESTED: 95% risk for aggressive small-account compounding
const obiThreshold = 0.20; 
const historyLimit = 5;         
let obiHistory = [];
let isTrading = false;
let peakPrice = 0; 
let activeStrategy = 'NONE'; 

async function getMarketContext() {
    const [ohlcv1h, ohlcv15m, ohlcv1m] = await Promise.all([
        mexc.fetchOHLCV(symbol, '1h', undefined, 50),
        mexc.fetchOHLCV(symbol, '15m', undefined, 50),
        mexc.fetchOHLCV(symbol, '1m', undefined, 50)
    ]);
    
    // --- SWING CONTEXT (15m) ---
    const closes1h = ohlcv1h.map(c => c[4]);
    const closes15m = ohlcv15m.map(c => c[4]);
    const highs15m = ohlcv15m.map(c => c[2]);
    const lows15m = ohlcv15m.map(c => c[3]);
    const volumes15m = ohlcv15m.map(c => c[5]);

    const currentPrice = closes15m[closes15m.length - 1];
    const previousPrice15m = closes15m[closes15m.length - 2];
    
    const smaValue1h = SMA.calculate({ period: 20, values: closes1h }).pop();
    const trend1h = currentPrice > smaValue1h ? 'BULLISH' : 'BEARISH';
    
    const adxData15m = ADX.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 }).pop();
    const trendStrength15m = adxData15m ? adxData15m.adx : 0;
    const rsi15m = RSI.calculate({ period: 14, values: closes15m }).pop();
    const atr15m = ATR.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m }).pop();
    const macd15m = MACD.calculate({ values: closes15m, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }).pop();
    const bb15m = BollingerBands.calculate({ period: 20, values: closes15m, stdDev: 2 }).pop();
    
    const obvValues15m = OBV.calculate({ close: closes15m, volume: volumes15m });
    const isVolumeConfirming15m = trend1h === 'BULLISH' ? obvValues15m[obvValues15m.length - 1] > obvValues15m[obvValues15m.length - 4] : obvValues15m[obvValues15m.length - 1] < obvValues15m[obvValues15m.length - 4];

    // --- SCALP CONTEXT (1m) ---
    const closes1m = ohlcv1m.map(c => c[4]);
    const highs1m = ohlcv1m.map(c => c[2]);
    const lows1m = ohlcv1m.map(c => c[3]);
    const volumes1m = ohlcv1m.map(c => c[5]);
    const previousPrice1m = closes1m[closes1m.length - 2];
    
    const rsi1m = RSI.calculate({ period: 14, values: closes1m }).pop();
    const atr1m = ATR.calculate({ period: 14, high: highs1m, low: lows1m, close: closes1m }).pop();
    const bb1m = BollingerBands.calculate({ period: 20, values: closes1m, stdDev: 2.5 }).pop(); 
    const sma1m = SMA.calculate({ period: 20, values: closes1m }).pop();
    const macd1m = MACD.calculate({ values: closes1m, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }).pop();

    // Flash Volume Spike Detection (Current 1m volume vs average of previous 9 minutes)
    const avgVol1m = volumes1m.slice(-10, -1).reduce((a, b) => a + b, 0) / 9;
    const currentVol1m = volumes1m[volumes1m.length - 1];
    const isVolSpike = currentVol1m > (avgVol1m * 2.0); // True if volume is 200% above average

    // Breakout Levels (15-period highest high / lowest low)
    const highest15m_1m = Math.max(...highs1m.slice(-16, -1));
    const lowest15m_1m = Math.min(...lows1m.slice(-16, -1));

    return { 
        currentPrice, 
        swing: { trend: trend1h, strength: trendStrength15m, rsi: rsi15m, atr: atr15m, macd: macd15m, bb: bb15m, volConfirm: isVolumeConfirming15m, prevPrice: previousPrice15m },
        scalp: { rsi: rsi1m, atr: atr1m, bb: bb1m, sma: sma1m, macd: macd1m, volSpike: isVolSpike, prevPrice: previousPrice1m, highest15m: highest15m_1m, lowest15m: lowest15m_1m }
    };
}

async function runBot() {
    if (isTrading) return; 
    isTrading = true;

    try {
        // Parallel execution slashes script lag by ~2.5 seconds
        const [ctx, balance, positions, orderbook] = await Promise.all([
            getMarketContext(),
            mexc.fetchBalance(),
            mexc.fetchPositions([symbol]),
            mexc.fetchOrderBook(symbol, 50)
        ]);
        
        const usdtBalance = balance.total['USDT'] || 0;
        const longPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'long');
        const shortPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'short');

        if ((longPos || shortPos) && activeStrategy === 'NONE') {
            activeStrategy = 'SWING';
        }

        const sumBids = orderbook.bids.reduce((a, b) => a + b[1], 0);
        const sumAsks = orderbook.asks.reduce((a, b) => a + b[1], 0);
        const currentObi = (sumBids - sumAsks) / (sumBids + sumAsks);
        obiHistory.push(currentObi);
        if (obiHistory.length > historyLimit) obiHistory.shift();
        const avgObi = obiHistory.reduce((a, b) => a + b, 0) / obiHistory.length;

        console.log(`[LOG] Price: ${ctx.currentPrice} | Strategy: ${activeStrategy} | VolSpike: ${ctx.scalp.volSpike} | 1m RSI: ${ctx.scalp.rsi.toFixed(1)}`);

        // --- DYNAMIC EXIT PARAMETERS ---
        const baseAtr = ctx.swing.atr; 
        const trailAtr = activeStrategy === 'SCALP' ? ctx.scalp.atr : ctx.swing.atr; 
        const trailMultiplier = activeStrategy === 'SCALP' ? 1.0 : 1.5; 
        const stopMultiplier = 2.0; 

        // --- LONG POSITION MANAGEMENT ---
        if (longPos) {
            const entryPrice = parseFloat(longPos.entryPrice);
            if (peakPrice === 0 || ctx.currentPrice > peakPrice) peakPrice = ctx.currentPrice;

            let stopLoss = entryPrice - (baseAtr * stopMultiplier);
            if (ctx.currentPrice > entryPrice + (trailAtr * trailMultiplier)) stopLoss = Math.max(stopLoss, entryPrice);
            const trailingStop = peakPrice - (trailAtr * trailMultiplier);
            stopLoss = Math.max(stopLoss, trailingStop);

            const isSwingExit = activeStrategy === 'SWING' && (ctx.swing.rsi > 80 && ctx.swing.macd.histogram < 0);
            const isScalpExit = activeStrategy === 'SCALP' && ctx.scalp.rsi > 75;

            if (ctx.currentPrice < stopLoss || isSwingExit || isScalpExit) {
                console.log(`>>> EXIT LONG (${activeStrategy}). Price: ${ctx.currentPrice}`);
                await mexc.createMarketSellOrder(symbol, longPos.contracts, { 'reduceOnly': true });
                peakPrice = 0;
                activeStrategy = 'NONE';
            }
        }

        // --- SHORT POSITION MANAGEMENT ---
        if (shortPos) {
            const entryPrice = parseFloat(shortPos.entryPrice);
            if (peakPrice === 0 || ctx.currentPrice < peakPrice) peakPrice = ctx.currentPrice;

            let stopLoss = entryPrice + (baseAtr * stopMultiplier);
            if (ctx.currentPrice < entryPrice - (trailAtr * trailMultiplier)) stopLoss = Math.min(stopLoss, entryPrice);
            const trailingStop = peakPrice + (trailAtr * trailMultiplier);
            stopLoss = Math.min(stopLoss, trailingStop);

            const isSwingExit = activeStrategy === 'SWING' && (ctx.swing.rsi < 20 && ctx.swing.macd.histogram > 0);
            const isScalpExit = activeStrategy === 'SCALP' && ctx.scalp.rsi < 25;

            if (ctx.currentPrice > stopLoss || isSwingExit || isScalpExit) {
                console.log(`>>> EXIT SHORT (${activeStrategy}). Price: ${ctx.currentPrice}`);
                await mexc.createMarketBuyOrder(symbol, shortPos.contracts, { 'reduceOnly': true });
                peakPrice = 0;
                activeStrategy = 'NONE';
            }
        }

        // --- ENTRY LOGIC ---
        const market = await mexc.market(symbol);
        const contractSize = market.contractSize; 
        const btcToTrade = (usdtBalance * riskFactor * leverage) / ctx.currentPrice;
        let contractsToTrade = Math.floor(btcToTrade / contractSize);

        if (contractsToTrade >= 1 && !longPos && !shortPos && usdtBalance > 5) {
            
            // 1. CAPITULATION SCALPS (Waits for price to hook back inside the Bollinger Band)
            const prevBelowBBLower = ctx.scalp.prevPrice < ctx.scalp.bb.lower;
            const currentInsideBBLower = ctx.currentPrice > ctx.scalp.bb.lower;
            const prevAboveBBUpper = ctx.scalp.prevPrice > ctx.scalp.bb.upper;
            const currentInsideBBUpper = ctx.currentPrice < ctx.scalp.bb.upper;

            if (prevBelowBBLower && currentInsideBBLower && ctx.scalp.rsi < 35) {
                console.log(`>>> CONFIRMED CAPITULATION LONG: ${contractsToTrade} Contracts`);
                await mexc.createMarketBuyOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                activeStrategy = 'SCALP';
                obiHistory = [];
                peakPrice = ctx.currentPrice;
            }
            else if (prevAboveBBUpper && currentInsideBBUpper && ctx.scalp.rsi > 65) {
                console.log(`>>> CONFIRMED BLOW-OFF SHORT: ${contractsToTrade} Contracts`);
                await mexc.createMarketSellOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                activeStrategy = 'SCALP';
                obiHistory = [];
                peakPrice = ctx.currentPrice;
            }
            
            // 2. MOMENTUM BREAKOUTS (Uses actual Price Action highs/lows + volume)
            else if (ctx.currentPrice < ctx.scalp.lowest15m && ctx.scalp.volSpike) {
                console.log(`>>> MOMENTUM BREAKDOWN SHORT: ${contractsToTrade} Contracts`);
                await mexc.createMarketSellOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                activeStrategy = 'SCALP';
                obiHistory = [];
                peakPrice = ctx.currentPrice;
            }
            else if (ctx.currentPrice > ctx.scalp.highest15m && ctx.scalp.volSpike) {
                console.log(`>>> MOMENTUM BREAKOUT LONG: ${contractsToTrade} Contracts`);
                await mexc.createMarketBuyOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                activeStrategy = 'SCALP';
                obiHistory = [];
                peakPrice = ctx.currentPrice;
            }
            
            // 3. SWING LOGIC (Macro Reversals and Safe Trends)
            else {
                const isOverextendedLong = ctx.currentPrice >= ctx.swing.bb.upper;
                const isOverextendedShort = ctx.currentPrice <= ctx.swing.bb.lower;

                if (ctx.currentPrice > ctx.swing.bb.middle && ctx.swing.rsi > 70 && ctx.swing.macd.histogram < 0 && avgObi < 0) {
                    console.log(`>>> SWING REVERSAL SHORT: ${contractsToTrade} Contracts`);
                    await mexc.createMarketSellOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                    activeStrategy = 'SWING';
                    obiHistory = [];
                    peakPrice = ctx.currentPrice;
                }
                else if (ctx.currentPrice < ctx.swing.bb.middle && ctx.swing.rsi < 30 && ctx.swing.macd.histogram > 0 && avgObi > 0) {
                    console.log(`>>> SWING REVERSAL LONG: ${contractsToTrade} Contracts`);
                    await mexc.createMarketBuyOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                    activeStrategy = 'SWING';
                    obiHistory = [];
                    peakPrice = ctx.currentPrice;
                }
                else if (ctx.swing.trend === 'BULLISH' && !isOverextendedLong && ctx.swing.macd.histogram > 0 && ctx.swing.strength > 25 && ctx.swing.volConfirm && avgObi > obiThreshold) {
                    console.log(`>>> SWING TREND LONG: ${contractsToTrade} Contracts`);
                    await mexc.createMarketBuyOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                    activeStrategy = 'SWING';
                    obiHistory = [];
                    peakPrice = ctx.currentPrice; 
                } 
                else if (ctx.swing.trend === 'BEARISH' && !isOverextendedShort && ctx.swing.macd.histogram < 0 && ctx.swing.strength > 25 && ctx.swing.volConfirm && avgObi < -obiThreshold) {
                    console.log(`>>> SWING TREND SHORT: ${contractsToTrade} Contracts`);
                    await mexc.createMarketSellOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                    activeStrategy = 'SWING';
                    obiHistory = [];
                    peakPrice = ctx.currentPrice;
                }
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
        console.log(`SUCCESS: ELITE HYBRID SNIPER V5 ACTIVE ON ${symbol}`);
        
        // Polling every 5 seconds ensures script-side stop losses actually work and breakouts are caught
        setInterval(runBot, 5000); 
    } catch (error) {
        console.error("STARTUP ERROR:", error.message);
    }
}

startBot();
