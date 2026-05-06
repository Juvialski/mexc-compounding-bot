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
const riskPerTradePercent = 2.5; // Risk 2.5% of total balance per trade
const takerFeeRate = 0.0006; 

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' },
    enableRateLimit: true 
});

// Global States for Dashboard
let isTrading = false;
let liveTotalEquity = 0; 
let liveWalletBalance = 0;
let liveUnrealizedPnl = 0;
let currentMarketPrice = 0;
let globalContractSize = 0;
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
// TRADING ENGINE (V6 IMPROVED)
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
        price: currentMarketPrice,
        trend1h: currentMarketPrice > sma50_1h ? 'BULL' : 'BEAR',
        rsi: rsi15m,
        macd: macd5m,
        atr: atr15m,
        volumeHigh: ohlcv5m[ohlcv5m.length-1][5] > avgVol
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
            activePosition = { side, entryPrice: entry, size, pnlPct, startTime: activePosition?.startTime || Date.now() };

            const stopDist = ctx.atr * 2.5; 
            const tpDist = stopDist * 1.5;

            if (side === 'LONG') {
                const sl = tp1Reached ? (entry + (entry * 0.001)) : (entry - stopDist);
                if (!tp1Reached && ctx.price >= (entry + tpDist)) {
                    await mexc.createMarketSellOrder(symbol, Math.floor(size/2), { 'reduceOnly': true });
                    tp1Reached = true;
                }
                if (ctx.price <= sl || (tp1Reached && ctx.macd.histogram < 0)) {
                    await mexc.createMarketSellOrder(symbol, size, { 'reduceOnly': true });
                    await recordTradeExit(side, entry, ctx.price, size, activePosition.startTime);
                }
            } else {
                const sl = tp1Reached ? (entry - (entry * 0.001)) : (entry + stopDist);
                if (!tp1Reached && ctx.price <= (entry - tpDist)) {
                    await mexc.createMarketBuyOrder(symbol, Math.floor(size/2), { 'reduceOnly': true });
                    tp1Reached = true;
                }
                if (ctx.price >= sl || (tp1Reached && ctx.macd.histogram > 0)) {
                    await mexc.createMarketBuyOrder(symbol, size, { 'reduceOnly': true });
                    await recordTradeExit(side, entry, ctx.price, size, activePosition.startTime);
                }
            }
        } else {
            activePosition = null; tp1Reached = false; liveUnrealizedPnl = 0; liveTotalEquity = liveWalletBalance;

            if (ctx.trend1h === 'BULL' && ctx.rsi < 60 && ctx.macd.histogram > 0 && ctx.volumeHigh) {
                const stopDist = ctx.atr * 2.5;
                const contracts = Math.floor((liveWalletBalance * (riskPerTradePercent/100)) / (stopDist * globalContractSize));
                if (contracts >= 1) {
                    await mexc.createMarketOrder(symbol, 'buy', contracts, undefined, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                    sendTelegramAlert(`🚀 LONG ENTRY: $${ctx.price}`);
                }
            } else if (ctx.trend1h === 'BEAR' && ctx.rsi > 40 && ctx.macd.histogram < 0 && ctx.volumeHigh) {
                const stopDist = ctx.atr * 2.5;
                const contracts = Math.floor((liveWalletBalance * (riskPerTradePercent/100)) / (stopDist * globalContractSize));
                if (contracts >= 1) {
                    await mexc.createMarketOrder(symbol, 'sell', contracts, undefined, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                    sendTelegramAlert(`📉 SHORT ENTRY: $${ctx.price}`);
                }
            }
        }
    } catch (e) { console.error("Loop Error:", e.message); }
    finally { isTrading = false; }
}

async function recordTradeExit(side, entry, exit, size, startTime) {
    const rawPnl = side === 'LONG' ? (exit - entry) * size * globalContractSize : (entry - exit) * size * globalContractSize;
    const netPnl = rawPnl - ((entry + exit) * size * globalContractSize * takerFeeRate);
    await updateAccountEquity();
    await Trade.create({
        side, entryPrice: entry, exitPrice: exit, pnlUsd: netPnl,
        pnlPercentage: (netPnl / ((entry * size * globalContractSize) / leverage)) * 100,
        equityAfter: liveWalletBalance, isWin: netPnl > 0, startTime, endTime: new Date()
    });
    activePosition = null;
}

// ==========================================
// DASHBOARD UI
// ==========================================
app.get('/', async (req, res) => {
    try {
        const allTrades = await Trade.find().sort({ endTime: -1 });
        const recentTrades = allTrades.slice(0, 12);
        const totalPnlUsd = allTrades.reduce((sum, t) => sum + (t.pnlUsd || 0), 0).toFixed(2);
        const winRate = allTrades.length > 0 ? ((allTrades.filter(t => t.isWin).length / allTrades.length) * 100).toFixed(1) : 0;

        let posHtml = `<div class="empty-state">⚪ SCANNING FOR HIGH-PROBABILITY ENTRY</div>`;
        if (activePosition) {
            const mode = tp1Reached ? '🎯 BREAK-EVEN (RUNNER)' : '🛡️ INITIAL RISK';
            posHtml = `
            <div class="active-card pulse-border">
                <div class="card-header">
                    <h2><span class="pulse-dot ${activePosition.side === 'LONG'?'dot-green':'dot-red'}"></span> ACTIVE POSITION</h2>
                    <span class="badge ${activePosition.side==='LONG'?'badge-green':'badge-red'}">${activePosition.side}</span>
                </div>
                <div class="grid grid-cols-4 gap-4 mt-4">
                    <div class="stat-box"><span class="label">Entry</span><span class="value">$${activePosition.entryPrice.toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">PnL %</span><span class="value ${liveUnrealizedPnl>=0?'text-green':'text-red'}">${activePosition.pnlPct.toFixed(2)}%</span></div>
                    <div class="stat-box"><span class="label">PnL USD</span><span class="value ${liveUnrealizedPnl>=0?'text-green':'text-red'}">$${liveUnrealizedPnl.toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">Strategy Mode</span><span class="value text-yellow">${mode}</span></div>
                </div>
            </div>`;
        }

        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Elite Sniper V6.0</title>
                <meta http-equiv="refresh" content="8">
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
                <style>
                    :root { --bg: #0b0f19; --card: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; --green: #10b981; --red: #ef4444; --blue: #3b82f6; --yellow: #f59e0b; }
                    body { background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; padding: 30px; margin: 0; }
                    .container { max-width: 1100px; margin: auto; }
                    .grid { display: grid; gap: 15px; } .grid-cols-4 { grid-template-columns: repeat(4, 1fr); }
                    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
                    .stat-title { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px; }
                    .stat-value { font-size: 24px; font-weight: 800; }
                    .active-card { background: #0f172a; padding: 25px; border-radius: 12px; border: 1px solid #0ea5e9; margin-top: 25px; }
                    .text-green { color: var(--green); } .text-red { color: var(--red); } .text-blue { color: var(--blue); } .text-yellow { color: var(--yellow); }
                    .badge { padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 800; }
                    .badge-green { background: rgba(16, 185, 129, 0.1); color: var(--green); border: 1px solid var(--green); }
                    .badge-red { background: rgba(239, 68, 68, 0.1); color: var(--red); border: 1px solid var(--red); }
                    .stat-box { background: var(--card); padding: 12px; border-radius: 8px; border: 1px solid var(--border); }
                    .label { display: block; font-size: 10px; color: var(--muted); text-transform: uppercase; }
                    .value { font-size: 15px; font-weight: 600; }
                    table { width: 100%; border-collapse: collapse; margin-top: 20px; background: var(--card); border-radius: 10px; overflow: hidden; }
                    th { text-align: left; padding: 15px; background: #161e2e; color: var(--muted); font-size: 12px; }
                    td { padding: 15px; border-bottom: 1px solid var(--border); font-size: 14px; }
                    .empty-state { text-align: center; padding: 40px; border: 1px dashed var(--border); border-radius: 12px; color: var(--muted); margin-top: 25px; }
                    .pulse-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; animation: pulse 1.5s infinite; margin-right: 8px; }
                    .dot-green { background: var(--green); box-shadow: 0 0 8px var(--green); }
                    .dot-red { background: var(--red); box-shadow: 0 0 8px var(--red); }
                    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1 style="color:#38bdf8; margin:0;">🎯 Elite Sniper V6.0</h1>
                    <p style="color:var(--muted); font-size:12px; margin-bottom:25px;">Live Terminal • PHT: ${formatPHT(new Date())}</p>
                    
                    <div class="grid grid-cols-4">
                        <div class="card"><div class="stat-title">Wallet Balance</div><div class="stat-value">$${liveWalletBalance.toFixed(2)}</div></div>
                        <div class="card"><div class="stat-title">Active PnL</div><div class="stat-value ${liveUnrealizedPnl>=0?'text-green':'text-red'}">$${liveUnrealizedPnl.toFixed(2)}</div></div>
                        <div class="card"><div class="stat-title">Total Equity</div><div class="stat-value text-blue">$${liveTotalEquity.toFixed(2)}</div></div>
                        <div class="card"><div class="stat-title">Net Profit / WinRate</div><div class="stat-value ${totalPnlUsd>=0?'text-green':'text-red'}">$${totalPnlUsd} <span style="font-size:12px; color:var(--muted)">(${winRate}%)</span></div></div>
                    </div>

                    ${posHtml}

                    <h3 style="margin-top:30px; font-size:14px; color:var(--muted); text-transform:uppercase;">📜 Recent Performance</h3>
                    <table>
                        <thead><tr><th>Closed (PHT)</th><th>Side</th><th>PnL %</th><th>Net USD</th><th>Equity After</th></tr></thead>
                        <tbody>
                            ${recentTrades.map(t => `
                                <tr>
                                    <td style="color:var(--muted)">${formatPHT(t.endTime)}</td>
                                    <td><span class="badge ${t.side==='LONG'?'badge-green':'badge-red'}">${t.side}</span></td>
                                    <td class="${t.pnlPercentage>=0?'text-green':'text-red'}">${t.pnlPercentage.toFixed(2)}%</td>
                                    <td class="${t.pnlUsd>=0?'text-green':'text-red'}">$${t.pnlUsd.toFixed(2)}</td>
                                    <td>$${t.equityAfter.toFixed(2)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </body>
            </html>
        `);
    } catch (e) { res.send("UI Error: " + e.message); }
});

// ==========================================
// START
// ==========================================
async function startBot() {
    try {
        await mexc.loadMarkets();
        console.log("✅ TERMINAL V6 ACTIVE");
        setInterval(runBot, 10000); 
    } catch(e) { console.error("Startup Error:", e.message); }
}
app.listen(port, () => startBot());
