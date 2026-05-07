const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const { RSI, SMA, ATR } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;

// ==========================================
// CONFIGURATION & STATE
// ==========================================
let dna = {
    rsiThreshold: 30,
    atrMultiplier: 1.5,
    rewardRatio: 1.5,
    lastEvolved: 'Initialising...'
};

const SYMBOL = 'BTC/USDT:USDT';
const LEVERAGE = 10;
const RISK_PERCENT = 5.0; 
let marketInfo = {}; 

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' },
    enableRateLimit: true 
});

let isTrading = false;
let walletBalance = 0;
let lastTicker = { last: 0 };
let activePosition = null;
let lastOrderTime = 0;
let nextEvolveTime = Date.now() + 3600000;

const formatPHT = (dateInput) => {
    if (!dateInput) return 'N/A';
    return new Date(dateInput).toLocaleString('en-US', { 
        timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true 
    });
};

// ==========================================
// DATABASE SCHEMA
// ==========================================
mongoose.connect(process.env.MONGO_URI).catch(err => console.error("❌ DB ERROR:", err));
const Trade = mongoose.model('Trade', new mongoose.Schema({
    side: String, entry: Number, exit: Number, pnlUsd: Number, pnlPercent: Number, 
    equityAfter: Number, isWin: Boolean, time: { type: Date, default: Date.now },
    settings: Object
}));

// ==========================================
// EVOLUTION ENGINE
// ==========================================
async function evolve() {
    try {
        console.log("🧬 Evolution started...");
        const ohlcv = await mexc.fetchOHLCV(SYMBOL, '5m', undefined, 300);
        const closes = ohlcv.map(c => c[4]);
        const highs = ohlcv.map(c => c[2]);
        const lows = ohlcv.map(c => c[3]);

        const rsiV = RSI.calculate({ period: 14, values: closes });
        const atrV = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
        const smaV = SMA.calculate({ period: 200, values: closes });

        const testSettings = (rsiT, atrM, rr) => {
            let score = 0;
            const offset = closes.length - rsiV.length;
            for (let i = 200; i < closes.length - 20; i++) {
                const idx = i - offset;
                if (closes[i] > smaV[i - (closes.length - smaV.length)] && rsiV[idx] < rsiT) {
                    const sl = closes[i] - (atrV[idx] * atrM);
                    const tp = closes[i] + (atrV[idx] * atrM * rr);
                    for (let j = 1; j <= 20; j++) {
                        if (lows[i + j] <= sl) { score -= 1; break; }
                        if (highs[i + j] >= tp) { score += rr; break; }
                    }
                }
            }
            return score;
        };

        let bestScore = -999;
        for (let r of [25, 30, 35]) {
            for (let a of [1.2, 1.8, 2.5]) {
                for (let rr of [1.5, 2.0, 2.5]) {
                    const s = testSettings(r, a, rr);
                    if (s > bestScore) {
                        bestScore = s;
                        dna = { rsiThreshold: r, atrMultiplier: a, rewardRatio: rr, lastEvolved: formatPHT(new Date()) };
                    }
                }
            }
        }
        nextEvolveTime = Date.now() + 3600000;
    } catch (e) { console.error("Evolution Error:", e.message); }
}

// ==========================================
// TRADING CORE
// ==========================================
async function tick() {
    if (isTrading) return;
    isTrading = true;
    try {
        const [ticker, pos, ohlcv] = await Promise.all([
            mexc.fetchTicker(SYMBOL),
            mexc.fetchPositions([SYMBOL]),
            mexc.fetchOHLCV(SYMBOL, '1m', undefined, 210)
        ]);

        lastTicker = ticker;
        const price = Number(ticker.last);
        const rawPos = pos.find(p => p.symbol === SYMBOL && parseFloat(p.contracts) > 0);

        if (rawPos) {
            // SYNC POSITION STATE
            const side = rawPos.side.toUpperCase();
            const entryPrice = Number(rawPos.entryPrice);
            const contracts = Number(rawPos.contracts);
            const contractSize = marketInfo.contractSize || 0.0001;
            
            activePosition = {
                side, entry: entryPrice, size: contracts,
                pnlUsd: (side === 'LONG' ? (price - entryPrice) : (entryPrice - price)) * contracts * contractSize
            };
            activePosition.roe = (activePosition.pnlUsd / ((entryPrice * contracts * contractSize) / LEVERAGE)) * 100;

            // TP/SL CALCULATION
            const atr = ATR.calculate({ period: 14, high: ohlcv.map(c=>c[2]), low: ohlcv.map(c=>c[3]), close: ohlcv.map(c=>c[4]) }).pop();
            const stopDist = atr * dna.atrMultiplier;
            const sl = side === 'LONG' ? entryPrice - stopDist : entryPrice + stopDist;
            const tp = side === 'LONG' ? entryPrice + (stopDist * dna.rewardRatio) : entryPrice - (stopDist * dna.rewardRatio);

            const exitHit = side === 'LONG' ? (price <= sl || price >= tp) : (price >= sl || price <= tp);

            if (exitHit) {
                console.log(`Closing ${side} at ${price}`);
                await mexc.createOrder(SYMBOL, 'market', side === 'LONG' ? 'sell' : 'buy', contracts, undefined, { 'reduceOnly': true });
                await Trade.create({ 
                    side, entry: entryPrice, exit: price, 
                    pnlUsd: activePosition.pnlUsd, pnlPercent: activePosition.roe, 
                    equityAfter: walletBalance + activePosition.pnlUsd, isWin: activePosition.pnlUsd > 0,
                    settings: dna
                });
                activePosition = null;
                lastOrderTime = Date.now(); // Cooldown
            }
        } else {
            activePosition = null;
            // CHECK ENTRY (Cooldown 5 mins)
            if (Date.now() - lastOrderTime > 300000) {
                const closes = ohlcv.map(c => c[4]);
                const rsi = RSI.calculate({ period: 14, values: closes }).pop();
                const sma = SMA.calculate({ period: 200, values: closes }).pop();
                const atr = ATR.calculate({ period: 14, high: ohlcv.map(c=>c[2]), low: ohlcv.map(c=>c[3]), close: closes }).pop();

                let action = null;
                if (price > sma && rsi < dna.rsiThreshold) action = 'LONG';
                if (price < sma && rsi > (100 - dna.rsiThreshold)) action = 'SHORT';

                if (action) {
                    const riskAmount = walletBalance * (RISK_PERCENT / 100);
                    const contractSize = marketInfo.contractSize || 0.0001;
                    // Position sizing based on ATR risk
                    let qty = (riskAmount * LEVERAGE) / (price * contractSize);
                    qty = parseFloat(mexc.amountToPrecision(SYMBOL, qty));

                    if (qty > 0) {
                        const params = { 'openType': 1, 'positionType': action === 'LONG' ? 1 : 2 };
                        console.log(`Opening ${action} Qty: ${qty}`);
                        await mexc.createOrder(SYMBOL, 'market', action === 'LONG' ? 'buy' : 'sell', qty, undefined, params);
                        lastOrderTime = Date.now();
                    }
                }
            }
        }
    } catch (e) { console.error("Tick Error:", e.message); }
    finally { isTrading = false; }
}

// ==========================================
// DASHBOARD UI
// ==========================================
app.get('/', async (req, res) => {
    try {
        const allTrades = await Trade.find().sort({ time: -1 }).limit(10);
        const stats = await Trade.aggregate([{ $group: { _id: null, total: { $sum: "$pnlUsd" }, wins: { $sum: { $cond: ["$isWin", 1, 0] } }, count: { $sum: 1 } } }]);
        const totalPnl = stats[0]?.total || 0;
        const winRate = stats[0]?.count > 0 ? ((stats[0].wins / stats[0].count) * 100).toFixed(1) : 0;
        const nextEv = Math.round((nextEvolveTime - Date.now()) / 60000);

        let activeCard = `<div class="card active-card"><h2 style="color:var(--muted); text-align:center; letter-spacing:2px;">SCANNING SIGNALS...</h2></div>`;

        if (activePosition) {
            activeCard = `
            <div class="card active-card pulse-border">
                <div class="card-header" style="display:flex; justify-content:space-between; align-items:center;">
                    <h2 style="margin:0;"><span class="pulse-dot ${activePosition.side === 'LONG'?'dot-green':'dot-red'}"></span> ACTIVE ${activePosition.side}</h2>
                    <span class="badge ${activePosition.roe >= 0 ? 'badge-green' : 'badge-red'}">${activePosition.roe.toFixed(2)}%</span>
                </div>
                <div class="grid grid-cols-4 gap-4 mt-4">
                    <div class="stat-box"><span class="label">Entry</span><span class="value">$${activePosition.entry.toFixed(1)}</span></div>
                    <div class="stat-box"><span class="label">Cur. Price</span><span class="value">$${lastTicker.last.toFixed(1)}</span></div>
                    <div class="stat-box"><span class="label">PnL USD</span><span class="value ${activePosition.pnlUsd >= 0 ? 'text-green' : 'text-red'}">$${activePosition.pnlUsd.toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">Size</span><span class="value">${activePosition.size} Cont.</span></div>
                </div>
            </div>`;
        }

        res.send(`
            <!DOCTYPE html><html><head><title>Elite Sniper V10.5</title><meta http-equiv="refresh" content="5">
            <style>
                :root { --bg: #0b0f19; --card: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; --green: #10b981; --red: #ef4444; --blue: #3b82f6; }
                body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', sans-serif; padding: 20px; margin: 0; }
                .container { max-width: 900px; margin: auto; }
                .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
                .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 15px; margin-bottom: 15px; }
                .stat-title { color: var(--muted); font-size: 11px; text-transform: uppercase; font-weight: 600; }
                .stat-value { font-size: 22px; font-weight: 800; margin-top: 5px; letter-spacing: -0.5px; }
                .active-card { border-color: var(--blue); background: #0f172a; box-shadow: 0 0 20px rgba(59, 130, 246, 0.15); }
                .stat-box { background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px; text-align: center; }
                .label { font-size: 10px; color: var(--muted); text-transform: uppercase; display: block; margin-bottom: 4px; }
                .value { font-size: 15px; font-weight: 700; }
                .text-green { color: var(--green); } .text-red { color: var(--red); }
                .badge { padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: bold; }
                .badge-green { background: rgba(16,185,129,0.2); color: var(--green); }
                .badge-red { background: rgba(239,68,68,0.2); color: var(--red); }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th { text-align: left; font-size: 11px; color: var(--muted); padding: 12px; border-bottom: 1px solid var(--border); }
                td { padding: 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
                .pulse-dot { height: 10px; width: 10px; border-radius: 50%; display: inline-block; margin-right: 8px; }
                .dot-green { background: var(--green); box-shadow: 0 0 8px var(--green); }
                .dot-red { background: var(--red); box-shadow: 0 0 8px var(--red); }
                .pulse-border { animation: border-pulse 2s infinite; }
                @keyframes border-pulse { 0%, 100% { border-color: var(--blue); } 50% { border-color: var(--border); } }
                .dna-info { font-size: 11px; background: #111827; padding: 10px; border-radius: 8px; display: flex; justify-content: space-around; margin-top: 10px; border: 1px solid var(--border); }
            </style></head>
            <body><div class="container">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                    <h2 style="margin:0; color:var(--blue);">🎯 SNIPER V10.5 <span style="font-size:12px; color:var(--muted); font-weight:normal;">/ PHT</span></h2>
                    <div class="badge-green badge">SYSTEM LIVE</div>
                </div>
                <div class="grid">
                    <div class="card"><div class="stat-title">Wallet</div><div class="stat-value">$${walletBalance.toFixed(2)}</div></div>
                    <div class="card"><div class="stat-title">BTC Price</div><div class="stat-value">$${lastTicker.last.toLocaleString()}</div></div>
                    <div class="card"><div class="stat-title">Net Profit</div><div class="stat-value ${totalPnl >= 0 ? 'text-green' : 'text-red'}">$${totalPnl.toFixed(2)}</div></div>
                    <div class="card"><div class="stat-title">Win Rate</div><div class="stat-value">${winRate}%</div></div>
                </div>
                ${activeCard}
                <div class="card">
                    <h3 style="margin: 0 0 10px 0; font-size: 16px;">Current DNA Strategy</h3>
                    <div class="dna-info">
                        <span>RSI Threshold: <b>${dna.rsiThreshold}</b></span>
                        <span>ATR Multi: <b>${dna.atrMultiplier}x</b></span>
                        <span>Reward Ratio: <b>${dna.rewardRatio}x</b></span>
                        <span>Next Evolution: <b>${nextEv}m</b></span>
                    </div>
                </div>
                <div class="card">
                    <h3 style="margin: 0 0 10px 0; font-size: 16px;">Recent Trades</h3>
                    <table><tr><th>Time (PHT)</th><th>Side</th><th>PnL %</th><th>PnL USD</th><th>Status</th></tr>
                    ${allTrades.map(t => `<tr><td>${formatPHT(t.time)}</td><td><span class="badge ${t.side==='LONG'?'badge-green':'badge-red'}">${t.side}</span></td><td class="${t.pnlPercent>=0?'text-green':'text-red'}">${t.pnlPercent.toFixed(2)}%</td><td class="${t.pnlUsd>=0?'text-green':'text-red'}">$${t.pnlUsd.toFixed(2)}</td><td>${t.isWin?'✅':'❌'}</td></tr>`).join('')}
                    </table>
                </div>
                <p style="text-align:center; font-size:11px; color:var(--muted);">DNA Updated: ${dna.lastEvolved} | Server Time: ${formatPHT(new Date())}</p>
            </div></body></html>`);
    } catch (e) { res.send(`Dashboard Syncing...`); }
});

// ==========================================
// STARTUP
// ==========================================
async function start() {
    try {
        const markets = await mexc.loadMarkets();
        marketInfo = markets[SYMBOL];
        console.log(`Connected to MEXC. Contract Size: ${marketInfo.contractSize}`);
        
        const b = await mexc.fetchBalance();
        walletBalance = b.total['USDT'] || 0;
        
        await evolve(); 
        setInterval(tick, 5000);           
        setInterval(evolve, 3600000);      
        setInterval(async () => {          
            try { const b = await mexc.fetchBalance(); walletBalance = b.total['USDT'] || 0; } catch(e) {}
        }, 30000);
    } catch (e) { 
        console.error("Startup Failed:", e.message); 
        setTimeout(start, 10000); 
    }
}

app.listen(port, () => start());
