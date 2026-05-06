const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const { RSI, SMA, ATR, BollingerBands, ADX } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;

// ==========================================
// BOT CONFIGURATION
// ==========================================
const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskPerTradePercent = 2.5; 
const takerFeeRate = 0.0006; 
const PROBABILITY_THRESHOLD = 75; 
const REWARD_RATIO = 1.2; // 1:1.2 RR Ratio for 51%+ Winrate efficiency

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' },
    enableRateLimit: true 
});

// Global States
let isTrading = false;
let liveWalletBalance = 0; 
let liveMarginUsed = 0;    
let liveUnrealizedPnl = 0;
let currentMarketPrice = 0;
let globalContractSize = 0.0001; 
let activePosition = null;
let lastOrderUpdateTime = 0;

let botThinking = {
    score: 0,
    trend: 'Analysing...',
    volatility: 'Stable',
    rsi: 0,
    logic: [],
    buyTarget: 0,
    sellTarget: 0,
    lastUpdate: Date.now()
};

// ==========================================
// UTILS & DATABASE
// ==========================================
function sendTelegramAlert(message) {
    const token = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return; 
    const url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(message)}`;
    https.get(url).on('error', (e) => console.error("Telegram error:", e.message));
}

const formatPHT = (dateInput) => {
    if (!dateInput) return 'N/A';
    return new Date(dateInput).toLocaleString('en-US', { 
        timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
};

mongoose.connect(process.env.MONGO_URI).catch(err => console.error("❌ DB ERROR", err));

const Trade = mongoose.model('Trade', new mongoose.Schema({
    side: String, entryPrice: Number, exitPrice: Number,
    pnlPercentage: Number, pnlUsd: Number, equityAfter: Number, 
    isWin: Boolean, startTime: { type: Date, default: Date.now },
    endTime: { type: Date, default: Date.now }
}));

// ==========================================
// PROBABILITY ENGINE
// ==========================================
async function getMarketContext() {
    try {
        const [ohlcv1m, ohlcv15m, ohlcv1h] = await Promise.all([
            mexc.fetchOHLCV(symbol, '1m', undefined, 100),
            mexc.fetchOHLCV(symbol, '15m', undefined, 100),
            mexc.fetchOHLCV(symbol, '1h', undefined, 200)
        ]);
        const closes1m = ohlcv1m.map(c => c[4]);
        const rsi1m = RSI.calculate({ period: 14, values: closes1m }).pop() || 50;
        const bb1m = BollingerBands.calculate({ period: 20, stdDev: 2.5, values: closes1m }).pop() || { upper: 0, lower: 0 };
        const sma1h = SMA.calculate({ period: 200, values: ohlcv1h.map(c => c[4]) }).pop() || 0;
        const atr15m = ATR.calculate({ period: 14, high: ohlcv15m.map(c => c[2]), low: ohlcv15m.map(c => c[3]), close: ohlcv15m.map(c => c[4]) }).pop() || 10;
        const adxData = ADX.calculate({ period: 14, high: ohlcv15m.map(c => c[2]), low: ohlcv15m.map(c => c[3]), close: ohlcv15m.map(c => c[4]) }).pop();
        const adx = adxData ? adxData.adx : 0;
        const volSpike = ohlcv15m[ohlcv15m.length - 1][5] > (ohlcv15m.slice(-20).reduce((a, b) => a + b[5], 0) / 20) * 1.8;

        return { rsi1m, bb1m, sma1h, atr15m, adx, volSpike };
    } catch (e) { return null; }
}

// ==========================================
// TRADING ENGINE
// ==========================================
async function updateAccountEquity() {
    try {
        const balance = await mexc.fetchBalance();
        liveWalletBalance = Number(balance.total['USDT']) || 0; 
    } catch(e) {}
}

async function runBot() {
    if (isTrading) return; 
    isTrading = true;
    try {
        const [ticker, positions, ctx] = await Promise.all([
            mexc.fetchTicker(symbol),
            mexc.fetchPositions([symbol]),
            getMarketContext()
        ]);
        
        currentMarketPrice = Number(ticker.last);
        if(!ctx) return;

        if (globalContractSize === 0.0001) {
            const market = await mexc.market(symbol);
            globalContractSize = market.contractSize || 0.0001;
        }

        const pos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0);

        if (pos) {
            const side = pos.side.toUpperCase();
            const entry = Number(pos.entryPrice);
            const size = Number(pos.contracts);
            
            liveUnrealizedPnl = (side === 'LONG' ? (currentMarketPrice - entry) : (entry - currentMarketPrice)) * size * globalContractSize;
            liveMarginUsed = (entry * size * globalContractSize) / leverage;
            
            if(!activePosition) activePosition = { side, entryPrice: entry, startTime: Date.now(), size };

            // 51% WINRATE OPTIMIZED EXIT LOGIC
            const stopDist = ctx.atr15m * 1.5; 
            const feeBuffer = entry * 0.0015; // Covers 0.12% fees + slippage
            
            const sl = side === 'LONG' ? (entry - stopDist) : (entry + stopDist);
            const tp = side === 'LONG' 
                ? (entry + (stopDist * REWARD_RATIO) + feeBuffer) 
                : (entry - (stopDist * REWARD_RATIO) - feeBuffer);

            const isStopHit = side === 'LONG' ? currentMarketPrice <= sl : currentMarketPrice >= sl;
            const isTargetHit = side === 'LONG' ? currentMarketPrice >= tp : currentMarketPrice <= tp;

            if (isStopHit || isTargetHit) {
                await mexc.createOrder(symbol, 'market', side === 'LONG' ? 'sell' : 'buy', size, undefined, { 'reduceOnly': true });
                await recordExit(side, entry, currentMarketPrice, size, activePosition.startTime);
            }
        } else {
            liveUnrealizedPnl = 0; liveMarginUsed = 0; activePosition = null;
            
            const longScore = (currentMarketPrice > ctx.sma1h ? 30 : 0) + (ctx.rsi1m < 32 ? 25 : 0) + (ctx.adx < 25 ? 20 : 0) + (ctx.volSpike ? 25 : 0);
            const shortScore = (currentMarketPrice < ctx.sma1h ? 30 : 0) + (ctx.rsi1m > 68 ? 25 : 0) + (ctx.adx < 25 ? 20 : 0) + (ctx.volSpike ? 25 : 0);
            const bestScore = Math.max(longScore, shortScore);
            const bestSide = longScore > shortScore ? 'LONG' : 'SHORT';

            botThinking = { score: bestScore, trend: currentMarketPrice > ctx.sma1h ? 'BULLISH' : 'BEARISH', volatility: ctx.adx > 30 ? 'TRENDING' : 'STABLE', rsi: ctx.rsi1m.toFixed(1), logic: [`Score: ${bestScore}%`, `Trend: ${bestSide}`], buyTarget: ctx.bb1m.lower, sellTarget: ctx.bb1m.upper, lastUpdate: Date.now() };

            if (bestScore >= PROBABILITY_THRESHOLD && (Date.now() - lastOrderUpdateTime > 60000)) {
                // Risk-Based Sizing
                const riskAmount = liveWalletBalance * (riskPerTradePercent / 100);
                const stopDist = ctx.atr15m * 1.5;
                let qty = (riskAmount * leverage) / currentMarketPrice;
                qty = mexc.amountToPrecision(symbol, qty);

                if (parseFloat(qty) > 0) {
                    // Limit order at Bollinger Band edge for better R:R
                    const targetEntry = bestSide === 'LONG' ? ctx.bb1m.lower : ctx.bb1m.upper;
                    await mexc.createOrder(symbol, 'limit', bestSide === 'LONG' ? 'buy' : 'sell', qty, targetEntry, { 'openType': 1, 'positionType': bestSide === 'LONG' ? 1 : 2 });
                    lastOrderUpdateTime = Date.now();
                }
            }
        }
    } catch (e) { console.error("Bot Error:", e.message); } finally { isTrading = false; }
}

async function recordExit(side, entry, exit, size, start) {
    const feeCost = (entry + exit) * size * globalContractSize * takerFeeRate;
    const netPnl = ((side === 'LONG' ? (exit - entry) : (entry - exit)) * size * globalContractSize) - feeCost;
    await updateAccountEquity();
    await Trade.create({ side, entryPrice: entry, exitPrice: exit, pnlUsd: netPnl, pnlPercentage: (netPnl / ((entry * size * globalContractSize) / leverage)) * 100, equityAfter: liveWalletBalance, isWin: netPnl > 0, startTime: start, endTime: new Date() });
}

// ==========================================
// DASHBOARD UI (UNCHANGED)
// ==========================================
app.get('/', async (req, res) => {
    try {
        const allTrades = await Trade.find().sort({ endTime: -1 }).limit(10);
        const totalPnlUsd = (await Trade.find()).reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
        const winRate = (await Trade.countDocuments({ isWin: true }) / (await Trade.countDocuments() || 1) * 100).toFixed(1);
        
        const displayEquity = Number(liveWalletBalance) + Number(liveMarginUsed) + Number(liveUnrealizedPnl);
        const currentRoe = liveMarginUsed > 0 ? (liveUnrealizedPnl / liveMarginUsed) * 100 : 0;

        let activeCard = `
            <div class="active-card">
                <div class="card-header"><h2>🧠 LOGIC MATRIX (CONFIDENCE: ${botThinking.score}%)</h2></div>
                <div class="score-bar"><div class="score-fill" style="width: ${botThinking.score}%"></div></div>
                <div class="grid grid-cols-4 gap-4 mt-4">
                    <div class="stat-box"><span class="label">1H Trend</span><span class="value">${botThinking.trend}</span></div>
                    <div class="stat-box"><span class="label">Volatility</span><span class="value">${botThinking.volatility}</span></div>
                    <div class="stat-box"><span class="label">1M RSI</span><span class="value">${botThinking.rsi}</span></div>
                    <div class="stat-box"><span class="label">Sniper Hooks</span><span class="value" style="font-size:11px">L: $${(botThinking.buyTarget || 0).toFixed(1)}<br>S: $${(botThinking.sellTarget || 0).toFixed(1)}</span></div>
                </div>
            </div>`;

        if (activePosition) {
            activeCard = `
            <div class="active-card pulse-border">
                <div class="card-header">
                    <h2><span class="pulse-dot ${activePosition.side === 'LONG'?'dot-green':'dot-red'}"></span> ACTIVE POSITION</h2>
                    <span class="badge ${activePosition.side === 'LONG' ? 'badge-green' : 'badge-red'}">${activePosition.side}</span>
                </div>
                <div class="grid grid-cols-4 gap-4 mt-4">
                    <div class="stat-box"><span class="label">Entry Price</span><span class="value">$${activePosition.entryPrice.toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">Market Price</span><span class="value">$${currentMarketPrice.toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">ROE %</span><span class="value ${currentRoe >= 0 ? 'text-green' : 'text-red'}">${currentRoe.toFixed(2)}%</span></div>
                    <div class="stat-box"><span class="label">Unrealized PnL</span><span class="value ${liveUnrealizedPnl >= 0 ? 'text-green' : 'text-red'}">$${liveUnrealizedPnl.toFixed(2)}</span></div>
                </div>
            </div>`;
        }

        res.send(`
            <!DOCTYPE html><html><head><title>Elite Sniper V9.0</title><meta http-equiv="refresh" content="3">
            <style>
                :root { --bg: #0b0f19; --card: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; --green: #10b981; --red: #ef4444; --blue: #3b82f6; }
                body { background: var(--bg); color: var(--text); font-family: sans-serif; padding: 30px; margin: 0; }
                .container { max-width: 1100px; margin: auto; }
                .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; }
                .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
                .stat-title { color: var(--muted); font-size: 11px; text-transform: uppercase; margin-bottom: 8px; }
                .stat-value { font-size: 24px; font-weight: 800; }
                .active-card { background: #0f172a; padding: 25px; border-radius: 12px; border: 1px solid #0ea5e9; margin-top: 25px; }
                .card-header { display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 15px; }
                .stat-box { background: var(--card); padding: 12px; border-radius: 8px; border: 1px solid var(--border); }
                .label { display: block; font-size: 10px; color: var(--muted); text-transform: uppercase; }
                .value { display: block; font-size: 16px; font-weight: 600; margin-top: 4px; }
                .score-bar { background: #334155; height: 8px; border-radius: 4px; margin-top: 15px; overflow: hidden; }
                .score-fill { background: var(--blue); height: 100%; }
                .text-green { color: var(--green); } .text-red { color: var(--red); }
                .badge { padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 800; }
                .badge-green { background: rgba(16, 185, 129, 0.2); color: var(--green); }
                .badge-red { background: rgba(239, 68, 68, 0.2); color: var(--red); }
                .pulse-border { animation: border-pulse 2s infinite; }
                @keyframes border-pulse { 0%, 100% { border-color: #0ea5e9; } 50% { border-color: #334155; } }
                table { width: 100%; border-collapse: collapse; margin-top: 30px; }
                th { text-align: left; color: var(--muted); padding: 15px; border-bottom: 1px solid var(--border); font-size: 12px; }
                td { padding: 15px; border-bottom: 1px solid var(--border); font-size: 14px; font-weight: 600; }
            </style></head>
            <body><div class="container">
                <h1 style="color:#38bdf8; text-align:center;">🎯 Elite Sniper V9.0 TERMINAL</h1>
                <div class="grid">
                    <div class="card"><div class="stat-title">Wallet</div><div class="stat-value">$${Number(liveWalletBalance).toFixed(2)}</div></div>
                    <div class="card"><div class="stat-title">Real-Time Equity</div><div class="stat-value" style="color:var(--blue)">$${displayEquity.toFixed(2)}</div></div>
                    <div class="card"><div class="stat-title">Net Profit</div><div class="stat-value ${totalPnlUsd >= 0 ? 'text-green' : 'text-red'}">$${totalPnlUsd.toFixed(2)}</div></div>
                    <div class="card"><div class="stat-title">Win Rate</div><div class="stat-value">${winRate}%</div></div>
                </div>
                ${activeCard}
                <table><tr><th>Time</th><th>Side</th><th>PnL %</th><th>PnL USD</th><th>Equity After</th></tr>
                ${allTrades.map(t => `<tr><td>${formatPHT(t.endTime)}</td><td><span class="badge ${t.side==='LONG'?'badge-green':'badge-red'}">${t.side}</span></td><td class="${t.pnlPercentage>=0?'text-green':'text-red'}">${t.pnlPercentage.toFixed(2)}%</td><td class="${t.pnlUsd>=0?'text-green':'text-red'}">$${t.pnlUsd.toFixed(2)}</td><td>$${t.equityAfter.toFixed(2)}</td></tr>`).join('')}
                </table>
            </div></body></html>`);
    } catch (e) { res.send(`UI Error: ${e.message}`); }
});

async function start() {
    await mexc.loadMarkets();
    await updateAccountEquity();
    setInterval(runBot, 4000);
    setInterval(updateAccountEquity, 15000); 
}
app.listen(port, () => start());
