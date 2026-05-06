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
const lookbackPeriods = 30; 

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

// STABILITY STATES (Fixes the Spamming)
let lastOrderUpdateTime = 0; 
const UPDATE_COOLDOWN = 5 * 60 * 1000; // 5 minute minimum stay for orders
const DRIFT_THRESHOLD = 0.004; // 0.4% price drift before adjusting
let latestMarketCtx = null;
let lastOhlcvFetchTime = 0;

let botThinking = {
    trend: 'Analysing...',
    rsi: 0,
    bbStatus: 'Stable',
    allowLong: false,
    allowShort: false,
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
    if (latestMarketCtx && (now - lastOhlcvFetchTime < 20000)) return latestMarketCtx; 

    const[ohlcv1m, ohlcv5m, ohlcv1h] = await Promise.all([
        mexc.fetchOHLCV(symbol, '1m', undefined, 60),
        mexc.fetchOHLCV(symbol, '5m', undefined, 60),
        mexc.fetchOHLCV(symbol, '1h', undefined, 200) 
    ]);
    
    const highs5m = ohlcv5m.map(c => c[2]);
    const lows5m = ohlcv5m.map(c => c[3]);
    const closes5m = ohlcv5m.map(c => c[4]);
    const closes1m = ohlcv1m.map(c => c[4]);

    const rsi1m = RSI.calculate({ period: 14, values: closes1m }).pop();
    const bb1m = BollingerBands.calculate({ period: 20, stdDev: 2.5, values: closes1m }).pop();
    const atr5m = ATR.calculate({ period: 14, high: highs5m, low: lows5m, close: closes5m }).pop();

    const recentHigh = Math.max(...highs5m.slice(-lookbackPeriods));
    const recentLow = Math.min(...lows5m.slice(-lookbackPeriods));

    let sma1h = ohlcv1h.length >= 200 
        ? SMA.calculate({ period: 200, values: ohlcv1h.map(c => c[4]) }).pop() 
        : SMA.calculate({ period: ohlcv1h.length, values: ohlcv1h.map(c => c[4]) }).pop();

    latestMarketCtx = { rsi: rsi1m, bbUpper: bb1m.upper, bbLower: bb1m.lower, atr: atr5m, sma1h: sma1h, recentHigh, recentLow };
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
            const side = pos.side.toUpperCase();
            const entry = parseFloat(pos.entryPrice);
            const size = parseFloat(pos.contracts);
            liveMarginUsed = (entry * size * globalContractSize) / leverage;
            liveUnrealizedPnl = (side === 'LONG' ? (currentMarketPrice - entry) : (entry - currentMarketPrice)) * size * globalContractSize;
            
            if(!activePosition) activePosition = { side, entryPrice: entry, startTime: Date.now(), size, stopPrice: side === 'LONG' ? ctx.recentLow : ctx.recentHigh };
            
            const openOrders = await mexc.fetchOpenOrders(symbol);
            if (openOrders.length > 0) await mexc.cancelAllOrders(symbol);

            const buffer = currentMarketPrice * 0.0015;

            if (side === 'LONG') {
                const sl = tp1Reached ? (entry + (entry * 0.001)) : (activePosition.stopPrice - buffer);
                if (!tp1Reached && currentMarketPrice >= ctx.recentHigh) {
                    await mexc.createMarketSellOrder(symbol, Math.floor(size/2), { 'reduceOnly': true, 'openType': 1, 'positionType': 1, 'leverage': leverage });
                    tp1Reached = true;
                    sendTelegramAlert("🎯 TP HIT: Sold 50% Long.");
                }
                if (currentMarketPrice <= sl) {
                    await mexc.createMarketSellOrder(symbol, size, { 'reduceOnly': true, 'openType': 1, 'positionType': 1, 'leverage': leverage });
                    await recordExit(side, entry, currentMarketPrice, size, activePosition.startTime);
                }
            } else {
                const sl = tp1Reached ? (entry - (entry * 0.001)) : (activePosition.stopPrice + buffer);
                if (!tp1Reached && currentMarketPrice <= ctx.recentLow) {
                    await mexc.createMarketBuyOrder(symbol, Math.floor(size/2), { 'reduceOnly': true, 'openType': 1, 'positionType': 2, 'leverage': leverage });
                    tp1Reached = true;
                    sendTelegramAlert("🎯 TP HIT: Sold 50% Short.");
                }
                if (currentMarketPrice >= sl) {
                    await mexc.createMarketBuyOrder(symbol, size, { 'reduceOnly': true, 'openType': 1, 'positionType': 2, 'leverage': leverage });
                    await recordExit(side, entry, currentMarketPrice, size, activePosition.startTime);
                }
            }
        } else {
            liveUnrealizedPnl = 0; activePosition = null; tp1Reached = false; liveMarginUsed = 0;
            const openOrders = await mexc.fetchOpenOrders(symbol);
            const now = Date.now();

            const trendUp = ctx.sma1h ? currentMarketPrice > ctx.sma1h : true;
            const trendDown = ctx.sma1h ? currentMarketPrice < ctx.sma1h : true;
            
            // HYSTERESIS LOGIC: Add buffer to RSI to stop flickering
            const allowLong = trendUp || ctx.rsi < 32; // Buffer: must drop below 32
            const allowShort = trendDown || ctx.rsi > 68; // Buffer: must pump above 68

            const buyPrice = parseFloat(mexc.priceToPrecision(symbol, Math.min(ctx.bbLower, ctx.recentLow)));
            const sellPrice = parseFloat(mexc.priceToPrecision(symbol, Math.max(ctx.bbUpper, ctx.recentHigh)));

            botThinking = {
                trend: trendUp ? 'BULLISH 📈' : 'BEARISH 📉',
                rsi: ctx.rsi.toFixed(1),
                bbStatus: currentMarketPrice > ctx.bbUpper ? 'Overbought' : (currentMarketPrice < ctx.bbLower ? 'Oversold' : 'Neutral'),
                allowLong, allowShort, buyTarget: buyPrice, sellTarget: sellPrice, lastUpdate: now
            };

            let needsUpdate = false;
            if (openOrders.length === 0) {
                needsUpdate = true;
            } else {
                // If a change in side permission occurs (e.g., RSI falls from 70 to 60)
                const hasLong = openOrders.some(o => o.side === 'buy');
                const hasShort = openOrders.some(o => o.side === 'sell');
                
                if (allowLong !== hasLong || allowShort !== hasShort) {
                    needsUpdate = true;
                } else if (now - lastOrderUpdateTime > UPDATE_COOLDOWN) {
                    // Check if price drifted too far from the original limit orders
                    const sampleOrder = openOrders[0];
                    const target = sampleOrder.side === 'buy' ? buyPrice : sellPrice;
                    const drift = Math.abs(parseFloat(sampleOrder.price) - target) / target;
                    if (drift > DRIFT_THRESHOLD) needsUpdate = true;
                }
            }

            if (needsUpdate) {
                if (openOrders.length > 0) await mexc.cancelAllOrders(symbol);
                const totalBaseEquity = liveWalletBalance + liveMarginUsed;
                const riskDist = ctx.atr * 2; 
                const targetContracts = (totalBaseEquity * (riskPerTradePercent/100)) / (riskDist * globalContractSize);
                const maxAffordable = (liveWalletBalance * leverage * 0.9) / (currentMarketPrice * globalContractSize);
                const qty = Math.min(targetContracts, maxAffordable);
                
                const q1 = parseFloat(mexc.amountToPrecision(symbol, qty * 0.6));
                const q2 = parseFloat(mexc.amountToPrecision(symbol, qty * 0.4));

                if (q1 > 0) {
                    if (allowLong) {
                        await mexc.createOrder(symbol, 'limit', 'buy', q1, buyPrice, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                        await mexc.createOrder(symbol, 'limit', 'buy', q2, buyPrice * 0.998, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                    }
                    if (allowShort) {
                        await mexc.createOrder(symbol, 'limit', 'sell', q1, sellPrice, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                        await mexc.createOrder(symbol, 'limit', 'sell', q2, sellPrice * 1.002, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                    }
                    lastOrderUpdateTime = now; 
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
// DASHBOARD
// ==========================================
app.get('/', async (req, res) => {
    try {
        const allTrades = await Trade.find().sort({ endTime: -1 });
        const recentTrades = allTrades.slice(0, 15);
        const totalPnlUsd = allTrades.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
        const winRate = allTrades.length > 0 ? ((allTrades.filter(t => t.isWin).length / allTrades.length) * 100).toFixed(1) : 0;
        const displayEquity = (liveWalletBalance || 0) + (liveMarginUsed || 0) + (liveUnrealizedPnl || 0);

        let posHtml = `<div class="active-card"><div class="card-header"><h2>🧠 LOGIC MATRIX</h2><span>REFRESHED: ${Math.floor((Date.now() - botThinking.lastUpdate)/1000)}s ago</span></div>
        <div class="grid grid-cols-4 gap-4 mt-4">
            <div class="stat-box"><span class="label">1H Trend</span><span class="value">${botThinking.trend}</span></div>
            <div class="stat-box"><span class="label">1M RSI</span><span class="value">${botThinking.rsi}</span></div>
            <div class="stat-box"><span class="label">Entry Valid</span><span class="value">L: ${botThinking.allowLong ? '✅' : '❌'} | S: ${botThinking.allowShort ? '✅' : '❌'}</span></div>
            <div class="stat-box"><span class="label">Targets</span><span class="value">$${botThinking.buyTarget} / $${botThinking.sellTarget}</span></div>
        </div></div>`;

        if (activePosition) {
            const roePct = liveMarginUsed > 0 ? (liveUnrealizedPnl / liveMarginUsed) * 100 : 0;
            posHtml = `<div class="active-card pulse-border"><div class="card-header"><h2>ACTIVE ${activePosition.side}</h2></div>
            <div class="grid grid-cols-4 gap-4 mt-4">
                <div class="stat-box"><span class="label">Entry</span><span class="value">$${activePosition.entryPrice.toFixed(2)}</span></div>
                <div class="stat-box"><span class="label">PnL</span><span class="value ${liveUnrealizedPnl >= 0 ? 'text-green' : 'text-red'}">$${liveUnrealizedPnl.toFixed(2)} (${roePct.toFixed(2)}%)</span></div>
            </div></div>`;
        }

        res.send(`<!DOCTYPE html><html lang="en"><head><title>Elite Sniper V7.8</title><meta http-equiv="refresh" content="5">
        <style>:root { --bg: #0b0f19; --card: #1e293b; --text: #f8fafc; --green: #10b981; --red: #ef4444; }
        body { background: var(--bg); color: var(--text); font-family: sans-serif; padding: 20px; }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
        .card { background: var(--card); padding: 15px; border-radius: 8px; border: 1px solid #334155; }
        .active-card { background: #0f172a; border: 1px solid #0ea5e9; padding: 20px; margin-top: 20px; border-radius: 8px; }
        .stat-box { background: #1e293b; padding: 10px; border-radius: 5px; } .label { font-size: 10px; color: #94a3b8; } .value { font-weight: bold; }
        .text-green { color: var(--green); } .text-red { color: var(--red); }
        table { width: 100%; margin-top: 20px; border-collapse: collapse; } th, td { padding: 10px; text-align: left; border-bottom: 1px solid #334155; }
        </style></head><body>
        <h1>🎯 Elite Sniper V7.8</h1>
        <div class="grid"><div class="card">Equity: $${displayEquity.toFixed(2)}</div><div class="card">Win Rate: ${winRate}%</div><div class="card">Net: $${totalPnlUsd.toFixed(2)}</div><div class="card">Price: $${currentMarketPrice}</div></div>
        ${posHtml}
        <table><tr><th>Time (PHT)</th><th>Side</th><th>PnL %</th><th>PnL $</th></tr>
        ${recentTrades.map(t => `<tr><td>${formatPHT(t.endTime)}</td><td>${t.side}</td><td class="${t.pnlUsd > 0 ? 'text-green' : 'text-red'}">${t.pnlPercentage.toFixed(2)}%</td><td class="${t.pnlUsd > 0 ? 'text-green' : 'text-red'}">$${t.pnlUsd.toFixed(2)}</td></tr>`).join('')}
        </table></body></html>`);
    } catch (e) { res.send(`Error: ${e.message}`); }
});

async function start() {
    try {
        await mexc.loadMarkets();
        await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 1 }); 
        await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 2 });
        await updateAccountEquity();
        setInterval(runBot, 3000);
        setInterval(updateAccountEquity, 15000); 
        console.log("🚀 V7.8 Live. Stability Active.");
    } catch (e) { console.error("Startup Error:", e.message); }
}

app.listen(port, () => start());
