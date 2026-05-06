const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const { RSI, SMA, ATR, BollingerBands } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;

// ==========================================
// BOT CONFIGURATION
// ==========================================
const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskPerTradePercent = 2.5; 
const takerFeeRate = 0.0006; 
const lookbackPeriods = 30; // Look back 30 candles (2.5 hours on 5m) for Highs/Lows

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

// Optimization States
let latestMarketCtx = null;
let lastOhlcvFetchTime = 0;

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
        liveWalletBalance = balance.total['USDT'] || liveWalletBalance; 
    } catch(e) { console.error("Equity Sync Failed"); }
}

async function getMarketContext() {
    const now = Date.now();
    if (latestMarketCtx && (now - lastOhlcvFetchTime < 30000)) {
        return latestMarketCtx; 
    }

    const[ohlcv1m, ohlcv5m, ohlcv1h] = await Promise.all([
        mexc.fetchOHLCV(symbol, '1m', undefined, 60),
        mexc.fetchOHLCV(symbol, '5m', undefined, 60),
        mexc.fetchOHLCV(symbol, '1h', undefined, 200) 
    ]);
    
    const closes1m = ohlcv1m.map(c => c[4]);
    const highs5m = ohlcv5m.map(c => c[2]);
    const lows5m = ohlcv5m.map(c => c[3]);
    const closes5m = ohlcv5m.map(c => c[4]);
    const closes1h = ohlcv1h.map(c => c[4]);

    const rsi1m = RSI.calculate({ period: 14, values: closes1m }).pop();
    const bb1m = BollingerBands.calculate({ period: 20, stdDev: 2.5, values: closes1m }).pop();
    const atr5m = ATR.calculate({ period: 14, high: highs5m, low: lows5m, close: closes5m }).pop();

    // Structural Highs and Lows
    const recentHigh = Math.max(...highs5m.slice(-lookbackPeriods));
    const recentLow = Math.min(...lows5m.slice(-lookbackPeriods));
    const rangePercent = ((recentHigh - recentLow) / recentLow) * 100;

    let sma1h = null;
    if (closes1h.length >= 200) {
        sma1h = SMA.calculate({ period: 200, values: closes1h }).pop();
    } else if (closes1h.length > 0) {
        sma1h = SMA.calculate({ period: closes1h.length, values: closes1h }).pop();
    }

    latestMarketCtx = { 
        rsi: rsi1m, 
        bbUpper: bb1m.upper, 
        bbLower: bb1m.lower, 
        atr: atr5m,
        sma1h: sma1h,
        recentHigh,
        recentLow,
        rangePercent
    };
    lastOhlcvFetchTime = now;
    return latestMarketCtx;
}

async function runBot() {
    if (isTrading) return; 
    isTrading = true;
    try {
        const [ticker, positions] = await Promise.all([
            mexc.fetchTicker(symbol),
            mexc.fetchPositions([symbol])
        ]);
        currentMarketPrice = ticker.last;

        const ctx = await getMarketContext();
        if (globalContractSize === 0.0001) {
            const market = await mexc.market(symbol);
            globalContractSize = market.contractSize;
        }

        const pos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0);

        if (pos) {
            // === POSITION MANAGEMENT MODE ===
            const side = pos.side.toUpperCase();
            const entry = parseFloat(pos.entryPrice);
            const size = parseFloat(pos.contracts);
            const pnlUsd = side === 'LONG' ? (currentMarketPrice - entry) * size * globalContractSize : (entry - currentMarketPrice) * size * globalContractSize;
            
            liveMarginUsed = (entry * size * globalContractSize) / leverage;
            const pnlPct = (pnlUsd / liveMarginUsed) * 100;
            liveUnrealizedPnl = pnlUsd;

            if(!activePosition) {
                // Lock in structure at entry time
                activePosition = { side, entryPrice: entry, startTime: Date.now(), size, stopPrice: side === 'LONG' ? ctx.recentLow : ctx.recentHigh };
            }
            activePosition.pnlPct = pnlPct;

            const openOrders = await mexc.fetchOpenOrders(symbol);
            if (openOrders.length > 0) {
                await mexc.cancelAllOrders(symbol);
            }

            // Buffers to avoid "Wick Fishing" (0.15% of price)
            const structuralBuffer = currentMarketPrice * 0.0015;

            if (side === 'LONG') {
                const sl = tp1Reached ? (entry + (entry * 0.001)) : (activePosition.stopPrice - structuralBuffer);
                const tpTarget = ctx.recentHigh; // Target the recent structural top

                if (!tp1Reached && currentMarketPrice >= tpTarget) {
                    await mexc.createMarketSellOrder(symbol, Math.floor(size/2), { 'reduceOnly': true });
                    tp1Reached = true;
                    sendTelegramAlert("🎯 STRUCTURAL TP HIT: Sold 50% at recent high. SL to entry.");
                }
                if (currentMarketPrice <= sl) {
                    await mexc.createMarketSellOrder(symbol, size, { 'reduceOnly': true });
                    await recordExit(side, entry, currentMarketPrice, size, activePosition.startTime);
                    sendTelegramAlert("🚨 STOP LOSS: Structural support failed.");
                }
            } else {
                const sl = tp1Reached ? (entry - (entry * 0.001)) : (activePosition.stopPrice + structuralBuffer);
                const tpTarget = ctx.recentLow; // Target the recent structural bottom

                if (!tp1Reached && currentMarketPrice <= tpTarget) {
                    await mexc.createMarketBuyOrder(symbol, Math.floor(size/2), { 'reduceOnly': true });
                    tp1Reached = true;
                    sendTelegramAlert("🎯 STRUCTURAL TP HIT: Sold 50% at recent low. SL to entry.");
                }
                if (currentMarketPrice >= sl) {
                    await mexc.createMarketBuyOrder(symbol, size, { 'reduceOnly': true });
                    await recordExit(side, entry, currentMarketPrice, size, activePosition.startTime);
                    sendTelegramAlert("🚨 STOP LOSS: Structural resistance failed.");
                }
            }
        } else {
            // === NO POSITION: LADDERED LIMIT ORDER FISHING ===
            liveUnrealizedPnl = 0; activePosition = null; tp1Reached = false; liveMarginUsed = 0;
            
            // 1. Calculate risk distance (using structure, not just ATR)
            const longRiskDist = Math.abs(currentMarketPrice - ctx.recentLow);
            const shortRiskDist = Math.abs(currentMarketPrice - ctx.recentHigh);
            
            const totalBaseEquity = liveWalletBalance + liveMarginUsed;
            
            // Position sizing based on distance to the structural low
            const targetContracts = (totalBaseEquity * (riskPerTradePercent/100)) / (longRiskDist * globalContractSize);
            const maxAffordable = (liveWalletBalance * leverage * 0.90) / (currentMarketPrice * globalContractSize);
            const finalContracts = Math.min(targetContracts, maxAffordable);
            
            let totalQty = 0;
            try { totalQty = parseFloat(mexc.amountToPrecision(symbol, finalContracts)); } catch (e) { totalQty = Math.floor(finalContracts); }

            if (totalQty > 0 && ctx.rangePercent > 0.4) {
                const openOrders = await mexc.fetchOpenOrders(symbol);
                let needsUpdate = false;

                // Fishing points: Confluence of BB and recent extremes
                const buyTrap1 = parseFloat(mexc.priceToPrecision(symbol, Math.min(ctx.bbLower, ctx.recentLow)));
                const buyTrap2 = parseFloat(mexc.priceToPrecision(symbol, buyTrap1 * 0.9985)); // 0.15% deeper

                const sellTrap1 = parseFloat(mexc.priceToPrecision(symbol, Math.max(ctx.bbUpper, ctx.recentHigh)));
                const sellTrap2 = parseFloat(mexc.priceToPrecision(symbol, sellTrap1 * 1.0015)); // 0.15% higher

                const allowLong = ctx.sma1h ? currentMarketPrice > ctx.sma1h : true;
                const allowShort = ctx.sma1h ? currentMarketPrice < ctx.sma1h : true;

                if (openOrders.length === 0) needsUpdate = true;
                else {
                    const buyO = openOrders.find(o => o.side === 'buy');
                    if (buyO && Math.abs(parseFloat(buyO.price) - buyTrap1) / buyTrap1 > 0.002) needsUpdate = true;
                }

                if (needsUpdate) {
                    if (openOrders.length > 0) await mexc.cancelAllOrders(symbol);
                    
                    const qty1 = parseFloat(mexc.amountToPrecision(symbol, totalQty * 0.6));
                    const qty2 = parseFloat(mexc.amountToPrecision(symbol, totalQty * 0.4));

                    if (allowLong && qty1 > 0) {
                        await mexc.createOrder(symbol, 'limit', 'buy', qty1, buyTrap1, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                        await mexc.createOrder(symbol, 'limit', 'buy', qty2, buyTrap2, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                        console.log(`🪜 LADDERED BUY TRAPS: ${buyTrap1} & ${buyTrap2}`);
                    }
                    if (allowShort && qty1 > 0) {
                        await mexc.createOrder(symbol, 'limit', 'sell', qty1, sellTrap1, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                        await mexc.createOrder(symbol, 'limit', 'sell', qty2, sellTrap2, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                        console.log(`🪜 LADDERED SELL TRAPS: ${sellTrap1} & ${sellTrap2}`);
                    }
                }
            }
        }
    } catch (e) { 
        console.error(`Loop Error: ${e.message}`); 
    } finally { 
        isTrading = false; 
    }
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
// DASHBOARD UI 
// ==========================================
app.get('/', async (req, res) => {
    try {
        const allTrades = await Trade.find().sort({ endTime: -1 });
        const recentTrades = allTrades.slice(0, 15);
        const totalPnlUsd = allTrades.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
        const winRate = allTrades.length > 0 ? ((allTrades.filter(t => t.isWin).length / allTrades.length) * 100).toFixed(1) : 0;
        const displayEquity = (liveWalletBalance || 0) + (liveMarginUsed || 0) + (liveUnrealizedPnl || 0);

        let posHtml = `<div class="empty-state">🕸️ LADDERED TRAPS SET - MONITORING STRUCTURAL EXTREMES</div>`;
        if (activePosition) {
            const notionalSize = activePosition.entryPrice * activePosition.size * globalContractSize;
            const mode = tp1Reached ? '🎯 BREAK-EVEN (RUNNER)' : '🛡️ INITIAL RISK';
            const roePct = liveMarginUsed > 0 ? (liveUnrealizedPnl / liveMarginUsed) * 100 : 0;

            posHtml = `
            <div class="active-card pulse-border">
                <div class="card-header">
                    <h2><span class="pulse-dot ${activePosition.side === 'LONG'?'dot-green':'dot-red'}"></span> ACTIVE POSITION</h2>
                    <span class="badge ${activePosition.side === 'LONG' ? 'badge-green' : 'badge-red'}">${activePosition.side}</span>
                </div>
                <div class="grid grid-cols-4 gap-4 mt-4">
                    <div class="stat-box"><span class="label">Entry Price</span><span class="value">$${(activePosition.entryPrice || 0).toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">Current Price</span><span class="value">$${(currentMarketPrice || 0).toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">Unrealized PnL</span><span class="value ${liveUnrealizedPnl >= 0 ? 'text-green' : 'text-red'}">$${(liveUnrealizedPnl || 0).toFixed(2)} (${roePct.toFixed(2)}%)</span></div>
                    <div class="stat-box"><span class="label">Bot Mode</span><span class="value text-yellow">${mode}</span></div>
                    <div class="stat-box"><span class="label">Position Size (Value)</span><span class="value text-blue">$${notionalSize.toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">Locked Margin Used</span><span class="value">$${liveMarginUsed.toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">Leverage</span><span class="value">${leverage}x</span></div>
                    <div class="stat-box"><span class="label">Time in Trade</span><span class="value">${Math.floor((Date.now() - activePosition.startTime)/60000)}m</span></div>
                </div>
            </div>`;
        }

        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <title>Elite Sniper V7.5 (Laddered)</title>
                <meta http-equiv="refresh" content="5">
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
                    .stat-value { font-size: 26px; font-weight: 800; display: flex; align-items: baseline; gap: 8px; }
                    .stat-sub { font-size: 12px; font-weight: 600; color: var(--muted); margin-top: 4px; }
                    .text-green { color: var(--green); } .text-red { color: var(--red); } .text-blue { color: var(--blue); } .text-yellow { color: var(--yellow); }
                    .active-card { background: #0f172a; padding: 25px; border-radius: 12px; border: 1px solid #0ea5e9; margin-top: 25px; }
                    .card-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 15px; }
                    .card-header h2 { margin: 0; font-size: 18px; color: #38bdf8; display: flex; align-items: center; gap: 10px; }
                    .badge { padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 800; text-transform: uppercase; }
                    .badge-green { background: rgba(16, 185, 129, 0.2); color: var(--green); border: 1px solid var(--green); }
                    .badge-red { background: rgba(239, 68, 68, 0.2); color: var(--red); border: 1px solid var(--red); }
                    .stat-box { background: var(--card); padding: 12px 15px; border-radius: 8px; border: 1px solid var(--border); }
                    .stat-box .label { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; }
                    .stat-box .value { display: block; font-size: 16px; font-weight: 600; }
                    .empty-state { margin-top: 25px; padding: 40px; border: 1px dashed var(--border); color: var(--muted); border-radius: 12px; text-align: center; background: rgba(30, 41, 59, 0.3); font-weight: 600;}
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
                    <h1>🎯 Elite Sniper V7.5 Terminal</h1>
                    <div class="sub-header">Server Time (PHT): ${formatPHT(new Date())} | Laddered structural entries enabled</div>
                    
                    <div class="grid grid-cols-4 gap-4">
                        <div class="card">
                            <div class="stat-title">Available Free Balance</div>
                            <div class="stat-value">$${(liveWalletBalance || 0).toFixed(2)}</div>
                            <div class="stat-sub">+ Locked Margin: $${(liveMarginUsed || 0).toFixed(2)}</div>
                        </div>
                        <div class="card">
                            <div class="stat-title">Real-Time Account Equity</div>
                            <div class="stat-value text-blue">$${displayEquity.toFixed(2)}</div>
                            <div class="stat-sub">Available + Margin + PnL</div>
                        </div>
                        <div class="card">
                            <div class="stat-title">Active PnL</div>
                            <div class="stat-value ${liveUnrealizedPnl >= 0 ? 'text-green' : 'text-red'}">$${(liveUnrealizedPnl || 0).toFixed(2)}</div>
                        </div>
                        <div class="card">
                            <div class="stat-title">Net Profit / Win Rate</div>
                            <div class="stat-value ${totalPnlUsd >= 0 ? 'text-green':'text-red'}">$${totalPnlUsd.toFixed(2)}</div>
                            <div class="stat-sub">Win Rate: ${winRate}%</div>
                        </div>
                    </div>
                    
                    ${posHtml}
                    
                    <h3 style="margin-top:40px; color: var(--muted); font-size: 14px; text-transform: uppercase;">📜 Recent Trade Log</h3>
                    <table>
                        <tr><th>Closed At (PHT)</th><th>Side</th><th>ROE %</th><th>Net Profit</th><th>Ending Balance</th></tr>
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
    await updateAccountEquity();
    setInterval(runBot, 2500);
    setInterval(updateAccountEquity, 15000); 
}

app.listen(port, () => start());
