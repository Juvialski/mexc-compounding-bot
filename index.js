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
const TIMEFRAME = '1m'; 
const LEVERAGE = 10;
const RISK_PERCENT = 5.0; 
const TAKER_FEE = 0.0006;
const SIMULATED_SLIPPAGE = 0.0005; // 0.05% extra penalty in backtests 

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

// Helper: Send Webhook Alert
async function sendNotification(message) {
    const webhookUrl = process.env.WEBHOOK_URL; 
    if (!webhookUrl) return; 
    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: `🎯 **Sniper V11 Alert**\n${message}` })
        });
    } catch (e) { console.error("Notification Error:", e.message); }
}

// ==========================================
// DATABASE SCHEMA & CONNECTION
// ==========================================
let dbStatus = "Connecting...";
mongoose.connect(process.env.MONGO_URI)
    .then(() => { dbStatus = "Connected"; console.log("✅ DB Connected"); })
    .catch(err => { dbStatus = "Error connecting to DB"; console.error("❌ DB ERROR:", err); });

const Trade = mongoose.model('Trade', new mongoose.Schema({
    side: String, entry: Number, exit: Number, pnlUsd: Number, pnlPercent: Number, 
    equityAfter: Number, isWin: Boolean, time: { type: Date, default: Date.now }
}));

async function pruneDatabase() {
    try {
        const thirtyDaysAgo = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000));
        const result = await Trade.deleteMany({ time: { $lt: thirtyDaysAgo } });
        if (result.deletedCount > 0) console.log(`🧹 DB Pruning: Deleted ${result.deletedCount} trades.`);
    } catch (e) { console.error("DB Pruning Error:", e.message); }
}

// ==========================================
// EVOLUTION ENGINE 
// ==========================================
async function evolve() {
    try {
        const ohlcv = await mexc.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 1000);
        const closes = ohlcv.map(c => c[4]);
        const highs = ohlcv.map(c => c[2]);
        const lows = ohlcv.map(c => c[3]);

        const rsiV = RSI.calculate({ period: 14, values: closes });
        const atrV = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
        const smaV = SMA.calculate({ period: 200, values: closes });

        const offsetRSI = closes.length - rsiV.length;
        const offsetSMA = closes.length - smaV.length;
        const feePercent = (TAKER_FEE * 2) + SIMULATED_SLIPPAGE; 

        const testSettings = (rsiT, atrM, rr) => {
            let score = 0;
            for (let i = 200; i < closes.length - 15; i++) {
                const price = closes[i];
                const rsi = rsiV[i - offsetRSI];
                const sma = smaV[i - offsetSMA];
                const atr = atrV[i - offsetRSI];
                
                const riskDist = atr * atrM;
                if (riskDist === 0) continue;
                
                const riskPct = riskDist / price;
                const rewardPct = (riskDist * rr) / price;

                if (price > sma && rsi < rsiT) {
                    const sl = price - riskDist;
                    const tp = price + (riskDist * rr);
                    for (let j = 1; j <= 12; j++) {
                        let hitSL = lows[i + j] <= sl;
                        let hitTP = highs[i + j] >= tp;
                        if (hitSL && hitTP) hitTP = false; 
                        if (hitSL) { score -= (riskPct + feePercent); break; }
                        if (hitTP) { score += (rewardPct - feePercent); break; }
                    }
                }
                if (price < sma && rsi > (100 - rsiT)) {
                    const sl = price + riskDist;
                    const tp = price - (riskDist * rr);
                    for (let j = 1; j <= 12; j++) {
                        let hitSL = highs[i + j] >= sl;
                        let hitTP = lows[i + j] <= tp;
                        if (hitSL && hitTP) hitTP = false; 
                        if (hitSL) { score -= (riskPct + feePercent); break; }
                        if (hitTP) { score += (rewardPct - feePercent); break; }
                    }
                }
            }
            return score;
        };

        let bestScore = -999;
        for (let r of[25, 30, 35]) {
            for (let a of[1.2, 1.5, 2.0]) {
                for (let rr of[1.5, 1.8, 2.2]) {
                    const s = testSettings(r, a, rr);
                    if (s > bestScore) {
                        bestScore = s;
                        dna = { rsiThreshold: r, atrMultiplier: a, rewardRatio: rr, lastEvolved: formatPHT(new Date()) };
                    }
                }
            }
        }
        console.log(`🧬 DNA Evolved. Best Score: ${bestScore.toFixed(4)}`);
    } catch (e) { console.error("Evolution Error:", e.message); }
}

// ==========================================
// TRADING TICKER 
// ==========================================
async function tick() {
    if (isTrading) return;
    isTrading = true;
    try {
        const[ticker, pos, ohlcv] = await Promise.all([
            mexc.fetchTicker(SYMBOL),
            mexc.fetchPositions([SYMBOL]),
            mexc.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 210)
        ]);

        lastTicker = ticker;
        const price = Number(ticker.last || 0);
        
        // Flexible parsing for CCXT changes in how they return size
        const rawPos = pos.find(p => p.symbol === SYMBOL && (parseFloat(p.contracts) > 0 || parseFloat(p.amount) > 0 || parseFloat(p.info?.position) > 0));

        if (rawPos) {
            const side = rawPos.side.toUpperCase();
            const entryPrice = Number(rawPos.entryPrice || rawPos.price || rawPos.average || 0);
            
            // Resolve exact contracts quantity
            let contracts = Number(rawPos.contracts || rawPos.amount || 0);
            if (contracts === 0 && rawPos.info && rawPos.info.position) {
                contracts = Number(rawPos.info.position);
            }
            
            const isLong = side === 'LONG';
            const pnlUsd = (isLong ? (price - entryPrice) : (entryPrice - price)) * contracts * contractSize;

            // Pure Math ROE (Does not require position size to calculate)
            let roe = 0;
            if (entryPrice > 0) {
                const diff = isLong ? (price - entryPrice) : (entryPrice - price);
                roe = (diff / entryPrice) * LEVERAGE * 100;
            }
            
            activePosition = { side, entry: entryPrice, size: contracts, pnlUsd, roe };

        } else if (activePosition && !rawPos) {
            const isLong = activePosition.side === 'LONG';
            const finalPnlUsd = (isLong ? (price - activePosition.entry) : (activePosition.entry - price)) * activePosition.size * contractSize;
            
            // Pure Math ROE
            let finalRoe = 0;
            if (activePosition.entry > 0) {
                const diff = isLong ? (price - activePosition.entry) : (activePosition.entry - price);
                finalRoe = (diff / activePosition.entry) * LEVERAGE * 100;
            }

            await Trade.create({ 
                side: activePosition.side, 
                entry: activePosition.entry, 
                exit: price, 
                pnlUsd: finalPnlUsd, 
                pnlPercent: finalRoe, 
                equityAfter: walletBalance + finalPnlUsd, 
                isWin: finalPnlUsd > 0,
                time: new Date() // Fixes the exact trade closure timestamp!
            });

            await sendNotification(`**Position Closed** 🏁\nSide: ${activePosition.side}\nEntry: $${activePosition.entry.toFixed(2)}\nExit: $${price.toFixed(2)}\nPnL: $${finalPnlUsd.toFixed(2)} (${finalRoe.toFixed(2)}%)`);
            
            activePosition = null;

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
                    const stopDist = (atr || 10) * dna.atrMultiplier;
                    const sl = action === 'LONG' ? price - stopDist : price + stopDist;
                    const tp = action === 'LONG' ? price + (stopDist * dna.rewardRatio) : price - (stopDist * dna.rewardRatio);

                    const params = { 
                        'stopLoss': parseFloat(sl.toFixed(2)), 
                        'takeProfit': parseFloat(tp.toFixed(2)) 
                    };

                    await mexc.createOrder(SYMBOL, 'market', orderSide, qty, undefined, params);
                    lastOrderTime = Date.now();

                    await sendNotification(`**New Position Opened** 🚀\nSide: ${action}\nPrice: $${price.toFixed(2)}\nSize: ${qty} contracts\nLeverage: ${LEVERAGE}x\nSL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)}`);
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
    if (dbStatus !== "Connected") {
        return res.send(`
            <!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Loading...</title></head>
            <body style="background:#0b0f19; color:#94a3b8; font-family:sans-serif; text-align:center; padding:50px;">
                <h2>System Initializing...</h2><p>Database Status: <span style="color:#3b82f6;">${dbStatus}</span></p>
                <script>setTimeout(() => location.reload(), 3000);</script>
            </body></html>
        `);
    }

    try {
        // USING .lean() IS CRITICAL. It strips Mongoose protections and returns pure JSON arrays!
        const allTrades = await Trade.find().sort({ time: -1 }).limit(10).lean();
        const totalPnl = (await Trade.find()).reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
        const winCount = await Trade.countDocuments({ isWin: true });
        const totalCount = await Trade.countDocuments();
        const winRate = totalCount > 0 ? ((winCount / totalCount) * 100).toFixed(1) : 0;

        let activeCard = `<div class="card active-card"><h2 style="color:var(--muted); text-align:center; margin:0;">SCANNING MARKET...</h2></div>`;

        if (activePosition) {
            activeCard = `
            <div class="card active-card pulse-border">
                <div class="card-header">
                    <h2 style="margin:0;"><span class="pulse-dot ${activePosition.side === 'LONG'?'dot-green':'dot-red'}"></span> ACTIVE ${activePosition.side}</h2>
                </div>
                <div class="grid" style="margin-top:15px;">
                    <div class="stat-box"><span class="label">Entry</span><span class="value">$${(activePosition.entry || 0).toFixed(1)}</span></div>
                    <div class="stat-box"><span class="label">ROE %</span><span class="value ${activePosition.roe >= 0 ? 'text-green' : 'text-red'}">${(activePosition.roe || 0).toFixed(2)}%</span></div>
                    <div class="stat-box"><span class="label">PnL USD</span><span class="value ${activePosition.pnlUsd >= 0 ? 'text-green' : 'text-red'}">$${(activePosition.pnlUsd || 0).toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">Size</span><span class="value">${activePosition.size || 0}</span></div>
                </div>
            </div>`;
        }

        res.send(`
            <!DOCTYPE html><html><head><title>Elite Sniper V11</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="refresh" content="5">
            <style>
                :root { --bg: #0b0f19; --card: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; --green: #10b981; --red: #ef4444; --blue: #3b82f6; }
                body { background: var(--bg); color: var(--text); font-family: sans-serif; padding: 15px; margin: 0; }
                .container { max-width: 900px; margin: auto; }
                .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
                .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 15px; margin-bottom: 15px; }
                .stat-title { color: var(--muted); font-size: 11px; text-transform: uppercase; }
                .stat-value { font-size: 18px; font-weight: 800; margin-top: 5px; }
                .active-card { border-color: var(--blue); background: #0f172a; }
                .stat-box { background: rgba(0,0,0,0.2); padding: 8px; border-radius: 8px; text-align: center; }
                .label { font-size: 9px; color: var(--muted); text-transform: uppercase; }
                .value { font-size: 14px; font-weight: 600; display: block; }
                .text-green { color: var(--green); } .text-red { color: var(--red); }
                .badge { padding: 3px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; }
                .badge-green { background: rgba(16,185,129,0.2); color: var(--green); }
                .badge-red { background: rgba(239,68,68,0.2); color: var(--red); }
                table { width: 100%; border-collapse: collapse; }
                th { text-align: left; font-size: 11px; color: var(--muted); padding: 8px; border-bottom: 1px solid var(--border); }
                td { padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; }
                .pulse-dot { height: 8px; width: 8px; border-radius: 50%; display: inline-block; margin-right: 5px; }
                .dot-green { background: var(--green); } .dot-red { background: var(--red); }
                .pulse-border { animation: border-pulse 2s infinite; }
                @keyframes border-pulse { 0%, 100% { border-color: var(--blue); } 50% { border-color: var(--border); } }
                @media (max-width: 600px) { .grid { grid-template-columns: repeat(2, 1fr); } .card { padding: 12px; } .stat-value { font-size: 16px; } th, td { font-size: 11px; padding: 6px; } }
            </style></head>
            <body><div class="container">
                <h2 style="text-align:center; color:var(--blue); margin-top:5px; margin-bottom:20px;">🎯 SNIPER V11 (PHT)</h2>
                <div class="grid">
                    <div class="card"><div class="stat-title">Wallet</div><div class="stat-value">$${Number(walletBalance || 0).toFixed(2)}</div></div>
                    <div class="card"><div class="stat-title">BTC Price</div><div class="stat-value">$${Number(lastTicker.last || 0).toFixed(1)}</div></div>
                    <div class="card"><div class="stat-title">Net Profit</div><div class="stat-value ${totalPnl >= 0 ? 'text-green' : 'text-red'}">$${totalPnl.toFixed(2)}</div></div>
                    <div class="card"><div class="stat-title">Win Rate</div><div class="stat-value">${winRate}%</div></div>
                </div>
                ${activeCard}
                <div class="card">
                    <h3 style="margin: 0 0 10px 0; font-size: 14px; color:var(--muted);">Trade History (10 Recent)</h3>
                    <div style="overflow-x:auto;">
                        <table><tr><th>Time</th><th>Side</th><th>PnL %</th><th>PnL USD</th></tr>
                        ${allTrades.map(t => {
                            let pnlPct = Number(t.pnlPercent) || 0;
                            
                            // Pure Math Fallback (If old data has 0.00 saved in DB)
                            if (pnlPct === 0 && t.entry && t.exit && t.entry > 0) {
                                const diff = t.side === 'LONG' ? (t.exit - t.entry) : (t.entry - t.exit);
                                pnlPct = (diff / t.entry) * LEVERAGE * 100;
                            }

                            // Ensures old trades don't display 'Current Time'
                            const tradeTime = t.time ? new Date(t.time) : new Date();

                            return `<tr>
                                <td>${formatPHT(tradeTime)}</td>
                                <td><span class="badge ${t.side==='LONG'?'badge-green':'badge-red'}">${t.side}</span></td>
                                <td class="${pnlPct>=0?'text-green':'text-red'}">${pnlPct.toFixed(2)}%</td>
                                <td class="${(t.pnlUsd || 0)>=0?'text-green':'text-red'}">$${(t.pnlUsd || 0).toFixed(2)}</td>
                            </tr>`
                        }).join('')}
                        </table>
                    </div>
                </div>
                <div style="text-align:center; font-size:10px; color:var(--muted); margin-top:10px;">
                    DNA Evolved at: ${dna.lastEvolved} | System Time: ${formatPHT(new Date())}
                </div>
            </div></body></html>`);
    } catch (e) { 
        res.send(`<div style="color:red; text-align:center; padding:20px; font-family:sans-serif;">UI Render Error: ${e.message}</div>`); 
    }
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
        await sendNotification(`System Started & Initial DNA Evolved.`);
        
        setInterval(tick, 10000);           
        setInterval(async () => {           
            await evolve();
            await pruneDatabase();
        }, 3600000);       
        setInterval(async () => {          
            try { const b = await mexc.fetchBalance(); walletBalance = b.total['USDT'] || 0; } catch(e) {}
        }, 30000);                          
        
    } catch (e) { console.error(e); setTimeout(start, 10000); }
}

app.listen(port, () => start());
