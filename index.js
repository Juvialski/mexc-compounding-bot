// ==========================================
// Paste May 2026 - DYNAMIC AI GRID EDITION
// ==========================================
require('dotenv').config();
const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const { ATR, SMA } = require('technicalindicators');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 10000;

// ==========================================
// GEMINI AI SETUP
// ==========================================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ 
    model: "gemini-3.1-flash-lite-preview", 
    generationConfig: { responseMimeType: "application/json" }
});

async function askAIWithRetry(prompt, maxRetries = 3, baseDelayMs = 5000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await aiModel.generateContent(prompt);
            let responseText = result.response.text().trim();
            if (responseText.startsWith('```json')) responseText = responseText.replace(/^```json/, '').replace(/```$/, '').trim();
            else if (responseText.startsWith('```')) responseText = responseText.replace(/^```/, '').replace(/```$/, '').trim();
            return JSON.parse(responseText);
        } catch (error) {
            if (attempt < maxRetries) {
                const delay = baseDelayMs * attempt; 
                console.warn(`[AI Error] Retrying attempt ${attempt + 1} in ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error; 
            }
        }
    }
}

// ==========================================
// EXCHANGE & GLOBALS
// ==========================================
const SYMBOL = 'BTC/USDT:USDT';
const LEVERAGE = 10;
const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' },
    enableRateLimit: true 
});

let walletBalance = 0;
let currentPrice = 0;
let contractSize = 0.0001; 
let dailyPnL = 0;

// AI Grid State
let isReconciling = false;
let gridActive = false;
let gridMin = 0;
let gridMax = 0;
let gridLevelsCount = 0;
let gridSpacing = 0;
let gridQty = 0;
let gridNodes = []; // Array of { price }
let lastGapIndex = -1;
let aiMacroRegime = "Awaiting first AI Grid analysis...";
let currentRiskPercent = 20;

const formatPHT = (dateInput) => {
    if (!dateInput) return 'N/A';
    return new Date(dateInput).toLocaleString('en-US', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
};

async function sendNotification(message) {
    const webhookUrl = process.env.WEBHOOK_URL; 
    if (!webhookUrl) return; 
    try { await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `Grid AI Co-Pilot\n${message}` }) }); } catch (e) { }
}

// ==========================================
// DATABASE SETUP
// ==========================================
let dbStatus = "Connecting...";
mongoose.connect(process.env.MONGO_URI)
    .then(() => { dbStatus = "Connected"; console.log("DB Connected"); })
    .catch(err => { dbStatus = "Error connecting to DB"; console.error("DB ERROR:", err); });

const Trade = mongoose.model('Trade', new mongoose.Schema({
    type: String, price: Number, pnlUsd: Number, time: { type: Date, default: Date.now }
}));

// ==========================================
// CORE HELPERS
// ==========================================
async function closeAllPositions() {
    try {
        const positions = await mexc.fetchPositions([SYMBOL]);
        const pos = positions.find(p => p.symbol === SYMBOL && (parseFloat(p.contracts) > 0 || parseFloat(p.info?.position) > 0));
        if (pos) {
            const side = pos.side.toUpperCase() === 'LONG' ? 'sell' : 'buy';
            const contracts = Number(pos.contracts || pos.info?.position || 0);
            await mexc.createMarketOrder(SYMBOL, side, contracts, undefined, { 'reduceOnly': true });
            console.log(`Closed existing ${pos.side} position of ${contracts} contracts to reset Grid.`);
        }
    } catch(e) { console.error("Error closing positions:", e.message); }
}

// ==========================================
// AI GRID BUILDER
// ==========================================
async function buildDynamicGrid() {
    console.log("Initiating AI Grid Re-calculation...");
    gridActive = false; // Pause reconciliation
    try {
        // 1. Fetch MTF Data for AI
        const ohlcv = await mexc.fetchOHLCV(SYMBOL, '1d', undefined, 30);
        const closes = ohlcv.map(c => c[4]);
        const highs = ohlcv.map(c => c[2]);
        const lows = ohlcv.map(c => c[3]);
        
        const atr14 = ATR.calculate({ period: 14, high: highs, low: lows, close: closes }).pop() || 1500;
        const currentPriceObj = await mexc.fetchTicker(SYMBOL);
        currentPrice = Number(currentPriceObj.last);

        // 2. Prompt Gemini for Grid Bounds
        const prompt = `
        You are an elite quantitative trading AI managing a Grid Trading Bot on MEXC for ${SYMBOL}.
        Current Price: $${currentPrice}
        14-Day ATR (Volatility): $${atr14}

        Define a daily grid trading strategy. 
        - The bounds should contain the expected 24h price action based on ATR. 
        - If the asset is highly volatile, widen the bounds.
        - Give a safe 'risk_percent' (10 to 40) of the account to allocate.
        
        Provide:
        - lower_bound: price for the bottom grid line
        - upper_bound: price for the top grid line
        - grid_levels: number of grid lines (between 15 and 40)
        - risk_percent: % of account risk
        - reasoning: 1 sentence explanation of why you chose these bounds.

        Use JSON format ONLY: {"lower_bound": 60000, "upper_bound": 65000, "grid_levels": 20, "risk_percent": 25, "reasoning": "..."}
        `;

        let aiDecision;
        try {
            aiDecision = await askAIWithRetry(prompt, 2, 5000);
        } catch (e) {
            console.log("AI Failed, falling back to safe mathematical defaults.");
            aiDecision = {
                lower_bound: currentPrice - (atr14 * 1.5),
                upper_bound: currentPrice + (atr14 * 1.5),
                grid_levels: 25,
                risk_percent: 20,
                reasoning: "Fallback mathematical ATR bounds due to AI timeout."
            };
        }

        // 3. Clear slate and realize any out-of-bounds exposure
        await mexc.cancelAllOrders(SYMBOL);
        await closeAllPositions();

        // 4. Update State
        gridMin = aiDecision.lower_bound;
        gridMax = aiDecision.upper_bound;
        gridLevelsCount = aiDecision.grid_levels;
        currentRiskPercent = aiDecision.risk_percent;
        aiMacroRegime = aiDecision.reasoning;

        gridSpacing = (gridMax - gridMin) / gridLevelsCount;
        gridNodes = [];
        for(let i = 0; i <= gridLevelsCount; i++) {
            gridNodes.push({ price: parseFloat((gridMin + (i * gridSpacing)).toFixed(2)) });
        }

        // Calculate quantity per node
        let allocUsd = walletBalance * (currentRiskPercent / 100) * LEVERAGE;
        gridQty = Math.floor((allocUsd / gridLevelsCount) / (currentPrice * contractSize));
        if (gridQty < 1) gridQty = 1; // Enforce minimum 1 contract

        lastGapIndex = -1; 
        gridActive = true;
        
        console.log(`[GRID BUILT] ${gridMin} to ${gridMax} | Nodes: ${gridLevelsCount} | Spacing: $${gridSpacing.toFixed(2)}`);
        await sendNotification(`🤖 AI Deployed New Grid\nBounds: $${gridMin.toFixed(2)} - $${gridMax.toFixed(2)}\nLevels: ${gridLevelsCount}\nQty per node: ${gridQty} Contracts\nReasoning: ${aiMacroRegime}`);

    } catch (e) {
        console.error("Grid Building Error:", e.message);
        setTimeout(buildDynamicGrid, 30000); // Retry in 30s
    }
}

// ==========================================
// STATELESS GRID RECONCILIATION LOOP
// ==========================================
async function reconcileGrid() {
    if (isReconciling || !gridActive) return;
    isReconciling = true;
    
    try {
        const ticker = await mexc.fetchTicker(SYMBOL);
        currentPrice = Number(ticker.last);

        // 1. OOB Emergency Recalibration
        if (currentPrice < gridMin - (gridSpacing*2) || currentPrice > gridMax + (gridSpacing*2)) {
            console.log("Price broke out of grid bounds! Triggering Emergency AI Recalibration...");
            await sendNotification(`🚨 Price Out of Bounds ($${currentPrice}). Suspending and Recalibrating Grid...`);
            gridActive = false;
            await buildDynamicGrid();
            isReconciling = false;
            return;
        }

        // 2. Find the GAP (closest grid node to current price)
        let minDiff = Infinity;
        let targetGapIndex = -1;
        for (let i = 0; i < gridNodes.length; i++) {
            const diff = Math.abs(gridNodes[i].price - currentPrice);
            if (diff < minDiff) {
                minDiff = diff;
                targetGapIndex = i;
            }
        }

        // Detect if Gap moved (a Grid Fill occurred)
        if (lastGapIndex !== -1 && targetGapIndex !== lastGapIndex) {
            const crossed = Math.abs(targetGapIndex - lastGapIndex);
            const profitPerNode = gridSpacing * gridQty * contractSize;
            const realizedPnL = crossed * profitPerNode;
            dailyPnL += realizedPnL;
            
            await Trade.create({ type: 'Grid Fill', price: currentPrice, pnlUsd: realizedPnL });
            console.log(`Grid Fill! Shifted ${crossed} node(s). Approx Profit: $${realizedPnL.toFixed(2)}`);
        }
        lastGapIndex = targetGapIndex;

        // 3. Fetch Book & Align Orders
        const openOrders = await mexc.fetchOpenOrders(SYMBOL);
        const openOrderMap = {}; 
        
        // Map open orders to nearest node indices
        for (let o of openOrders) {
            let mDiff = Infinity; let mIdx = -1;
            for(let i=0; i<gridNodes.length; i++){
                if(Math.abs(gridNodes[i].price - o.price) < mDiff) { mDiff = Math.abs(gridNodes[i].price - o.price); mIdx = i; }
            }
            if(mDiff < gridSpacing * 0.2) openOrderMap[mIdx] = o;
        }

        // 4. Stateless Healing
        // For every node: If index < gap -> BUY. If index > gap -> SELL. If index == gap -> NO ORDER.
        for (let i = 0; i < gridNodes.length; i++) {
            let desiredSide = null;
            if (i < targetGapIndex) desiredSide = 'buy';
            else if (i > targetGapIndex) desiredSide = 'sell';

            let existingOrder = openOrderMap[i];

            if (desiredSide === null) {
                // Gap node shouldn't have an order
                if (existingOrder) await mexc.cancelOrder(existingOrder.id, SYMBOL).catch(()=>{});
            } else {
                if (existingOrder) {
                    if (existingOrder.side !== desiredSide) {
                        await mexc.cancelOrder(existingOrder.id, SYMBOL).catch(()=>{});
                        await mexc.createLimitOrder(SYMBOL, desiredSide, gridQty, gridNodes[i].price).catch(()=>{});
                    }
                } else {
                    // Missing order (either it filled, or wasn't placed)
                    await mexc.createLimitOrder(SYMBOL, desiredSide, gridQty, gridNodes[i].price).catch(()=>{});
                }
            }
        }

    } catch(e) {
        console.error("Reconciliation Error:", e.message);
    } finally {
        isReconciling = false;
    }
}

// ==========================================
// ROUTES & DASHBOARD UI
// ==========================================
app.get('/reset-db', async (req, res) => { try { await Trade.deleteMany({}); res.send(`<h2>DB Cleared</h2>`); } catch(e){ res.send(e.message); } });
app.get('/ping', (req, res) => res.status(200).send('pong'));

app.get('/', async (req, res) => {
    if (dbStatus !== "Connected" || gridNodes.length === 0) return res.send(`<h2>AI Grid Initialization in progress... Please wait 60 seconds.</h2>`);
    try {
        const allTrades = await Trade.find().sort({ time: -1 }).limit(15).lean();
        const totalPnl = (await Trade.find()).reduce((sum, t) => sum + (t.pnlUsd || 0), 0);

        // Generate Grid Visualization array
        // Show 4 nodes above gap, 4 below gap
        let startIdx = Math.max(0, lastGapIndex - 5);
        let endIdx = Math.min(gridNodes.length - 1, lastGapIndex + 5);
        let visualNodes = [];
        for(let i = endIdx; i >= startIdx; i--) { // Reverse order for visual (high price on top)
            visualNodes.push({
                price: gridNodes[i].price,
                side: i < lastGapIndex ? 'BUY' : i > lastGapIndex ? 'SELL' : 'GAP (Current Price)',
                color: i < lastGapIndex ? 'text-green' : i > lastGapIndex ? 'text-red' : 'text-yellow'
            });
        }

        res.send(`
            <!DOCTYPE html><html><head><title>Sniper AI Grid</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="refresh" content="15">
            <style>
                :root { --bg: #0b0f19; --card: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; --green: #10b981; --red: #ef4444; --blue: #3b82f6; --purple: #a855f7; --yellow: #eab308; }
                body { background: var(--bg); color: var(--text); font-family: sans-serif; padding: 15px; margin: 0; }
                .container { max-width: 900px; margin: auto; }
                .header-flex { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
                .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
                .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 15px; margin-bottom: 15px; }
                .stat-title { color: var(--muted); font-size: 11px; text-transform: uppercase; }
                .stat-value { font-size: 18px; font-weight: 800; margin-top: 5px; }
                .stat-box { background: rgba(0,0,0,0.2); padding: 8px; border-radius: 8px; text-align: center; }
                .label { font-size: 9px; color: var(--muted); text-transform: uppercase; }
                .value { font-size: 14px; font-weight: 600; display: block; }
                .text-green { color: var(--green); } .text-red { color: var(--red); } .text-yellow { color: var(--yellow); } .text-purple { color: var(--purple); } .text-blue { color: var(--blue); }
                table { width: 100%; border-collapse: collapse; } th { text-align: left; font-size: 11px; color: var(--muted); padding: 8px; border-bottom: 1px solid var(--border); } td { padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; }
                .ai-box { padding: 12px; border-radius: 4px; font-size: 12px; margin-top: 10px; line-height: 1.6; border-left: 3px solid var(--purple); background: rgba(168, 85, 247, 0.05); }
                .node-row { display: flex; justify-content: space-between; padding: 6px; border-bottom: 1px solid rgba(255,255,255,0.05); font-family: monospace; }
            </style></head>
            <body><div class="container">
                <div class="header-flex">
                    <h2 style="color:var(--purple); margin:0;">AI GRID CO-PILOT</h2>
                    <span style="font-size: 10px; color: var(--muted);">Refresh: ${new Date().toLocaleTimeString()}</span>
                </div>

                <div class="grid" style="margin-bottom: 15px;">
                    <div class="card" style="margin-bottom: 0;"><div class="stat-title">BTC/USDT</div><div class="stat-value text-blue">$${currentPrice.toFixed(2)}</div></div>
                    <div class="card" style="margin-bottom: 0;"><div class="stat-title">Wallet</div><div class="stat-value">$${Number(walletBalance || 0).toFixed(2)}</div></div>
                    <div class="card" style="margin-bottom: 0;"><div class="stat-title">Daily Session PnL</div><div class="stat-value ${dailyPnL >= 0 ? 'text-green' : 'text-red'}">$${dailyPnL.toFixed(2)}</div></div>
                    <div class="card" style="margin-bottom: 0;"><div class="stat-title">All-Time PnL</div><div class="stat-value ${totalPnl >= 0 ? 'text-green' : 'text-red'}">$${totalPnl.toFixed(2)}</div></div>
                </div>

                <div class="card">
                    <h3 style="margin: 0 0 10px 0; font-size: 14px; color:var(--muted);">Grid Parameters & Execution</h3>
                    <div class="grid">
                        <div class="stat-box"><span class="label">Lower Bound</span><span class="value text-green">$${gridMin.toFixed(2)}</span></div>
                        <div class="stat-box"><span class="label">Upper Bound</span><span class="value text-red">$${gridMax.toFixed(2)}</span></div>
                        <div class="stat-box"><span class="label">Total Nodes</span><span class="value">${gridLevelsCount}</span></div>
                        <div class="stat-box"><span class="label">Spacing</span><span class="value">$${gridSpacing.toFixed(2)}</span></div>
                        <div class="stat-box"><span class="label">Allocated Risk</span><span class="value text-purple">${currentRiskPercent}%</span></div>
                        <div class="stat-box"><span class="label">Contracts per Node</span><span class="value">${gridQty}</span></div>
                    </div>
                    
                    <div class="ai-box">
                        <strong>AI Daily Thesis:</strong><br/><em>"${aiMacroRegime}"</em>
                    </div>
                </div>

                <div class="card">
                    <h3 style="margin: 0 0 10px 0; font-size: 14px; color:var(--muted);">Live Grid Radar (Center Cross-Section)</h3>
                    <div style="background: rgba(0,0,0,0.3); padding: 10px; border-radius: 8px;">
                        ${visualNodes.map(n => `<div class="node-row"><span class="${n.color}">${n.side}</span><span>$${n.price.toFixed(2)}</span></div>`).join('')}
                    </div>
                    <div style="margin-top:8px; font-size:10px; text-align:center; color:var(--muted);">The bot auto-shifts nodes to capture profit as price crosses lines.</div>
                </div>

                <div class="card">
                    <h3 style="margin: 0 0 10px 0; font-size: 14px; color:var(--muted);">Recent Grid Fills</h3>
                    <div style="overflow-x:auto;">
                        <table><tr><th>Time</th><th>Event</th><th>Price Crossed</th><th>PnL USD</th></tr>
                        ${allTrades.map(t => `<tr>
                                <td>${formatPHT(t.time)}</td>
                                <td><span style="background:var(--blue); color:#fff; padding:2px 6px; border-radius:4px; font-size:10px;">${t.type}</span></td>
                                <td>$${(t.price||0).toFixed(2)}</td>
                                <td class="text-green">+$${(t.pnlUsd||0).toFixed(2)}</td>
                            </tr>`).join('')}
                        </table>
                    </div>
                </div>
            </div></body></html>`);
    } catch (e) { res.send(`<div>UI Error: ${e.message}</div>`); }
});

// ==========================================
// STARTUP SCHEDULER
// ==========================================
async function start() {
    try {
        const markets = await mexc.loadMarkets();
        contractSize = markets[SYMBOL].contractSize || 0.0001;
        const b = await mexc.fetchBalance(); 
        walletBalance = b.total['USDT'] || 0;
        
        await sendNotification(`🚀 AI Grid Bot Online. Analyzing market...`);
        
        // Initial Grid Setup
        await buildDynamicGrid(); 
        
        // Fast Stateless Tick (Heals Grid, Takes Profit, Replaces Nodes)
        setInterval(reconcileGrid, 15000); // 15 Seconds
        
        // Balance Refresher
        setInterval(async () => { try { const b = await mexc.fetchBalance(); walletBalance = b.total['USDT'] || 0; } catch(e){} }, 60000);                          
        
        // Daily AI Recalibration (Adapts to changing markets, avoids stagnation)
        setInterval(async () => {
            dailyPnL = 0; // Reset daily tracker
            await buildDynamicGrid();
        }, 86400000); // 24 Hours
        
    } catch (e) { console.error(e); setTimeout(start, 10000); }
}

app.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
    start();
});
