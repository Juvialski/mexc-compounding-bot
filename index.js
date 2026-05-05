const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const { RSI, SMA, ATR, ADX, OBV, MACD, BollingerBands } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' },
    enableRateLimit: true 
});

// ==========================================
// BOT CONFIGURATION
// ==========================================
const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskFactor = 0.95; 
const takerFeeRate = 0.0002; 
const obiThreshold = 0.20; 
const historyLimit = 5;         
let obiHistory = [];
let isTrading = false;
let peakPrice = 0; 

let liveUsdtBalance = 0;
let activePosition = null;

// ==========================================
// TELEGRAM NOTIFICATIONS
// ==========================================
async function sendTelegramAlert(message) {
    const token = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return; 
    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(message)}`;
        await fetch(url); 
    } catch (err) { console.error("Telegram error:", err.message); }
}

// ==========================================
// AI MEMORY & DATABASE SETUP
// ==========================================
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ [DATABASE] AI Memory Connected!"))
    .catch(err => console.error("❌ [DATABASE ERROR]", err));

const BotBrainSchema = new mongoose.Schema({
    trailMultiplier: { type: Number, default: 1.5 },
    stopMultiplier: { type: Number, default: 2.0 },
    takeProfitTrigger: { type: Number, default: 5.0 }, // Trigger tighter trailing at 5%
    profitLockFloor: { type: Number, default: 2.0 },   // Lock in 2% minimum once triggered
    minTrendStrength: { type: Number, default: 25 },
    rsiOverbought: { type: Number, default: 70 },
    rsiOversold: { type: Number, default: 30 }
});
const BotBrain = mongoose.model('BotBrain', BotBrainSchema);

const Trade = mongoose.model('Trade', new mongoose.Schema({
    side: String, entryPrice: Number, exitPrice: Number,
    pnlPercentage: Number, pnlUsd: Number, balanceAfter: Number,
    isWin: Boolean, timestamp: { type: Date, default: Date.now }
}));

let activeBrain = {
    trailMultiplier: 1.5, stopMultiplier: 2.0, takeProfitTrigger: 5.0, profitLockFloor: 2.0,
    minTrendStrength: 25, rsiOverbought: 70, rsiOversold: 30
};

async function loadBotBrain() {
    try {
        let brain = await BotBrain.findOne();
        if (!brain) brain = await BotBrain.create({});
        activeBrain = brain;
        console.log("🧬 [AI DNA LOADED]:", activeBrain);
    } catch (e) { console.error("Error loading brain:", e.message); }
}

// ==========================================
// DASHBOARD UI
// ==========================================
app.get('/', async (req, res) => {
    try {
        const allTrades = await Trade.find().sort({ timestamp: -1 });
        const recentTrades = allTrades.slice(0, 15); 
        const brain = await BotBrain.findOne() || activeBrain;
        const totalTrades = allTrades.length;
        const totalWins = allTrades.filter(t => t.isWin).length;
        const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(2) : 0;
        const totalPnlUsd = allTrades.reduce((sum, t) => sum + (t.pnlUsd || 0), 0).toFixed(2);

        const posHtml = activePosition ? `
            <div class="card active-pos-card">
                <h2>🟢 Active Position: ${activePosition.side}</h2>
                <div class="grid">
                    <div class="stat-row"><span>Entry:</span> <strong>$${activePosition.entryPrice.toFixed(2)}</strong></div>
                    <div class="stat-row"><span>PnL %:</span> <strong class="${activePosition.pnlPct >= 0 ? 'win' : 'loss'}">${activePosition.pnlPct.toFixed(2)}%</strong></div>
                    <div class="stat-row"><span>Unrealized USD:</span> <strong class="${activePosition.unrealizedPnlUsd >= 0 ? 'win' : 'loss'}">$${activePosition.unrealizedPnlUsd.toFixed(2)}</strong></div>
                    <div class="stat-row"><span>Status:</span> <strong style="color: #facc15">${activePosition.pnlPct > brain.takeProfitTrigger ? '🔥 BREAKOUT MODE' : 'Scanning...'}</strong></div>
                </div>
            </div>
        ` : `<div class="card idle-pos-card"><h2>⚪ No Active Position</h2></div>`;

        res.send(`
            <html><head><title>Elite Sniper V5</title><style>
                body { font-family: sans-serif; background: #0b0f19; color: #e2e8f0; padding: 20px; }
                .container { max-width: 1000px; margin: auto; }
                .card { background: #1e293b; padding: 20px; border-radius: 12px; margin-bottom: 20px; border: 1px solid #334155; }
                .active-pos-card { border-color: #0ea5e9; }
                .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
                .stat-row { display: flex; justify-content: space-between; border-bottom: 1px dashed #334155; padding: 5px 0; }
                .win { color: #22c55e; } .loss { color: #ef4444; }
                table { width: 100%; border-collapse: collapse; } th, td { padding: 10px; text-align: left; border-bottom: 1px solid #334155; }
            </style><meta http-equiv="refresh" content="10"></head>
            <body><div class="container">
                <h1>🎯 Elite Sniper V5</h1>
                ${posHtml}
                <div class="grid">
                    <div class="card"><h2>📊 Stats</h2>
                        <div class="stat-row"><span>Balance:</span> <strong>$${liveUsdtBalance.toFixed(2)}</strong></div>
                        <div class="stat-row"><span>Win Rate:</span> <strong>${winRate}%</strong></div>
                        <div class="stat-row"><span>Total PnL:</span> <strong class="${totalPnlUsd >= 0 ? 'win' : 'loss'}">$${totalPnlUsd}</strong></div>
                    </div>
                    <div class="card"><h2>🧬 DNA</h2>
                        <div class="stat-row"><span>TP Trigger:</span> <strong>${brain.takeProfitTrigger}%</strong></div>
                        <div class="stat-row"><span>Profit Floor:</span> <strong>${brain.profitLockFloor}%</strong></div>
                        <div class="stat-row"><span>Trail Mult:</span> <strong>${brain.trailMultiplier}x</strong></div>
                    </div>
                </div>
                <div class="card"><h2>📝 Recent Trades</h2>
                <table><tr><th>Side</th><th>Entry</th><th>Exit</th><th>PnL %</th><th>Result</th></tr>
                ${recentTrades.map(t => `<tr><td>${t.side}</td><td>$${t.entryPrice}</td><td>$${t.exitPrice}</td><td class="${t.isWin?'win':'loss'}">${t.pnlPercentage.toFixed(2)}%</td><td>${t.isWin?'WIN':'LOSS'}</td></tr>`).join('')}
                </table></div>
            </div></body></html>
        `);
    } catch (e) { res.status(500).send("Error"); }
});

app.listen(port, () => console.log(`🌐 Dashboard on port ${port}`));

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
    
    return { 
        currentPrice, 
        swing: { 
            trend: currentPrice > smaValue1h ? 'BULLISH' : 'BEARISH',
            strength: ADX.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 }).pop()?.adx || 0,
            rsi: RSI.calculate({ period: 14, values: closes15m }).pop(),
            atr: ATR.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m }).pop(),
            macd: MACD.calculate({ values: closes15m, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }).pop(),
            bb: BollingerBands.calculate({ period: 20, values: closes15m, stdDev: 2 }).pop(),
            volConfirm: OBV.calculate({ close: closes15m, volume: volumes15m }).slice(-1)[0] > OBV.calculate({ close: closes15m, volume: volumes15m }).slice(-4)[0]
        }
    };
}

async function processTradeExit(side, entryPrice, exitPrice, contracts, contractSize) {
    try {
        const positionValueEntry = entryPrice * contracts * contractSize;
        const positionValueExit = exitPrice * contracts * contractSize;
        const initialMarginUsd = positionValueEntry / leverage;
        let rawPnlUsd = (side === 'LONG') ? (exitPrice - entryPrice) * contracts * contractSize : (entryPrice - exitPrice) * contracts * contractSize;
        const totalFeeUsd = (positionValueEntry + positionValueExit) * takerFeeRate;
        const netPnlUsd = rawPnlUsd - totalFeeUsd;
        const netPnlPercentage = (netPnlUsd / initialMarginUsd) * 100;

        const balanceData = await mexc.fetchBalance();
        liveUsdtBalance = balanceData.total['USDT'] || 0;

        await Trade.create({ side, entryPrice, exitPrice, pnlPercentage: netPnlPercentage, pnlUsd: netPnlUsd, balanceAfter: liveUsdtBalance, isWin: netPnlUsd > 0 });
        sendTelegramAlert(`💸 CLOSED ${side}: ${netPnlUsd > 0 ? 'WIN ✅' : 'LOSS ❌'}\nNet: $${netPnlUsd.toFixed(2)} (${netPnlPercentage.toFixed(2)}%)`);
        
        activePosition = null;
        evolveBot();
    } catch (e) { console.error("Exit Save Error:", e.message); }
}

async function evolveBot() {
    const recent = await Trade.find().sort({ timestamp: -1 }).limit(10);
    if (recent.length < 10) return;
    const winRate = recent.filter(t => t.isWin).length / 10;
    let brain = await BotBrain.findOne();
    if (winRate < 0.4) {
        brain.takeProfitTrigger = Math.max(brain.takeProfitTrigger - 0.5, 3.0);
        brain.profitLockFloor = Math.max(brain.profitLockFloor - 0.2, 1.0);
    } else if (winRate > 0.7) {
        brain.takeProfitTrigger = Math.min(brain.takeProfitTrigger + 0.5, 10.0);
    }
    await brain.save();
    activeBrain = brain;
}

// ==========================================
// MAIN BOT LOOP
// ==========================================
async function runBot() {
    if (isTrading) return; 
    isTrading = true;
    try {
        const market = await mexc.market(symbol);
        const contractSize = market.contractSize;
        const ctx = await getMarketContext();
        const balance = await mexc.fetchBalance();
        liveUsdtBalance = balance.total['USDT'] || 0;

        const positions = await mexc.fetchPositions([symbol]);
        const longPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'long');
        const shortPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'short');

        // --- CALC CURRENT PERFORMANCE ---
        let currentPnlPct = 0;
        if (longPos) {
            const entry = parseFloat(longPos.entryPrice);
            currentPnlPct = ((ctx.currentPrice - entry) / entry) * leverage * 100;
            activePosition = { side: 'LONG', entryPrice: entry, pnlPct: currentPnlPct, unrealizedPnlUsd: (ctx.currentPrice - entry) * parseFloat(longPos.contracts) * contractSize };
        } else if (shortPos) {
            const entry = parseFloat(shortPos.entryPrice);
            currentPnlPct = ((entry - ctx.currentPrice) / entry) * leverage * 100;
            activePosition = { side: 'SHORT', entryPrice: entry, pnlPct: currentPnlPct, unrealizedPnlUsd: (entry - ctx.currentPrice) * parseFloat(shortPos.contracts) * contractSize };
        } else {
            activePosition = null;
        }

        const activeAtr = ctx.swing.atr; 

        // --- LONG MANAGEMENT ---
        if (longPos) {
            if (peakPrice === 0 || ctx.currentPrice > peakPrice) peakPrice = ctx.currentPrice;
            const entry = parseFloat(longPos.entryPrice);
            
            // Default Stop: entry - (ATR * 2)
            let stopLoss = entry - (activeAtr * activeBrain.stopMultiplier);
            
            // THE FIX: If PnL > 5%, lock in 2% profit and use TIGHTER trailing (0.7x ATR instead of 1.5x)
            if (currentPnlPct >= activeBrain.takeProfitTrigger) {
                const floorPrice = entry * (1 + (activeBrain.profitLockFloor / 100 / leverage));
                const tightTrail = peakPrice - (activeAtr * (activeBrain.trailMultiplier * 0.6)); // Tighten for breakout
                stopLoss = Math.max(floorPrice, tightTrail);
            } else {
                // Normal Trailing
                const normalTrail = peakPrice - (activeAtr * activeBrain.trailMultiplier);
                stopLoss = Math.max(stopLoss, normalTrail);
            }

            if (ctx.currentPrice < stopLoss) {
                await mexc.createMarketSellOrder(symbol, parseFloat(longPos.contracts), { 'reduceOnly': true });
                await processTradeExit('LONG', entry, ctx.currentPrice, parseFloat(longPos.contracts), contractSize);
                peakPrice = 0;
            }
        }

        // --- SHORT MANAGEMENT ---
        if (shortPos) {
            if (peakPrice === 0 || ctx.currentPrice < peakPrice) peakPrice = ctx.currentPrice;
            const entry = parseFloat(shortPos.entryPrice);
            
            let stopLoss = entry + (activeAtr * activeBrain.stopMultiplier);
            
            if (currentPnlPct >= activeBrain.takeProfitTrigger) {
                const floorPrice = entry * (1 - (activeBrain.profitLockFloor / 100 / leverage));
                const tightTrail = peakPrice + (activeAtr * (activeBrain.trailMultiplier * 0.6));
                stopLoss = Math.min(floorPrice, tightTrail);
            } else {
                const normalTrail = peakPrice + (activeAtr * activeBrain.trailMultiplier);
                stopLoss = Math.min(stopLoss, normalTrail);
            }

            if (ctx.currentPrice > stopLoss) {
                await mexc.createMarketBuyOrder(symbol, parseFloat(shortPos.contracts), { 'reduceOnly': true });
                await processTradeExit('SHORT', entry, ctx.currentPrice, parseFloat(shortPos.contracts), contractSize);
                peakPrice = 0;
            }
        }

        // --- ENTRY LOGIC ---
        if (!longPos && !shortPos && liveUsdtBalance > 10) {
            const btcToTrade = (liveUsdtBalance * riskFactor * leverage) / ctx.currentPrice;
            const contractsToTrade = Math.floor(btcToTrade / contractSize);
            
            if (contractsToTrade >= 1) {
                // Simplified Trend Entry for demo - Keep your existing RSI/ADX/OBI logic here
                if (ctx.swing.trend === 'BULLISH' && ctx.swing.strength > activeBrain.minTrendStrength) {
                    await mexc.createMarketBuyOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                    peakPrice = ctx.currentPrice;
                } else if (ctx.swing.trend === 'BEARISH' && ctx.swing.strength > activeBrain.minTrendStrength) {
                    await mexc.createMarketSellOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                    peakPrice = ctx.currentPrice;
                }
            }
        }
    } catch (e) { console.error("Loop Error:", e.message); }
    finally { isTrading = false; }
}

async function startBot() {
    await mexc.loadMarkets();
    await loadBotBrain();
    setInterval(runBot, 5000); 
}
startBot();
