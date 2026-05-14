// ==========================================
// DYNAMIC AI GRID EDITION - WEEKLY SWING ANCHOR
// ==========================================
require('dotenv').config();
const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
                console.warn(`[AI Error] Retrying attempt ${attempt + 1}...`);
                await sleep(baseDelayMs * attempt);
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

// AI Grid State
let isReconciling = false;
let gridActive = false;
let gridMin = 0;
let gridMax = 0;
let gridLevelsCount = 0;
let gridSpacing = 0;
let gridQty = 1; 
let gridNodes = []; 
let currentGapIdx = -1; 
let aiMacroRegime = "Awaiting first AI Grid analysis...";
const ACTIVE_WINDOW = 3; 

const formatPHT = (dateInput) => {
    if (!dateInput) return 'N/A';
    return new Date(dateInput).toLocaleString('en-US', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
};

async function sendNotification(message) {
    const webhookUrl = process.env.WEBHOOK_URL; 
    if (!webhookUrl) return; 
    try { await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `Nano Grid AI\n${message}` }) }); } catch (e) { }
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

const BotState = mongoose.model('BotState', new mongoose.Schema({
    key: { type: String, default: 'main' },
    initialBalance: Number,
    dailyStartBalance: Number,
    lastReset: Date
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
            await sleep(500); 
        }
    } catch(e) { console.error("Error closing positions:", e.message); }
}

// ==========================================
// AI GRID BUILDER
// ==========================================
async function buildDynamicGrid() {
    console.log("Initiating AI Grid Re-calculation...");
    gridActive = false;
    try {
        const b = await mexc.fetchBalance(); 
        walletBalance = b.total['USDT'] || 0;

        // FETCH EXACT 7-DAY HIGH AND LOW
        const ohlcv7d = await mexc.fetchOHLCV(SYMBOL, '1d', undefined, 7);
        const weekHigh = Math.max(...ohlcv7d.map(c => c[2]));
        const weekLow = Math.min(...ohlcv7d.map(c => c[3]));
        
        const currentPriceObj = await mexc.fetchTicker(SYMBOL);
        currentPrice = Number(currentPriceObj.last);

        const prompt = `
        You are managing a Grid Bot on MEXC for ${SYMBOL}.
        Current Price: $${currentPrice}
        7-Day High: $${weekHigh}
        7-Day Low: $${weekLow}

        The user requested: "Base the grid at least above the week high. Not too tight."
        
        Rules:
        1. 'upper_bound' MUST be slightly above the 7-Day High ($${weekHigh}).
        2. 'lower_bound' MUST be slightly below the 7-Day Low ($${weekLow}).
        3. 'grid_levels' should be between 20 and 40 so that the spacing between levels is viable for generating profit against exchange fees.

        Provide JSON ONLY: {"lower_bound": 60000, "upper_bound": 70000, "grid_levels": 30, "reasoning": "..."}
        `;

        let aiDecision;
        try {
            aiDecision = await askAIWithRetry(prompt, 2, 5000);
        } catch (e) {
            aiDecision = { lower_bound: weekLow * 0.99, upper_bound: weekHigh * 1.01, grid_levels: 30, reasoning: "Fallback weekly range applied." };
        }

        let gMin = Number(aiDecision.lower_bound);
        let gMax = Number(aiDecision.upper_bound);
        let gLevels = Number(aiDecision.grid_levels);

        // SANITY CHECK: Force it to obey the weekly high/low rule even if the AI hallucinates
        if (gMax < weekHigh) gMax = weekHigh * 1.005;
        if (gMin > weekLow) gMin = weekLow * 0.995;
        if (gLevels < 15 || gLevels > 50) gLevels = 30;

        await mexc.cancelAllOrders(SYMBOL);
        await sleep(500);
        await closeAllPositions();

        gridMin = gMin;
        gridMax = gMax;
        gridLevelsCount = gLevels;
        aiMacroRegime = aiDecision.reasoning;

        gridSpacing = (gridMax - gridMin) / gridLevelsCount;
        gridNodes = [];
        
        for(let i = 0; i <= gridLevelsCount; i++) {
            gridNodes.push({ price: parseFloat((gridMin + (i * gridSpacing)).toFixed(1)) });
        }

        let idealQty = Math.floor((walletBalance * 0.5 * LEVERAGE / gridLevelsCount) / (currentPrice * contractSize));
        gridQty = Math.max(1, idealQty); 

        let minDiff = Infinity;
        currentGapIdx = -1;
        for (let i = 0; i < gridNodes.length; i++) {
            let diff = Math.abs(gridNodes[i].price - currentPrice);
            if (diff < minDiff) { minDiff = diff; currentGapIdx = i; }
        }

        gridActive = true;
        
        console.log(`[GRID BUILT] Bounds: ${gridMin} to ${gridMax} | Nodes: ${gridLevelsCount} | Spacing: $${gridSpacing.toFixed(2)}`);
        await sendNotification(`🤖 AI Nano Grid Deployed\nBounds: $${gridMin.toFixed(2)} - $${gridMax.toFixed(2)}\nSpacing: $${gridSpacing.toFixed(2)}\nReasoning: ${aiMacroRegime}`);

    } catch (e) {
        console.error("Grid Building Error:", e.message);
        setTimeout(buildDynamicGrid, 30000);
    }
}

// ==========================================
// SHADOW GRID RECONCILIATION LOOP
// ==========================================
async function reconcileGrid() {
    if (isReconciling || !gridActive || currentGapIdx === -1) return;
    isReconciling = true;
    
    try {
        const ticker = await mexc.fetchTicker(SYMBOL);
        currentPrice = Number(ticker.last);

        if (currentPrice < gridMin - (gridSpacing*1.5) || currentPrice > gridMax + (gridSpacing*1.5)) {
            console.log("Price out of bounds! Recalibrating...");
            await sendNotification(`🚨 Out of Bounds ($${currentPrice.toFixed(2)}). Recalibrating Grid...`);
            gridActive = false;
            await buildDynamicGrid();
            isReconciling = false;
            return;
        }

        while (currentGapIdx > 0 && currentPrice <= gridNodes[currentGapIdx - 1].price) {
            currentGapIdx--;
        }
        while (currentGapIdx < gridNodes.length - 1 && currentPrice >= gridNodes[currentGapIdx + 1].price) {
            currentGapIdx++;
        }

        const activeIndices = [];
        for(let i = currentGapIdx - 1; i >= Math.max(0, currentGapIdx - ACTIVE_WINDOW); i--) {
            activeIndices.push(i);
        }
        for(let i = currentGapIdx + 1; i <= Math.min(gridNodes.length - 1, currentGapIdx + ACTIVE_WINDOW); i++) {
            activeIndices.push(i);
        }

        const openOrders = await mexc.fetchOpenOrders(SYMBOL);
        const ordersToKeep = [];

        for (let o of openOrders) {
            let matchedIdx = -1;
            let mDiff = Infinity;
            
            for(let i = 0; i < gridNodes.length; i++){
                const d = Math.abs(gridNodes[i].price - Number(o.price));
                if(d < mDiff) { mDiff = d; matchedIdx = i; }
            }

            if (mDiff > (gridSpacing * 0.2)) {
                matchedIdx = -1;
            }

            if (matchedIdx !== -1) {
                if (!activeIndices.includes(matchedIdx)) {
                    await mexc.cancelOrder(o.id, SYMBOL).catch(()=>{});
                    await sleep(200); 
                } 
                else if (ordersToKeep.includes(matchedIdx)) {
                    await mexc.cancelOrder(o.id, SYMBOL).catch(()=>{});
                    await sleep(200); 
                } 
                else {
                    ordersToKeep.push(matchedIdx);
                }
            } else {
                await mexc.cancelOrder(o.id, SYMBOL).catch(()=>{});
                await sleep(200);
            }
        }

        for (let i of activeIndices) {
            if (!ordersToKeep.includes(i)) {
                const distanceToPrice = Math.abs(gridNodes[i].price - currentPrice);
                if (distanceToPrice < (gridSpacing * 0.05)) {
                    continue; 
                }

                const desiredSide = i < currentGapIdx ? 'buy' : 'sell';
                try {
                    await mexc.createLimitOrder(SYMBOL, desiredSide, gridQty, gridNodes[i].price);
                    await sleep(200); 
                } catch(e) {
                    if (e.message.includes('balance') || e.message.includes('margin')) break; 
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
app.get('/reset-db', async (req, res) => { 
    try { 
        await Trade.deleteMany({}); 
        await BotState.deleteMany({});
        
        const b = await mexc.fetchBalance(); 
        walletBalance = b.total['USDT'] || 0;
        await BotState.create({ key: 'main', initialBalance: walletBalance, dailyStartBalance: walletBalance, lastReset: new Date() });
        
        res.send(`<h2>Database Cleared. Baseline Wallet Balance set to exactly $${walletBalance.toFixed(4)}.</h2>`); 
    } catch(e){ res.send(e.message); } 
});

app.get('/ping', (req, res) => res.status(200).send('pong'));

app.get('/', async (req, res) => {
    if (dbStatus !== "Connected" || gridNodes.length === 0 || currentGapIdx === -1) return res.send(`<h2>AI Grid Initializing... (Fetching AI Data)</h2>`);
    try {
        const allTrades = await Trade.find().sort({ time: -1 }).limit(12).lean();
        const state = await BotState.findOne({ key: 'main' });
        
        let allTimePnL = 0;
        let dailyPnL = 0;
        if (state) {
            allTimePnL = walletBalance - state.initialBalance;
            dailyPnL = walletBalance - state.dailyStartBalance;
        }

        let startIdx = Math.max(0, currentGapIdx - ACTIVE_WINDOW - 1);
        let endIdx = Math.min(gridNodes.length - 1, currentGapIdx + ACTIVE_WINDOW + 1);
        let visualNodes = [];
        
        for(let i = endIdx; i >= startIdx; i--) { 
            if (i === currentGapIdx) {
                visualNodes.push({ price: gridNodes[i].price, side: 'GAP', color: 'text-yellow', status: '<-- DEAD ZONE' });
            } else {
                const isBuy = i < currentGapIdx;
                const sideStr = isBuy ? 'BUY' : 'SELL';
                
                const isActive = isBuy 
                    ? (i >= currentGapIdx - ACTIVE_WINDOW && i < currentGapIdx)
                    : (i > currentGapIdx && i <= currentGapIdx + ACTIVE_WINDOW);
                    
                const color = isActive ? (isBuy ? 'text-green' : 'text-red') : 'text-muted';
                const status = isActive ? 'ACTIVE' : 'SHADOW';

                visualNodes.push({ price: gridNodes[i].price, side: sideStr, color: color, status: status });
            }
        }

        res.send(`
            <!DOCTYPE html><html><head><title>Nano AI Grid</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="refresh" content="15">
            <style>
                :root { --bg: #0b0f19; --card: #1e293b; --border: #334155; --text: #f8fafc; --muted: #64748b; --green: #10b981; --red: #ef4444; --blue: #3b82f6; --purple: #a855f7; --yellow: #eab308; }
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
                .text-green { color: var(--green); } .text-red { color: var(--red); } .text-yellow { color: var(--yellow); } .text-purple { color: var(--purple); } .text-blue { color: var(--blue); } .text-muted { color: var(--muted); }
                table { width: 100%; border-collapse: collapse; } th { text-align: left; font-size: 11px; color: var(--muted); padding: 8px; border-bottom: 1px solid var(--border); } td { padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; }
                .ai-box { padding: 12px; border-radius: 4px; font-size: 12px; margin-top: 10px; line-height: 1.6; border-left: 3px solid var(--purple); background: rgba(168, 85, 247, 0.05); }
                .node-row { display: flex; justify-content: space-between; padding: 6px; border-bottom: 1px solid rgba(255,255,255,0.05); font-family: monospace; font-size:12px; }
            </style></head>
            <body><div class="container">
                <div class="header-flex">
                    <h2 style="color:var(--purple); margin:0;">NANO AI GRID</h2>
                    <span style="font-size: 10px; color: var(--muted);">Refresh: ${new Date().toLocaleTimeString()}</span>
                </div>

                <div class="grid" style="margin-bottom: 15px;">
                    <div class="card" style="margin-bottom: 0;"><div class="stat-title">BTC/USDT</div><div class="stat-value text-blue">$${currentPrice.toFixed(2)}</div></div>
                    <div class="card" style="margin-bottom: 0;"><div class="stat-title">Actual Wallet Balance</div><div class="stat-value">$${Number(walletBalance || 0).toFixed(4)}</div></div>
                    <div class="card" style="margin-bottom: 0;"><div class="stat-title">Daily Session Net PnL</div><div class="stat-value ${dailyPnL >= 0 ? 'text-green' : 'text-red'}">$${dailyPnL.toFixed(4)}</div></div>
                    <div class="card" style="margin-bottom: 0;"><div class="stat-title">All-Time Net PnL</div><div class="stat-value ${allTimePnL >= 0 ? 'text-green' : 'text-red'}">$${allTimePnL.toFixed(4)}</div></div>
                </div>

                <div class="card">
                    <h3 style="margin: 0 0 10px 0; font-size: 14px; color:var(--muted);">Grid Parameters & Execution</h3>
                    <div class="grid">
                        <div class="stat-box"><span class="label">Lower Bound</span><span class="value text-green">$${gridMin.toFixed(2)}</span></div>
                        <div class="stat-box"><span class="label">Upper Bound</span><span class="value text-red">$${gridMax.toFixed(2)}</span></div>
                        <div class="stat-box"><span class="label">Total Nodes</span><span class="value">${gridLevelsCount}</span></div>
                        <div class="stat-box"><span class="label">Spacing</span><span class="value">$${gridSpacing.toFixed(2)}</span></div>
                        <div class="stat-box"><span class="label">Active Window</span><span class="value text-purple">±${ACTIVE_WINDOW} Orders</span></div>
                        <div class="stat-box"><span class="label">Contracts per Node</span><span class="value">${gridQty}</span></div>
                    </div>
                    
                    <div class="ai-box">
                        <strong>AI Daily Thesis:</strong><br/><em>"${aiMacroRegime}"</em>
                    </div>
                </div>

                <div class="card">
                    <h3 style="margin: 0 0 10px 0; font-size: 14px; color:var(--muted);">Shadow Grid Radar</h3>
                    <div style="background: rgba(0,0,0,0.3); padding: 10px; border-radius: 8px;">
                        ${visualNodes.map(n => `<div class="node-row"><span class="${n.color}">${n.side}</span><span>${n.side === 'GAP' ? '' : '$'}${n.price.toFixed(2)}</span><span class="${n.color}">${n.status}</span></div>`).join('')}
                    </div>
                </div>

                <div class="card">
                    <h3 style="margin: 0 0 10px 0; font-size: 14px; color:var(--muted);">Realized Wallet Settlements (Exact USDT Difference)</h3>
                    <div style="overflow-x:auto;">
                        <table><tr><th>Time</th><th>Event</th><th>Price</th><th>Exact USDT Change</th></tr>
                        ${allTrades.map(t => `<tr>
                                <td>${formatPHT(t.time)}</td>
                                <td><span style="background:var(--blue); color:#fff; padding:2px 6px; border-radius:4px; font-size:10px;">${t.type}</span></td>
                                <td>$${(t.price||0).toFixed(2)}</td>
                                <td class="${(t.pnlUsd||0) >= 0 ? 'text-green' : 'text-red'}">${(t.pnlUsd||0) > 0 ? '+' : ''}$${(t.pnlUsd||0).toFixed(4)}</td>
                            </tr>`).join('')}
                        </table>
                    </div>
                </div>
            </div></body></html>`);
    } catch (e) { res.send(`<div>UI Error: ${e.message}</div>`); }
});

// ==========================================
// STARTUP SCHEDULER & TRUE BALANCE TRACKER
// ==========================================
async function start() {
    try {
        const markets = await mexc.loadMarkets();
        contractSize = markets[SYMBOL].contractSize || 0.0001;
        
        const b = await mexc.fetchBalance(); 
        walletBalance = b.total['USDT'] || 0;

        let state = await BotState.findOne({ key: 'main' });
        if (!state) {
            await BotState.create({ key: 'main', initialBalance: walletBalance, dailyStartBalance: walletBalance, lastReset: new Date() });
        }
        
        await sendNotification(`🚀 Nano Grid AI Online. True Balance Tracking Active.`);
        
        await buildDynamicGrid(); 
        
        setInterval(reconcileGrid, 15000); 
        
        setInterval(async () => { 
            try { 
                const bal = await mexc.fetchBalance(); 
                const newBal = bal.total['USDT'] || 0; 
                
                if (newBal > 0) {
                    const diff = newBal - walletBalance;
                    if (Math.abs(diff) > 0.0001) {
                        await Trade.create({ 
                            type: 'Wallet Settlement', 
                            price: currentPrice, 
                            pnlUsd: diff 
                        });
                    }
                    walletBalance = newBal;
                }
            } catch(e){} 
        }, 30000);                          
        
        setInterval(async () => {
            const currentBal = await mexc.fetchBalance().then(b => b.total['USDT'] || walletBalance);
            await BotState.updateOne({ key: 'main' }, { $set: { dailyStartBalance: currentBal, lastReset: new Date() } });
            await buildDynamicGrid();
        }, 86400000); 
        
    } catch (e) { console.error(e); setTimeout(start, 10000); }
}

app.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
    start();
});
