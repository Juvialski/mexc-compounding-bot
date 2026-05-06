const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const { RSI, SMA, ATR, MACD } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;

// ==========================================
// BOT CONFIGURATION
// ==========================================
const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskPerTradePercent = 2.5; 
const takerFeeRate = 0.0006; 

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' },
    enableRateLimit: true 
});

// Global States
let isTrading = false;
let liveTotalEquity = 0; 
let liveWalletBalance = 0;
let liveUnrealizedPnl = 0;
let currentMarketPrice = 0;
let globalContractSize = 0.0001; 
let activePosition = null;
let tp1Reached = false;

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
// TRADING ENGINE
// ==========================================
async function updateAccountEquity() {
    try {
        const balance = await mexc.fetchBalance();
        liveWalletBalance = balance.total['USDT'] || 0; 
    } catch(e) { console.error("Equity Sync Failed"); }
}

async function getMarketContext() {
    const [ohlcv1h, ohlcv15m, ohlcv5m] = await Promise.all([
        mexc.fetchOHLCV(symbol, '1h', undefined, 60),
        mexc.fetchOHLCV(symbol, '15m', undefined, 60),
        mexc.fetchOHLCV(symbol, '5m', undefined, 60)
    ]);
    const closes1h = ohlcv1h.map(c => c[4]);
    const closes15m = ohlcv15m.map(c => c[4]);
    const closes5m = ohlcv5m.map(c => c[4]);
    currentMarketPrice = closes5m[closes5m.length - 1];

    const sma50_1h = SMA.calculate({ period: 50, values: closes1h }).pop();
    const rsi15m = RSI.calculate({ period: 14, values: closes15m }).pop();
    const macd5m = MACD.calculate({ values: closes5m, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }).pop();
    const atr15m = ATR.calculate({ period: 14, high: ohlcv15m.map(c => c[2]), low: ohlcv15m.map(c => c[3]), close: closes15m }).pop();
    const avgVol = ohlcv5m.slice(-10).reduce((a, b) => a + b[5], 0) / 10;

    return { 
        price: currentMarketPrice, trend1h: currentMarketPrice > sma50_1h ? 'BULL' : 'BEAR',
        rsi: rsi15m, macd: macd5m, atr: atr15m, volumeHigh: ohlcv5m[ohlcv5m.length-1][5] > avgVol
    };
}

async function runBot() {
    if (isTrading) return; 
    isTrading = true;
    try {
        await updateAccountEquity();
        const ctx = await getMarketContext();
        const market = await mexc.market(symbol);
        globalContractSize = market.contractSize;

        const positions = await mexc.fetchPositions([symbol]);
        const pos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0);

        if (pos) {
            const side = pos.side.toUpperCase();
            const entry = parseFloat(pos.entryPrice);
            const size = parseFloat(pos.contracts);
            const pnlUsd = side === 'LONG' ? (ctx.price - entry) * size * globalContractSize : (entry - ctx.price) * size * globalContractSize;
            const pnlPct = (pnlUsd / ((entry * size * globalContractSize) / leverage)) * 100;
            
            liveUnrealizedPnl = pnlUsd;
            liveTotalEquity = liveWalletBalance + pnlUsd;
            if(!activePosition) activePosition = { side, entryPrice: entry, startTime: Date.now(), size };
            activePosition.pnlPct = pnlPct;

            const stopDist = ctx.atr * 2.5; 
            const tpDist = stopDist * 1.5;

            if (side === 'LONG') {
                const sl = tp1Reached ? (entry + (entry * 0.001)) : (entry - stopDist);
                if (!tp1Reached && ctx.price >= (entry + tpDist)) {
                    await mexc.createMarketSellOrder(symbol, Math.floor(size/2), { 'reduceOnly': true });
                    tp1Reached = true;
                    sendTelegramAlert("🎯 TP1 HIT: Sold 50%, SL moved to entry.");
                }
                if (ctx.price <= sl || (tp1Reached && ctx.macd.histogram < 0)) {
                    await mexc.createMarketSellOrder(symbol, size, { 'reduceOnly': true });
                    await recordExit(side, entry, ctx.price, size, activePosition.startTime);
                }
            } else {
                const sl = tp1Reached ? (entry - (entry * 0.001)) : (entry + stopDist);
                if (!tp1Reached && ctx.price <= (entry - tpDist)) {
                    await mexc.createMarketBuyOrder(symbol, Math.floor(size/2), { 'reduceOnly': true });
                    tp1Reached = true;
                    sendTelegramAlert("🎯 TP1 HIT: Sold 50%, SL moved to entry.");
                }
                if (ctx.price >= sl || (tp1Reached && ctx.macd.histogram > 0)) {
                    await mexc.createMarketBuyOrder(symbol, size, { 'reduceOnly': true });
                    await recordExit(side, entry, ctx.price, size, activePosition.startTime);
                }
            }
        } else {
            liveUnrealizedPnl = 0; liveTotalEquity = liveWalletBalance; activePosition = null; tp1Reached = false;
            
            const isLong = ctx.trend1h === 'BULL' && ctx.rsi < 60 && ctx.macd.histogram > 0 && ctx.volumeHigh;
            const isShort = ctx.trend1h === 'BEAR' && ctx.rsi > 40 && ctx.macd.histogram < 0 && ctx.volumeHigh;

            if (isLong || isShort) {
                const stopDist = ctx.atr * 2.5;
                const contracts = Math.floor((liveWalletBalance * (riskPerTradePercent/100)) / (stopDist * globalContractSize));
                if (contracts >= 1) {
                    const side = isLong ? 'buy' : 'sell';
                    const type = isLong ? 1 : 2;
                    await mexc.createMarketOrder(symbol, side, contracts, undefined, { 'openType': 1, 'positionType': type, 'leverage': leverage });
                    sendTelegramAlert(`🚀 ${side.toUpperCase()} ENTRY at ${ctx.price}`);
                }
            }
        }
    } catch (e) { console.error("Loop Error:", e.message); }
    finally { isTrading = false; }
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
    activePosition = null; tp1Reached = false;
}

// ==========================================
// ORIGINAL DASHBOARD UI
// ==========================================
app.get('/', async (req, res) => {
    try {
        const allTrades = await Trade.find().sort({ endTime: -1 });
        const recentTrades = allTrades.slice(0, 15);
        const totalPnlUsd = allTrades.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
        const winRate = allTrades.length > 0 ? ((allTrades.filter(t => t.isWin).length / allTrades.length) * 100).toFixed(1) : 0;

        let posHtml = `<div class="empty-state">⚪ NO ACTIVE POSITIONS - SCANNING MARKET</div>`;
        if (activePosition) {
            const marginUsed = (activePosition.entryPrice * activePosition.size * globalContractSize) / leverage;
            const mode = tp1Reached ? '🎯 BREAK-EVEN (RUNNER)' : '🛡️ INITIAL RISK';
            posHtml = `
            <div class="active-card pulse-border">
                <div class="card-header">
                    <h2><span class="pulse-dot ${activePosition.side === 'LONG'?'dot-green':'dot-red'}"></span> ACTIVE POSITION</h2>
                    <span class="badge ${activePosition.side === 'LONG' ? 'badge-green' : 'badge-red'}">${activePosition.side}</span>
                </div>
                <div class="grid grid-cols-4 gap-4 mt-4">
                    <div class="stat-box"><span class="label">Entry Price</span><span class="value">$${(activePosition.entryPrice || 0).toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">Current Price</span><span class="value">$${(currentMarketPrice || 0).toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">Unrealized PnL</span><span class="value ${liveUnrealizedPnl >= 0 ? 'text-green' : 'text-red'}">${(activePosition.pnlPct || 0).toFixed(2)}% ($${(liveUnrealizedPnl || 0).toFixed(2)})</span></div>
                    <div class="stat-box"><span class="label">Bot Mode</span><span class="value text-yellow">${mode}</span></div>
                    <div class="stat-box"><span class="label">Margin Used</span><span class="value">$${marginUsed.toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">Time</span><span class="value">${Math.floor((Date.now() - activePosition.startTime)/60000)}m</span></div>
                </div>
            </div>`;
        }

        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <title>Elite Sniper V6.0</title>
                <meta http-equiv="refresh" content="8">
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
                <style>
                    :root { --bg: #0b0f19; --card: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; --green: #10b981; --red: #ef4444; --blue: #3b82f6; --yellow: #f59e0b; }
                    body { background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; margin: 0; padding: 30px; }
                    .container { max-width: 1100px; margin: auto; }
                    h1 { color: #38bdf8; text-align: center; margin-bottom: 5px; font-weight: 800; }
                    .sub-header { text-align: center; color: var(--muted); margin-bottom: 30px; font-size: 14px; }
                    .grid { display: grid; } .grid-cols-4 { grid-template-columns: repeat(4, 1fr); } .gap-4 { gap: 15px; } .mt-4 { margin-top: 15px; }
                    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
                    .stat-title { color: var(--muted); font-size: 12px; font-weight: 600; text-transform: uppercase; margin-bottom: 8px; }
                    .stat-value { font-size: 26px; font-weight: 800; }
                    .text-green { color: var(--green); } .text-red { color: var(--red); } .text-blue { color: var(--blue); } .text-yellow { color: var(--yellow); }
                    .active-card { background: #0f172a; padding: 25px; border-radius: 12px; border: 1px solid #0ea5e9; margin-top: 25px; }
                    .card-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 15px; }
                    .card-header h2 { margin: 0; font-size: 18px; color: #38bdf8; display: flex; align-items: center; gap: 10px; }
                    .badge { padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 800; }
                    .badge-green { background: rgba(16, 185, 129, 0.2); color: var(--green); border: 1px solid var(--green); }
                    .badge-red { background: rgba(239, 68, 68, 0.2); color: var(--red); border: 1px solid var(--red); }
                    .stat-box { background: var(--card); padding: 12px 15px; border-radius: 8px; border: 1px solid var(--border); }
                    .stat-box .label { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; }
                    .stat-box .value { display: block; font-size: 16px; font-weight: 600; }
                    .empty-state { margin-top: 25px; padding: 40px; border: 1px dashed var(--border); color: var(--muted); border-radius: 12px; text-align: center; background: rgba(30, 41, 59, 0.3); }
                    .pulse-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; animation: pulse 1.5s infinite; }
                    .dot-green { background: var(--green); box-shadow: 0 0 8px var(--green); }
                    .dot-red { background: var(--red); box-shadow: 0 0 8px var(--red); }
                    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
                    table { width: 100%; border-collapse: collapse; margin-top: 15px; background: var(--card); border-radius: 12px; overflow: hidden; }
                    th { background: #0f172a; color: var(--muted); text-align: left; padding: 16px; font-size: 13px; text-transform: uppercase; border-bottom: 1px solid var(--border); }
                    td { padding: 16px; font-size: 14px; border-bottom: 1px solid var(--border); font-weight: 600; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🎯 Elite Sniper V6.0 Terminal</h1>
                    <div class="sub-header">Server Time (PHT): ${formatPHT(new Date())}</div>
                    <div class="grid grid-cols-4 gap-4">
                        <div class="card"><div class="stat-title">Wallet Balance</div><div class="stat-value">$${(liveWalletBalance || 0).toFixed(2)}</div></div>
                        <div class="card"><div class="stat-title">Active PnL</div><div class="stat-value ${liveUnrealizedPnl >= 0 ? 'text-green' : 'text-red'}">$${(liveUnrealizedPnl || 0).toFixed(2)}</div></div>
                        <div class="card"><div class="stat-title">Account Equity</div><div class="stat-value text-blue">$${(liveTotalEquity || 0).toFixed(2)}</div></div>
                        <div class="card"><div class="stat-title">Net Profit / Win Rate</div><div class="stat-value ${totalPnlUsd >= 0 ? 'text-green':'text-red'}">$${totalPnlUsd.toFixed(2)} <span style="font-size:14px; color:var(--muted)">(${winRate}%)</span></div></div>
                    </div>
                    ${posHtml}
                    <h3 style="margin-top:40px; color: var(--muted); font-size: 14px; text-transform: uppercase;">📜 Recent Trade Log</h3>
                    <table>
                        <tr><th>Closed At (PHT)</th><th>Side</th><th>PnL %</th><th>Net Profit</th><th>Ending Equity</th></tr>
                        ${recentTrades.map(t => `
                            <tr>
                                <td style="color: var(--muted); font-weight: 400;">${formatPHT(t.endTime)}</td>
                                <td><span class="badge ${t.side === 'LONG' ? 'badge-green' : 'badge-red'}">${t.side}</span></td>
                                <td class="${(t.pnlPercentage || 0) >= 0 ? 'text-green' : 'text-red'}">${(t.pnlPercentage || 0).toFixed(2)}%</td>
                                <td class="${(t.pnlUsd || 0) >= 0 ? 'text-green' : 'text-red'}">$${(t.pnlUsd || 0).toFixed(2)}</td>
                                <td>$${(t.equityAfter || 0).toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </table>
                </div>
            </body>
            </html>
        `);
    } catch (e) { res.send(`Dashboard error: ${e.message}`); }
});

async function start() {
    await mexc.loadMarkets();
    setInterval(runBot, 10000);
}
app.listen(port, () => start());
