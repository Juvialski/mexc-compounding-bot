const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const { RSI, SMA, ATR, ADX, OBV, MACD, BollingerBands } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Elite Sniper V5: Self-Improving Swing Mode Active'));
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
let obiHistory =[];
let isTrading = false;
let peakPrice = 0; 

// ==========================================
// AI MEMORY & DATABASE SETUP (MONGOOSE)
// ==========================================
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅[DATABASE] AI Memory Connected Successfully!"))
    .catch(err => console.error("❌ [DATABASE ERROR]", err));

// Structure for Bot's DNA (Parameters)
const BotBrainSchema = new mongoose.Schema({
    trailMultiplier: { type: Number, default: 1.5 },
    stopMultiplier: { type: Number, default: 2.0 },
    minTrendStrength: { type: Number, default: 25 },
    rsiOverbought: { type: Number, default: 70 },
    rsiOversold: { type: Number, default: 30 }
});
const BotBrain = mongoose.model('BotBrain', BotBrainSchema);

// Structure for Trade History
const TradeSchema = new mongoose.Schema({
    side: String,
    entryPrice: Number,
    exitPrice: Number,
    pnlPercentage: Number,
    isWin: Boolean,
    timestamp: { type: Date, default: Date.now }
});
const Trade = mongoose.model('Trade', TradeSchema);

// Current Active Parameters
let activeBrain = {
    trailMultiplier: 1.5,
    stopMultiplier: 2.0,
    minTrendStrength: 25,
    rsiOverbought: 70,
    rsiOversold: 30
};

// Load Brain from Database on Startup
async function loadBotBrain() {
    try {
        let brain = await BotBrain.findOne();
        if (!brain) {
            console.log("🧠 [AI] No previous brain found. Creating new DNA...");
            brain = await BotBrain.create({});
        }
        activeBrain = brain;
        console.log("🧬[AI DNA LOADED]:", activeBrain);
    } catch (e) {
        console.error("Error loading brain:", e.message);
    }
}

// ==========================================
// CORE TRADING FUNCTIONS
// ==========================================
async function getMarketContext() {
    const[ohlcv1h, ohlcv15m] = await Promise.all([
        mexc.fetchOHLCV(symbol, '1h', undefined, 50),
        mexc.fetchOHLCV(symbol, '15m', undefined, 50)
    ]);
    
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

// ==========================================
// EVOLUTION LOGIC (SELF-IMPROVEMENT)
// ==========================================
async function processTradeExit(side, entryPrice, exitPrice) {
    try {
        let pnl = 0;
        if (side === 'LONG') {
            pnl = ((exitPrice - entryPrice) / entryPrice) * 100 * leverage;
        } else {
            pnl = ((entryPrice - exitPrice) / entryPrice) * 100 * leverage;
        }
        
        const isWin = pnl > 0;

        await Trade.create({ side, entryPrice, exitPrice, pnlPercentage: pnl, isWin });
        console.log(`💾 [MEMORY] Trade saved. Result: ${isWin ? 'WIN' : 'LOSS'} | PnL: ${pnl.toFixed(2)}%`);

        evolveBot();
    } catch (e) {
        console.error("Error saving trade:", e.message);
    }
}

async function evolveBot() {
    try {
        const recentTrades = await Trade.find().sort({ timestamp: -1 }).limit(10);
        if (recentTrades.length < 10) return; 

        const wins = recentTrades.filter(t => t.isWin).length;
        const winRate = wins / recentTrades.length;
        
        console.log(`🤖 [EVOLUTION] Analyzing last 10 trades. Win Rate: ${(winRate * 100).toFixed(0)}%`);

        let brain = await BotBrain.findOne();
        let changed = false;

        if (winRate < 0.40) {
            console.log(`📉 Win rate low. Tightening parameters to protect capital...`);
            brain.minTrendStrength = Math.min(brain.minTrendStrength + 2, 40); 
            brain.stopMultiplier = Math.max(brain.stopMultiplier - 0.2, 1.0);  
            brain.rsiOverbought = Math.min(brain.rsiOverbought + 2, 85);       
            brain.rsiOversold = Math.max(brain.rsiOversold - 2, 15);
            changed = true;
        } 
        else if (winRate >= 0.60) {
            console.log(`📈 Win rate high. Expanding parameters to maximize profits...`);
            brain.trailMultiplier = Math.min(brain.trailMultiplier + 0.1, 3.0); 
            changed = true;
        } 
        else {
            console.log(`⚖️ Win rate stable. Maintaining current DNA.`);
        }

        if (changed) {
            await brain.save();
            activeBrain = brain; 
            console.log(`🧬 [NEW DNA EVOLVED]:`, activeBrain);
        }
    } catch (e) {
        console.error("Evolution error:", e.message);
    }
}

// ==========================================
// MAIN BOT LOOP
// ==========================================
async function runBot() {
    if (isTrading) return; 
    isTrading = true;

    try {
        const openOrders = await mexc.fetchOpenOrders(symbol);
        
        if (openOrders.length > 0) {
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

        console.log(`[LOG] Price: ${ctx.currentPrice} | Brain: AI-ACTIVE | Trend ADX: ${ctx.swing.strength.toFixed(1)}`);

        const activeAtr = ctx.swing.atr; 
        const trailMult = activeBrain.trailMultiplier;
        const stopMult = activeBrain.stopMultiplier;

        // --- LONG POSITION MANAGEMENT ---
        if (longPos) {
            if (peakPrice === 0 || ctx.currentPrice > peakPrice) peakPrice = ctx.currentPrice;
            const entryPrice = parseFloat(longPos.entryPrice);

            let stopLoss = entryPrice - (activeAtr * stopMult);
            if (ctx.currentPrice > entryPrice + (activeAtr * trailMult)) stopLoss = Math.max(stopLoss, entryPrice);
            const trailingStop = peakPrice - (activeAtr * trailMult);
            stopLoss = Math.max(stopLoss, trailingStop);

            const isSwingExit = ctx.swing.rsi > activeBrain.rsiOverbought && ctx.swing.macd.histogram < 0;

            if (ctx.currentPrice < stopLoss || isSwingExit) {
                console.log(`>>> EXIT LONG (SWING). MARKET STOP TRIGGERED.`);
                await mexc.createMarketSellOrder(symbol, longPos.contracts, { 'reduceOnly': true });
                
                await processTradeExit('LONG', entryPrice, ctx.currentPrice);
                peakPrice = 0;
            }
        }

        // --- SHORT POSITION MANAGEMENT ---
        if (shortPos) {
            if (peakPrice === 0 || ctx.currentPrice < peakPrice) peakPrice = ctx.currentPrice;
            const entryPrice = parseFloat(shortPos.entryPrice);

            let stopLoss = entryPrice + (activeAtr * stopMult);
            if (ctx.currentPrice < entryPrice - (activeAtr * trailMult)) stopLoss = Math.min(stopLoss, entryPrice);
            const trailingStop = peakPrice + (activeAtr * trailMult);
            stopLoss = Math.min(stopLoss, trailingStop);

            const isSwingExit = ctx.swing.rsi < activeBrain.rsiOversold && ctx.swing.macd.histogram > 0;

            if (ctx.currentPrice > stopLoss || isSwingExit) {
                console.log(`>>> EXIT SHORT (SWING). MARKET STOP TRIGGERED.`);
                await mexc.createMarketBuyOrder(symbol, shortPos.contracts, { 'reduceOnly': true });
                
                await processTradeExit('SHORT', entryPrice, ctx.currentPrice);
                peakPrice = 0;
            }
        }

        // --- ENTRY LOGIC (USING AI DNA) ---
        const market = await mexc.market(symbol);
        const contractSize = market.contractSize; 
        const btcToTrade = (usdtBalance * riskFactor * leverage) / ctx.currentPrice;
        let contractsToTrade = Math.floor(btcToTrade / contractSize);

        if (contractsToTrade >= 1 && !longPos && !shortPos && usdtBalance > 5) {
            const isOverextendedLong = ctx.currentPrice >= ctx.swing.bb.upper;
            const isOverextendedShort = ctx.currentPrice <= ctx.swing.bb.lower;

            if (ctx.currentPrice > ctx.swing.bb.middle && ctx.swing.rsi > activeBrain.rsiOverbought && ctx.swing.macd.histogram < 0 && avgObi < 0) {
                console.log(`>>> SWING REVERSAL SHORT LIMIT: ${contractsToTrade} Contracts at ${bestAsk}`);
                await mexc.createLimitSellOrder(symbol, contractsToTrade, bestAsk, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                obiHistory =[]; peakPrice = ctx.currentPrice;
            }
            else if (ctx.currentPrice < ctx.swing.bb.middle && ctx.swing.rsi < activeBrain.rsiOversold && ctx.swing.macd.histogram > 0 && avgObi > 0) {
                console.log(`>>> SWING REVERSAL LONG LIMIT: ${contractsToTrade} Contracts at ${bestBid}`);
                await mexc.createLimitBuyOrder(symbol, contractsToTrade, bestBid, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                obiHistory =[]; peakPrice = ctx.currentPrice;
            }
            else if (ctx.swing.trend === 'BULLISH' && !isOverextendedLong && ctx.swing.macd.histogram > 0 && ctx.swing.strength > activeBrain.minTrendStrength && ctx.swing.volConfirm && avgObi > obiThreshold) {
                console.log(`>>> SWING TREND LONG LIMIT: ${contractsToTrade} Contracts at ${bestBid}`);
                await mexc.createLimitBuyOrder(symbol, contractsToTrade, bestBid, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                obiHistory =[]; peakPrice = ctx.currentPrice; 
            } 
            else if (ctx.swing.trend === 'BEARISH' && !isOverextendedShort && ctx.swing.macd.histogram < 0 && ctx.swing.strength > activeBrain.minTrendStrength && ctx.swing.volConfirm && avgObi < -obiThreshold) {
                console.log(`>>> SWING TREND SHORT LIMIT: ${contractsToTrade} Contracts at ${bestAsk}`);
                await mexc.createLimitSellOrder(symbol, contractsToTrade, bestAsk, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                obiHistory =[]; peakPrice = ctx.currentPrice;
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
        
        await loadBotBrain();

        console.log(`✅ SUCCESS: ELITE SNIPER V5 (AI SWING) ACTIVE ON ${symbol}`);
        setInterval(runBot, 5000); 
    } catch (error) {
        console.error("STARTUP ERROR:", error.message);
    }
}

startBot();
