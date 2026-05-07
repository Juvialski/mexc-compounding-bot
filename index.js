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
    lastEvolved: 'Initialising...'
};

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

// Global States
let isTrading = false;
let walletBalance = 0;
let lastTicker = { last: 0 };
let contractSize = 0.0001; 
let lastOrderTime = 0; 
let activePosition = null;

// Helper: Format to Philippine Time (PHT)
const formatPHT = (dateInput) => {
    if (!dateInput) return 'N/A';
    return new Date(dateInput).toLocaleString('en-US', { 
        timeZone: 'Asia/Manila',
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        hour12: true 
    });
};

// ==========================================
// DATABASE SCHEMA
// ==========================================
mongoose.connect(process.env.MONGO_URI).catch(err => console.error("❌ DB ERROR:", err));
const Trade = mongoose.model('Trade', new mongoose.Schema({
    side: String, entry: Number, exit: Number, pnlUsd: Number, pnlPercent: Number, 
    equityAfter: Number, isWin: Boolean, time: { type: Date, default: Date.now }
}));

// ==========================================
// EVOLUTION ENGINE (Bi-Directional Backtest)
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
                
                // Long Test
                if (price > sma && rsi < rsiT) {
                    const sl = price - (atr * atrM);
                    const tp = price + (atr * atrM * rr);
                    for (let j = 1; j <= 12; j++) {
                        if (lows[i + j] <= sl) { score -= 1; break; }
                        if (highs[i + j] >= tp) { score += rr; break; }
                    }
                }
                // Short Test
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
                        dna = { rsiThreshold: r, atrMultiplier: a, rewardRatio: rr, lastEvolved: formatPHT(new Date()) };
                    }
                }
            }
        }
    } catch (e) { console.error("Evolution Error:", e.message); }
}

// ==========================================
// TRADING TICKER (Bi-Directional)
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
        const price = Number(ticker.last || 0);
        const rawPos = pos.find(p => p.symbol === SYMBOL && parseFloat(p.contracts) > 0);

        if (rawPos) {
            const side = rawPos.side.toUpperCase();
            const entryPrice = Number(rawPos.entryPrice || 0);
            const contracts = Number(rawPos.contracts || 0);
            
            activePosition = {
                side: side,
                entry: entryPrice,
                size: contracts,
                pnlUsd: (side === 'LONG' ? (price - entryPrice) : (entryPrice - price)) * contracts * contractSize
            };
            activePosition.roe = (activePosition.pnlUsd / ((entryPrice * contracts * contractSize) / LEVERAGE)) * 100;

            const atr = ATR.calculate({ period: 14, high: ohlcv.map(c=>c[2]), low: ohlcv.map(c=>c[3]), close: ohlcv.map(c=>c[4]) }).pop();
            const stopDist = (atr || 10) * dna.atrMultiplier;
            const sl = side === 'LONG' ? entryPrice - stopDist : entryPrice + stopDist;
            const tp = side === 'LONG' ? entryPrice + (stopDist * dna.rewardRatio) : entryPrice - (stopDist * dna.rewardRatio);

            const exitHit = side === 'LONG' ? (price <= sl || price >= tp) : (price >= sl || price <= tp);

            if (exitHit) {
                await mexc.createOrder(SYMBOL, 'market', side === 'LONG' ? 'sell' : 'buy', contracts, undefined, { 'reduceOnly': true });
                await Trade.create({ 
                    side: side, entry: entryPrice, exit: price, 
                    pnlUsd: activePosition.pnlUsd, pnlPercent: activePosition.roe, 
                    equityAfter: walletBalance + activePosition.pnlUsd, isWin: activePosition.pnlUsd > 0 
                });
                activePosition = null;
            }
        } else if (Date.now() - lastOrderTime > 60000) {
            activePosition = null;
            const closes = ohlcv.map(c => c[4]);
            const rsi = RSI.calculate({ period: 14, values: closes }).pop();
            const sma = SMA.calculate({ period: 200, values: closes }).pop();
            const atr = ATR.calculate({ period: 14, high: ohlcv.map(c=>c[2]), low: ohlcv.map(c=>c[3]), close: closes }).pop();

            let action = null;
            let orderSide = null;
            if (price > (sma || 0) && (rsi || 50) < dna.rsiThreshold) { action = 'LONG'; orderSide = 'buy'; }
            else if (price < (sma || 0) && (rsi || 50) > (100 - dna.rsiThreshold)) { action = 'SHORT'; orderSide = 'sell'; }

            if (action) {
                const riskAmount = walletBalance * (RISK_PERCENT / 100);
                let qty = Math.floor(riskAmount / ((atr || 20) * dna.atrMultiplier * contractSize));
                const maxAfford = Math.floor((walletBalance * LEVERAGE * 0.8) / (price * contractSize));
                if (qty > maxAfford) qty = maxAfford;

                if (qty >= 1) {
                    const params = { 'openType': 1, 'positionType': action === 'LONG' ? 1 : 2 };
                    await mexc.createOrder(SYMBOL, 'market', orderSide, qty, undefined, params);
                    lastOrderTime = Date.now();
                }
            }
        }
    } catch (e) { console.error("Tick Error:", e.message); }
    finally { isTrading = false; }
}

// ==========================================
// DASHBOARD UI (Philippine Time Optimized)
// ==========================================
app.get('/', async (req, res) => {
    try {
        const allTrades = await Trade.find().sort({ time: -1 }).limit(10);
        const totalPnl = (await Trade.find()).reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
        const winCount = await Trade.countDocuments({ isWin: true });
        const totalCount = await Trade.countDocuments();
        const winRate = totalCount > 0 ? ((winCount / totalCount) * 100).toFixed(1) : 0;

        let activeCard = `<div class="card active-card"><h2 style="color:var(--muted); text-align:center;">SCANNING MARKET...</h2></div>`;

        if (activePosition) {
            activeCard = `
            <div class="card active-card pulse-border">
                <div class="card-header">
                    <h2><span class="pulse-dot ${activePosition.side === 'LONG'?'dot-green':'dot-red'}"></span> ACTIVE ${activePosition.side}</h2>
                </div>
                <div class="grid grid-cols-4 gap-4 mt-4">
                    <div class="stat-box"><span class="label">Entry</span><span class="value">$${(activePosition.entry || 0).toFixed(1)}</span></div>
                    <div class="stat-box"><span class="label">ROE %</span><span class="value ${activePosition.roe >= 0 ? 'text-green' : 'text-red'}">${(activePosition.roe || 0).toFixed(2)}%</span></div>
                    <div class="stat-box"><span class="label">PnL USD</span><span class="value ${activePosition.pnlUsd >= 0 ? 'text-green' : 'text-red'}">$${(activePosition.pnlUsd || 0).toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">Size</span><span class="value">${activePosition.size || 0} Cont.</span></div>
                </div>
            </div>`;
        }

        res.send(`
            <!DOCTYPE html><html><head><title>Elite Sniper V10.4</title><meta http-equiv="refresh" content="5">
            <style>
                :root { --bg: #0b0f19; --card: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; --green: #10b981; --red: #ef4444; --blue: #3b82f6; }
                body { background: var(--bg); color: var(--text); font-family: sans-serif; padding: 20px; margin: 0; }
                .container { max-width: 900px; margin: auto; padding: 10px; }
                .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
                .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 15px; margin-bottom: 15px; }
                .stat-title { color: var(--muted); font-size: 10px; text-transform: uppercase; }
                .stat-value { font-size: 20px; font-weight: 800; margin-top: 5px; }
                .active-card { border-color: var(--blue); background: #0f172a; }
                .stat-box { background: rgba(0,0,0,0.2); padding: 8px; border-radius: 8px; text-align: center; }
                .label { font-size: 9px; color: var(--muted); text-transform: uppercase; }
                .value { font-size: 14px; font-weight: 600; display: block; }
                .text-green { color: var(--green); } .text-red { color: var(--red); }
                .badge { padding: 3px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; }
                .badge-green { background: rgba(16,185,129,0.2); color: var(--green); }
                .badge-red { background: rgba(239,68,68,0.2); color: var(--red); }
                table { width: 100%; border-collapse: collapse; }
                th { text-align: left; font-size: 11px; color: var(--muted); padding: 10px; border-bottom: 1px solid var(--border); }
                td { padding: 10px; border-bottom: 1px solid var(--border); font-size: 13px; }
                .pulse-dot { height: 8px; width: 8px; border-radius: 50%; display: inline-block; margin-right: 5px; }
                .dot-green { background: var(--green); } .dot-red { background: var(--red); }
                .pulse-border { animation: border-pulse 2s infinite; }
                @keyframes border-pulse { 0%, 100% { border-color: var(--blue); } 50% { border-color: var(--border); } }
            </style></head>
            <body><div class="container">
                <h2 style="text-align:center; color:var(--blue); margin-bottom:20px;">🎯 SNIPER V10.4 (PHT TIME)</h2>
                <div class="grid">
                    <div class="card"><div class="stat-title">Wallet</div><div class="stat-value">$${Number(walletBalance || 0).toFixed(2)}</div></div>
                    <div class="card"><div class="stat-title">BTC Price</div><div class="stat-value">$${Number(lastTicker.last || 0).toFixed(1)}</div></div>
                    <div class="card"><div class="stat-title">Net Profit</div><div class="stat-value ${totalPnl >= 0 ? 'text-green' : 'text-red'}">$${totalPnl.toFixed(2)}</div></div>
                    <div class="card"><div class="stat-title">Win Rate</div><div class="stat-value">${winRate}%</div></div>
                </div>
                ${activeCard}
                <div class="card">
                    <h3 style="margin: 0 0 10px 0; font-size: 16px;">Trade History (PHT)</h3>
                    <table><tr><th>Time</th><th>Side</th><th>PnL %</th><th>PnL USD</th></tr>
                    ${allTrades.map(t => `<tr><td>${formatPHT(t.time)}</td><td><span class="badge ${t.side==='LONG'?'badge-green':'badge-red'}">${t.side}</span></td><td class="${(t.pnlPercent || 0)>=0?'text-green':'text-red'}">${(t.pnlPercent || 0).toFixed(2)}%</td><td class="${(t.pnlUsd || 0)>=0?'text-green':'text-red'}">$${(t.pnlUsd || 0).toFixed(2)}</td></tr>`).join('')}
                    </table>
                </div>
                <div style="text-align:center; font-size:10px; color:var(--muted);">
                    DNA Evolved at: ${dna.lastEvolved} | System Time: ${formatPHT(new Date())}
                </div>
            </div></body></html>`);
    } catch (e) { res.send(`UI Error: Syncing Data... (${e.message})`); }
});

// ==========================================
// STARTUP
// ==========================================
async function start() {
    try {
        const markets = await mexc.loadMarkets();
        contractSize = markets[SYMBOL].contractSize || 0.0001;
        const b = await mexc.fetchBalance();
        walletBalance = b.total['USDT'] || 0;
        
        await evolve(); 
        setInterval(tick, 3000);           
        setInterval(evolve, 3600000);      
        setInterval(async () => {          
            try { const b = await mexc.fetchBalance(); walletBalance = b.total['USDT'] || 0; } catch(e) {}
        }, 15000);
    } catch (e) { console.error(e); setTimeout(start, 10000); }
}

app.listen(port, () => start());
