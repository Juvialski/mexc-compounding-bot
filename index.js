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
const PROBABILITY_THRESHOLD = 80; 

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
let tp1Reached = false;
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
// PROBABILITY ENGINE (V9 LOGIC)
// ==========================================
async function getMarketContext() {
    const [ohlcv1m, ohlcv15m, ohlcv1h] = await Promise.all([
        mexc.fetchOHLCV(symbol, '1m', undefined, 100),
        mexc.fetchOHLCV(symbol, '15m', undefined, 100),
        mexc.fetchOHLCV(symbol, '1h', undefined, 200)
    ]);

    const closes1m = ohlcv1m.map(c => c[4]);
    const closes15m = ohlcv15m.map(c => c[4]);
    const highs15m = ohlcv15m.map(c => c[2]);
    const lows15m = ohlcv15m.map(c => c[3]);
    const volumes15m = ohlcv15m.map(c => c[5]);

    const rsi1m = RSI.calculate({ period: 14, values: closes1m }).pop() || 50;
    const rsi15m = RSI.calculate({ period: 14, values: closes15m }).pop() || 50;
    const bb1m = BollingerBands.calculate({ period: 20, stdDev: 2.5, values: closes1m }).pop() || { upper: 0, lower: 0 };
    const sma1h = SMA.calculate({ period: 200, values: ohlcv1h.map(c => c[4]) }).pop() || 0;
    const atr15m = ATR.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m }).pop() || 10;
    
    const adxData = ADX.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m }).pop();
    const adx = adxData ? adxData.adx : 0;

    const avgVol = volumes15m.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const currentVol = volumes15m[volumes15m.length - 1];
    const volSpike = currentVol > avgVol * 1.8;

    return { 
        rsi1m, rsi15m, bb1m, sma1h, atr15m, adx, volSpike, 
        recentHigh: Math.max(...highs15m.slice(-30)), 
        recentLow: Math.min(...lows15m.slice(-30)) 
    };
}

function calculateProbability(side, ctx, price) {
    let score = 0;
    let logic = [];

    if (side === 'LONG' && price > ctx.sma1h) { score += 30; logic.push("🟢 1H Trend Alignment"); }
    else if (side === 'SHORT' && price < ctx.sma1h) { score += 30; logic.push("🔴 1H Trend Alignment"); }

    if (ctx.adx < 25) { score += 20; logic.push("⚖️ Low Volatility (Range-Bound)"); }
    else if (ctx.adx > 35) { score -= 10; logic.push("⚠️ High Trend Strength (Dangerous)"); }

    if (side === 'LONG') {
        if (ctx.rsi1m < 32) { score += 15; logic.push("📉 1M RSI Oversold"); }
        if (ctx.rsi15m < 45) { score += 10; logic.push("📊 15M RSI Lower Zone"); }
    } else {
        if (ctx.rsi1m > 68) { score += 15; logic.push("📈 1M RSI Overbought"); }
        if (ctx.rsi15m > 55) { score += 10; logic.push("📊 15M RSI Upper Zone"); }
    }

    if (ctx.volSpike) { score += 25; logic.push("🔥 Volume Climax detected"); }

    return { score, logic };
}

// ==========================================
// TRADING ENGINE
// ==========================================
async function updateAccountEquity() {
    try {
        const balance = await mexc.fetchBalance();
        liveWalletBalance = balance.total['USDT'] || liveWalletBalance; 
    } catch(e) { console.error("Equity Sync Failed"); }
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
        currentMarketPrice = ticker.last;
        
        if (globalContractSize === 0.0001) {
            const market = await mexc.market(symbol);
            globalContractSize = market.contractSize || 0.0001;
        }

        const pos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0);

        if (pos) {
            const side = pos.side.toUpperCase();
            const entry = parseFloat(pos.entryPrice);
            const size = parseFloat(pos.contracts);
            liveUnrealizedPnl = parseFloat(pos.unrealizedPnl);
            liveMarginUsed = (entry * size * globalContractSize) / leverage;
            
            if(!activePosition) activePosition = { side, entryPrice: entry, startTime: Date.now(), size };

            const stopDist = ctx.atr15m * 1.8;
            const sl = tp1Reached ? entry : (side === 'LONG' ? (entry - stopDist) : (entry + stopDist));
            const tp = side === 'LONG' ? ctx.recentHigh : ctx.recentLow;

            if (!tp1Reached) {
                const targetHit = side === 'LONG' ? (currentMarketPrice >= tp) : (currentMarketPrice <= tp);
                if (targetHit) {
                    await mexc.createOrder(symbol, 'market', side === 'LONG' ? 'sell' : 'buy', Math.floor(size/2), undefined, { 'reduceOnly': true });
                    tp1Reached = true;
                }
            }

            const shouldExit = side === 'LONG' ? (currentMarketPrice <= sl) : (currentMarketPrice >= sl);
            if (shouldExit) {
                await mexc.createOrder(symbol, 'market', side === 'LONG' ? 'sell' : 'buy', size, undefined, { 'reduceOnly': true });
                await recordExit(side, entry, currentMarketPrice, size, activePosition.startTime);
            }
        } else {
            liveUnrealizedPnl = 0; activePosition = null; tp1Reached = false; liveMarginUsed = 0;
            const longEval = calculateProbability('LONG', ctx, currentMarketPrice);
            const shortEval = calculateProbability('SHORT', ctx, currentMarketPrice);
            const bestScore = Math.max(longEval.score, shortEval.score);
            const bestSide = longEval.score > shortEval.score ? 'LONG' : 'SHORT';
            const bestLogic = longEval.score > shortEval.score ? longEval.logic : shortEval.logic;

            botThinking = {
                score: bestScore,
                trend: currentMarketPrice > ctx.sma1h ? 'BULLISH 📈' : 'BEARISH 📉',
                volatility: ctx.adx > 30 ? 'TRENDING (Risky)' : 'STABLE (Optimal)',
                rsi: ctx.rsi1m.toFixed(1),
                logic: bestLogic,
                buyTarget: ctx.bb1m.lower,
                sellTarget: ctx.bb1m.upper,
                lastUpdate: Date.now()
            };

            if (bestScore >= PROBABILITY_THRESHOLD && (Date.now() - lastOrderUpdateTime > 60000)) {
                const totalEquity = liveWalletBalance + liveMarginUsed;
                const qtyUsd = (totalEquity * (riskPerTradePercent/100)) * leverage;
                const qty = mexc.amountToPrecision(symbol, qtyUsd / currentMarketPrice);
                const entryPrice = bestSide === 'LONG' ? ctx.bb1m.lower : ctx.bb1m.upper;

                if (parseFloat(qty) > 0) {
                    await mexc.createOrder(symbol, 'limit', bestSide === 'LONG' ? 'buy' : 'sell', qty, entryPrice, { 'openType': 1, 'positionType': bestSide === 'LONG' ? 1 : 2 });
                    lastOrderUpdateTime = Date.now();
                    sendTelegramAlert(`⚡ SNIPER SET: ${bestSide} at ${entryPrice} (Prob: ${bestScore}%)`);
                }
            }
        }
    } catch (e) { console.error(`Loop Error: ${e.message}`); } finally { isTrading = false; }
}

async function recordExit(side, entry, exit, size, start) {
    const rawPnl = side === 'LONG' ? (exit - entry) * size * globalContractSize : (entry - exit) * size * globalContractSize;
    const netPnl = rawPnl - ((entry + exit) * size * globalContractSize * takerFeeRate);
    await updateAccountEquity();
    await Trade.create({
        side, entryPrice: entry, exitPrice: exit, pnlUsd: netPnl,
        pnlPercentage: (netPnl / ((entry * size * globalContractSize) / leverage)) * 100,
        equityAfter: liveWalletBalance, isWin: netPnl > 0, startTime: start, endTime: new Date()
    });
    activePosition = null; tp1Reached = false; liveMarginUsed = 0;
    sendTelegramAlert(`💸 TRADE CLOSED: ${side} PnL: $${netPnl.toFixed(2)}`);
}

// ==========================================
// DASHBOARD UI (V8.2 STYLE)
// ==========================================
app.get('/', async (req, res) => {
    try {
        const allTrades = await Trade.find().sort({ endTime: -1 });
        const recentTrades = allTrades.slice(0, 10);
        const totalPnlUsd = allTrades.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
        const winRate = allTrades.length > 0 ? ((allTrades.filter(t => t.isWin).length / allTrades.length) * 100).toFixed(1) : 0;
        const displayEquity = liveWalletBalance + liveMarginUsed + liveUnrealizedPnl;

        let posHtml = `
            <div class="active-card">
                <div class="card-header">
                    <h2>🧠 PROBABILITY MATRIX (CONFIDENCE: ${botThinking.score}%)</h2>
                    <span style="font-size:11px; color:var(--muted)">REFRESHED: ${Math.floor((Date.now() - botThinking.lastUpdate)/1000)}s ago</span>
                </div>
                <div class="score-bar" style="background:#334155; height:10px; border-radius:5px; margin:15px 0; overflow:hidden;">
                    <div style="background:#3b82f6; width:${botThinking.score}%; height:100%;"></div>
                </div>
                <div class="grid grid-cols-4 gap-4 mt-4">
                    <div class="stat-box"><span class="label">1H Trend</span><span class="value">${botThinking.trend}</span></div>
                    <div class="stat-box"><span class="label">Volatility</span><span class="value">${botThinking.volatility}</span></div>
                    <div class="stat-box"><span class="label">Logic</span><span class="value" style="font-size:10px">${botThinking.logic.join('<br>')}</span></div>
                    <div class="stat-box"><span class="label">Extreme Targets</span><span class="value" style="font-size:11px">B: $${(botThinking.buyTarget || 0).toFixed(1)}<br>S: $${(botThinking.sellTarget || 0).toFixed(1)}</span></div>
                </div>
            </div>
        `;

        if (activePosition) {
            const roePct = liveMarginUsed > 0 ? (liveUnrealizedPnl / liveMarginUsed) * 100 : 0;
            posHtml = `
            <div class="active-card" style="border-color:#3b82f6;">
                <div class="card-header">
                    <h2>ACTIVE POSITION</h2>
                    <span class="badge" style="background:${activePosition.side === 'LONG'?'#10b981':'#ef4444'}">${activePosition.side}</span>
                </div>
                <div class="grid grid-cols-4 gap-4 mt-4">
                    <div class="stat-box"><span class="label">Entry</span><span class="value">$${activePosition.entryPrice.toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">Market</span><span class="value">$${currentMarketPrice.toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">ROE%</span><span class="value ${roePct >= 0 ? 'text-green' : 'text-red'}">${roePct.toFixed(2)}%</span></div>
                    <div class="stat-box"><span class="label">PnL</span><span class="value ${liveUnrealizedPnl >= 0 ? 'text-green' : 'text-red'}">$${liveUnrealizedPnl.toFixed(2)}</span></div>
                </div>
            </div>`;
        }

        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <title>Sniper V9.0 PRO</title>
                <meta http-equiv="refresh" content="5">
                <style>
                    :root { --bg: #0b0f19; --card: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; --green: #10b981; --red: #ef4444; --blue: #3b82f6; }
                    body { background: var(--bg); color: var(--text); font-family: sans-serif; margin: 0; padding: 30px; }
                    .container { max-width: 1000px; margin: auto; }
                    h1 { text-align: center; color: #38bdf8; }
                    .grid { display: grid; } .grid-cols-4 { grid-template-columns: repeat(4, 1fr); } .gap-4 { gap: 15px; } .mt-4 { margin-top: 15px; }
                    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
                    .stat-title { color: var(--muted); font-size: 11px; text-transform: uppercase; }
                    .stat-value { font-size: 22px; font-weight: 800; margin-top: 5px; }
                    .active-card { background: #0f172a; padding: 20px; border-radius: 12px; border: 1px solid var(--border); margin-top: 20px; }
                    .card-header { display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
                    .stat-box { background: var(--card); padding: 10px; border-radius: 8px; }
                    .label { font-size: 10px; color: var(--muted); display: block; }
                    .value { font-size: 14px; font-weight: 600; }
                    .text-green { color: var(--green); } .text-red { color: var(--red); }
                    table { width: 100%; border-collapse: collapse; margin-top: 25px; }
                    th { text-align: left; color: var(--muted); font-size: 12px; padding: 10px; border-bottom: 1px solid var(--border); }
                    td { padding: 10px; border-bottom: 1px solid var(--border); font-size: 13px; }
                    .badge { padding: 3px 7px; border-radius: 4px; font-size: 10px; color: white; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🎯 Elite Sniper V9.0 PRO</h1>
                    <div class="grid grid-cols-4 gap-4">
                        <div class="card"><div class="stat-title">Balance</div><div class="stat-value">$${liveWalletBalance.toFixed(2)}</div></div>
                        <div class="card"><div class="stat-title">Equity</div><div class="stat-value" style="color:var(--blue)">$${displayEquity.toFixed(2)}</div></div>
                        <div class="card"><div class="stat-title">Net Profit</div><div class="stat-value ${totalPnlUsd >= 0 ? 'text-green' : 'text-red'}">$${totalPnlUsd.toFixed(2)}</div></div>
                        <div class="card"><div class="stat-title">Win Rate</div><div class="stat-value">${winRate}%</div></div>
                    </div>
                    ${posHtml}
                    <table>
                        <tr><th>Time</th><th>Side</th><th>PnL%</th><th>PnL$</th><th>Equity</th></tr>
                        ${recentTrades.map(t => `
                            <tr>
                                <td>${formatPHT(t.endTime)}</td>
                                <td><span class="badge" style="background:${t.side==='LONG'?'#10b981':'#ef4444'}">${t.side}</span></td>
                                <td class="${t.pnlPercentage >= 0 ? 'text-green' : 'text-red'}">${t.pnlPercentage.toFixed(2)}%</td>
                                <td class="${t.pnlUsd >= 0 ? 'text-green' : 'text-red'}">$${t.pnlUsd.toFixed(2)}</td>
                                <td>$${t.equityAfter.toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </table>
                </div>
            </body>
            </html>
        `);
    } catch (e) { res.send(`UI Error: ${e.message}`); }
});

async function start() {
    try {
        await mexc.loadMarkets();
        try { await mexc.cancelAllOrders(symbol); } catch(e) {}
        await updateAccountEquity();
        setInterval(runBot, 4000);
        setInterval(updateAccountEquity, 20000); 
    } catch (e) { console.error("Startup Error:", e.message); }
}
app.listen(port, () => start());
