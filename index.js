const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const { RSI, SMA, ATR } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;

// ==========================================
// EVOLVING PARAMETERS & STATE
// ==========================================
let dna = {
    rsiThreshold: 30,
    atrMultiplier: 1.5,
    rewardRatio: 1.5,
    lastEvolved: 'Never'
};

let botStatus = { score: 0, lastTick: Date.now() };

const SYMBOL = 'BTC/USDT:USDT';
const LEVERAGE = 10;
const RISK_PERCENT = 5.0; 
const TAKER_FEE = 0.0006;

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' },
    enableRateLimit: true 
});

let isTrading = false;
let walletBalance = 0;
let lastTicker = { last: 0 };
let contractSize = 0.0001; 
let lastOrderTime = 0; 
let activePosition = null;

// ==========================================
// DATABASE SCHEMA
// ==========================================
mongoose.connect(process.env.MONGO_URI).catch(err => console.error("❌ DB ERROR:", err));
const Trade = mongoose.model('Trade', new mongoose.Schema({
    side: String, entry: Number, exit: Number, pnlUsd: Number, pnlPercent: Number, 
    equityAfter: Number, isWin: Boolean, time: { type: Date, default: Date.now }
}));

// ==========================================
// EVOLUTION ENGINE (Analyzes both Long & Short)
// ==========================================
async function evolve() {
    try {
        const ohlcv = await mexc.fetchOHLCV(SYMBOL, '5m', undefined, 288);
        const closes = ohlcv.map(c => c[4]);
        const highs = ohlcv.map(c => c[2]);
        const lows = ohlcv.map(c => c[3]);

        const rsiV = RSI.calculate({ period: 14, values: closes });
        const atrV = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
        const smaV = SMA.calculate({ period: 200, values: closes });

        const offsetRSI = closes.length - rsiV.length;
        const offsetSMA = closes.length - smaV.length;

        const testSettings = (rsiT, atrM, rr) => {
            let score = 0;
            for (let i = 200; i < closes.length - 15; i++) {
                const price = closes[i];
                const rsi = rsiV[i - offsetRSI];
                const sma = smaV[i - offsetSMA];
                const atr = atrV[i - offsetRSI];
                
                // Test LONG
                if (price > sma && rsi < rsiT) {
                    const sl = price - (atr * atrM);
                    const tp = price + (atr * atrM * rr);
                    for (let j = 1; j <= 12; j++) {
                        if (lows[i + j] <= sl) { score -= 1; break; }
                        if (highs[i + j] >= tp) { score += rr; break; }
                    }
                }
                // Test SHORT
                if (price < sma && rsi > (100 - rsiT)) {
                    const sl = price + (atr * atrM);
                    const tp = price - (atr * atrM * rr);
                    for (let j = 1; j <= 12; j++) {
                        if (highs[i + j] >= sl) { score -= 1; break; }
                        if (lows[i + j] <= tp) { score += rr; break; }
                    }
                }
            }
            return score;
        };

        let bestScore = -999;
        for (let r of [25, 30, 35]) {
            for (let a of [1.2, 1.5, 2.0]) {
                for (let rr of [1.5, 1.8, 2.2]) {
                    const s = testSettings(r, a, rr);
                    if (s > bestScore) {
                        bestScore = s;
                        dna = { rsiThreshold: r, atrMultiplier: a, rewardRatio: rr, lastEvolved: new Date().toLocaleString() };
                    }
                }
            }
        }
        console.log("🧬 DNA Updated (Bi-Directional Optimization Complete)");
    } catch (e) { console.error("Evolution Error:", e.message); }
}

// ==========================================
// TRADING TICKER (Long & Short Logic)
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
            const side = rawPos.side.toUpperCase();
            activePosition = {
                side: side,
                entry: Number(rawPos.entryPrice),
                size: Number(rawPos.contracts),
                pnlUsd: (side === 'LONG' ? (price - Number(rawPos.entryPrice)) : (Number(rawPos.entryPrice) - price)) * Number(rawPos.contracts) * contractSize
            };
            activePosition.roe = (activePosition.pnlUsd / ((activePosition.entry * activePosition.size * contractSize) / LEVERAGE)) * 100;

            const atr = ATR.calculate({ period: 14, high: ohlcv.map(c=>c[2]), low: ohlcv.map(c=>c[3]), close: ohlcv.map(c=>c[4]) }).pop();
            const stopDist = atr * dna.atrMultiplier;
            
            // SL/TP logic for both sides
            const sl = side === 'LONG' ? activePosition.entry - stopDist : activePosition.entry + stopDist;
            const tp = side === 'LONG' ? activePosition.entry + (stopDist * dna.rewardRatio) : activePosition.entry - (stopDist * dna.rewardRatio);

            const exitCondition = side === 'LONG' ? (price <= sl || price >= tp) : (price >= sl || price <= tp);

            if (exitCondition) {
                const orderSide = side === 'LONG' ? 'sell' : 'buy';
                await mexc.createOrder(SYMBOL, 'market', orderSide, activePosition.size, undefined, { 'reduceOnly': true });
                await Trade.create({ 
                    side: side, entry: activePosition.entry, exit: price, 
                    pnlUsd: activePosition.pnlUsd, pnlPercent: activePosition.roe, 
                    equityAfter: walletBalance + activePosition.pnlUsd, isWin: activePosition.pnlUsd > 0 
                });
                activePosition = null;
                console.log(`💰 Closed ${side} at ${price}`);
            }
        } else if (Date.now() - lastOrderTime > 60000) {
            const closes = ohlcv.map(c => c[4]);
            const rsi = RSI.calculate({ period: 14, values: closes }).pop();
            const sma = SMA.calculate({ period: 200, values: closes }).pop();
            const atr = ATR.calculate({ period: 14, high: ohlcv.map(c=>c[2]), low: ohlcv.map(c=>c[3]), close: closes }).pop();

            let action = null;
            let orderSide = null;

            // LONG CONDITION
            if (price > sma && rsi < dna.rsiThreshold) {
                action = 'LONG';
                orderSide = 'buy';
            } 
            // SHORT CONDITION
            else if (price < sma && rsi > (100 - dna.rsiThreshold)) {
                action = 'SHORT';
                orderSide = 'sell';
            }

            if (action) {
                const riskAmount = walletBalance * (RISK_PERCENT / 100);
                let qty = Math.floor(riskAmount / (atr * dna.atrMultiplier * contractSize));
                const maxAfford = Math.floor((walletBalance * LEVERAGE * 0.8) / (price * contractSize));
                if (qty > maxAfford) qty = maxAfford;

                if (qty >= 1) {
                    // Position Type: 1 for Long, 2 for Short (MEXC Hedge Mode)
                    const params = { 'openType': 1, 'positionType': action === 'LONG' ? 1 : 2 };
                    await mexc.createOrder(SYMBOL, 'market', orderSide, qty, undefined, params);
                    lastOrderTime = Date.now();
                    console.log(`🚀 Opening ${action} | Qty: ${qty}`);
                }
            }
        }
    } catch (e) { console.error("Tick Error:", e.message); }
    finally { isTrading = false; }
}

// ==========================================
// DASHBOARD UI (The Matrix Style)
// ==========================================
app.get('/', async (req, res) => {
    try {
        const allTrades = await Trade.find().sort({ time: -1 }).limit(10);
        const totalPnl = (await Trade.find()).reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
        const winCount = await Trade.countDocuments({ isWin: true });
        const totalCount = await Trade.countDocuments();
        const winRate = totalCount > 0 ? ((winCount / totalCount) * 100).toFixed(1) : 0;

        let activeCard = `<div class="card active-card"><h2 style="color:var(--muted); text-align:center;">SCANNING FOR ENTRIES...</h2></div>`;

        if (activePosition) {
            activeCard = `
            <div class="card active-card pulse-border">
                <div class="card-header">
                    <h2><span class="pulse-dot ${activePosition.side === 'LONG'?'dot-green':'dot-red'}"></span> ACTIVE ${activePosition.side}</h2>
                    <span class="badge ${activePosition.side === 'LONG' ? 'badge-green' : 'badge-red'}">${activePosition.side}</span>
                </div>
                <div class="grid grid-cols-4 gap-4 mt-4">
                    <div class="stat-box"><span class="label">Entry</span><span class="value">$${activePosition.entry.toFixed(1)}</span></div>
                    <div class="stat-box"><span class="label">ROE %</span><span class="value ${activePosition.roe >= 0 ? 'text-green' : 'text-red'}">${activePosition.roe.toFixed(2)}%</span></div>
                    <div class="stat-box"><span class="label">PnL USD</span><span class="value ${activePosition.pnlUsd >= 0 ? 'text-green' : 'text-red'}">$${activePosition.pnlUsd.toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">Size</span><span class="value">${activePosition.size} Cont.</span></div>
                </div>
            </div>`;
        }

        res.send(`
            <!DOCTYPE html><html><head><title>Elite Sniper V10.2</title><meta http-equiv="refresh" content="3">
            <style>
                :root { --bg: #0b0f19; --card: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; --green: #10b981; --red: #ef4444; --blue: #3b82f6; }
                body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', sans-serif; padding: 20px; }
                .container { max-width: 1000px; margin: auto; }
                .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; }
                .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
                .stat-title { color: var(--muted); font-size: 11px; text-transform: uppercase; }
                .stat-value { font-size: 24px; font-weight: 800; margin-top: 5px; }
                .active-card { border-color: var(--blue); background: #0f172a; }
                .stat-box { background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px; text-align: center; }
                .label { font-size: 10px; color: var(--muted); text-transform: uppercase; }
                .value { font-size: 16px; font-weight: 600; display: block; }
                .text-green { color: var(--green); } .text-red { color: var(--red); }
                .badge { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
                .badge-green { background: rgba(16,185,129,0.2); color: var(--green); }
                .badge-red { background: rgba(239,68,68,0.2); color: var(--red); }
                table { width: 100%; border-collapse: collapse; }
                th { text-align: left; font-size: 12px; color: var(--muted); padding: 12px; border-bottom: 1px solid var(--border); }
                td { padding: 12px; border-bottom: 1px solid var(--border); font-size: 14px; }
                .pulse-dot { height: 8px; width: 8px; border-radius: 50%; display: inline-block; margin-right: 5px; }
                .dot-green { background: var(--green); box-shadow: 0 0 8px var(--green); }
                .dot-red { background: var(--red); box-shadow: 0 0 8px var(--red); }
                .pulse-border { animation: border-pulse 2s infinite; }
                @keyframes border-pulse { 0%, 100% { border-color: var(--blue); } 50% { border-color: var(--border); } }
            </style></head>
            <body><div class="container">
                <h1 style="text-align:center; color:var(--blue);">🎯 ELITE SNIPER V10.2 (BTC)</h1>
                <div class="grid">
                    <div class="card"><div class="stat-title">Wallet Balance</div><div class="stat-value">$${walletBalance.toFixed(2)}</div></div>
                    <div class="card"><div class="stat-title">BTC Price</div><div class="stat-value">$${lastTicker.last}</div></div>
                    <div class="card"><div class="stat-title">Net Profit</div><div class="stat-value ${totalPnl >= 0 ? 'text-green' : 'text-red'}">$${totalPnl.toFixed(2)}</div></div>
                    <div class="card"><div class="stat-title">Win Rate</div><div class="stat-value">${winRate}%</div></div>
                </div>
                ${activeCard}
                <div class="card">
                    <h3 style="margin-top:0;">Trade History</h3>
                    <table><tr><th>Time</th><th>Side</th><th>PnL %</th><th>PnL USD</th><th>Equity</th></tr>
                    ${allTrades.map(t => `<tr><td>${t.time.toLocaleTimeString()}</td><td><span class="badge ${t.side==='LONG'?'badge-green':'badge-red'}">${t.side}</span></td><td class="${t.pnlPercent>=0?'text-green':'text-red'}">${t.pnlPercent.toFixed(2)}%</td><td class="${t.pnlUsd>=0?'text-green':'text-red'}">$${t.pnlUsd.toFixed(2)}</td><td>$${(t.equityAfter || 0).toFixed(2)}</td></tr>`).join('')}
                    </table>
                </div>
                <div style="text-align:center; font-size:11px; color:var(--muted);">
                    DNA: RSI Target ${dna.rsiThreshold} | ATR Multiplier ${dna.atrMultiplier} | RR ${dna.rewardRatio}<br>
                    Last Evolved: ${dna.lastEvolved}
                </div>
            </div></body></html>`);
    } catch (e) { res.send("UI Error: " + e.message); }
});

// ==========================================
// STARTUP
// ==========================================
async function start() {
    try {
        const markets = await mexc.loadMarkets();
        contractSize = markets[SYMBOL].contractSize;
        const bal = await mexc.fetchBalance();
        walletBalance = bal.total['USDT'] || 0;
        
        await evolve(); 
        setInterval(tick, 2000);           
        setInterval(evolve, 3600000);      
        setInterval(async () => {          
            const b = await mexc.fetchBalance();
            walletBalance = b.total['USDT'] || 0;
        }, 15000);
    } catch (e) { console.error(e); setTimeout(start, 10000); }
}

app.listen(port, () => start());
