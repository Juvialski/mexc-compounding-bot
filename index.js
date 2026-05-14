// ==========================================
// DYNAMIC AI GRID EDITION - NANO-ACCOUNT SAFE
// ==========================================
require('dotenv').config();
const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const { ATR } = require('technicalindicators');
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
let dailyPnL = 0;

// AI Grid State
let isReconciling = false;
let gridActive = false;
let gridMin = 0;
let gridMax = 0;
let gridLevelsCount = 0;
let gridSpacing = 0;
let gridQty = 1; // Defaulting to 1 for nano accounts
let gridNodes = []; 
let lastGapIndex = -1;
let aiMacroRegime = "Awaiting first AI Grid analysis...";
const ACTIVE_WINDOW = 3; // ONLY PLACE 3 ORDERS ABOVE AND 3 BELOW (Anti-Margin Exhaustion)

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
            await sleep(500); // Rate limit protection
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

        const ohlcv = await mexc.fetchOHLCV(SYMBOL, '1d', undefined, 30);
        const closes = ohlcv.map(c => c[4]);
        const highs = ohlcv.map(c => c[2]);
        const lows = ohlcv.map(c => c[3]);
        
        const atr14 = ATR.calculate({ period: 14, high: highs, low: lows, close: closes }).pop() || 1500;
        const currentPriceObj = await mexc.fetchTicker(SYMBOL);
        currentPrice = Number(currentPriceObj.last);

        const prompt = `
        You are managing a Grid Bot on MEXC for ${SYMBOL}.
        CRITICAL: The user has an extremely low balance ($${walletBalance.toFixed(2)}). 
        Current Price: $${currentPrice}
        14-Day ATR: $${atr14}

        Define a safe daily grid. Since balance is low, keep the grid relatively tight around the current price so the bot can capture smaller chops without requiring massive margin to span a huge range.
        
        Provide:
        - lower_bound: price for the bottom grid line
        - upper_bound: price for the top grid line
        - grid_levels: strictly between 15 and 30 levels.
        - reasoning: 1 sentence strategy explanation.

        Use JSON ONLY: {"lower_bound": 60000, "upper_bound": 65000, "grid_levels": 20, "reasoning": "..."}
        `;

        let aiDecision;
        try {
            aiDecision = await askAIWithRetry(prompt, 2, 5000);
        } catch (e) {
            console.log("AI Failed, using fallback defaults.");
            aiDecision = {
                lower_bound: currentPrice - atr14,
                upper_bound: currentPrice + atr14,
                grid_levels: 20,
                reasoning: "Fallback ATR bounds applied."
            };
        }

        await mexc.cancelAllOrders(SYMBOL);
        await sleep(500);
        await closeAllPositions();

        gridMin = aiDecision.lower_bound;
        gridMax = aiDecision.upper_bound;
        gridLevelsCount = aiDecision.grid_levels;
        aiMacroRegime = aiDecision.reasoning;

        gridSpacing = (gridMax - gridMin) / gridLevelsCount;
        gridNodes = [];
        for(let i = 0; i <= gridLevelsCount; i++) {
            gridNodes.push({ price: parseFloat((gridMin + (i * gridSpacing)).toFixed(2)) });
        }

        // Lock Qty to minimum 1 for nano accounts, unless balance grows significantly
        let idealQty = Math.floor((walletBalance * 0.5 * LEVERAGE / gridLevelsCount) / (currentPrice * contractSize));
        gridQty = Math.max(1, idealQty); 

        lastGapIndex = -1; 
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
    if (isReconciling || !gridActive) return;
    isReconciling = true;
    
    try {
        const ticker = await mexc.fetchTicker(SYMBOL);
        currentPrice = Number(ticker.last);

        // 1. OOB Emergency Recalibration
        if (currentPrice < gridMin - (gridSpacing*2) || currentPrice > gridMax + (gridSpacing*2)) {
            console.log("Price out of bounds! Recalibrating...");
            await sendNotification(`🚨 Out of Bounds ($${currentPrice.toFixed(2)}). Recalibrating Grid...`);
            gridActive = false;
            await buildDynamicGrid();
            isReconciling = false;
            return;
        }

        // 2. Find Current Gap (closest node)
        let minDiff = Infinity;
        let targetGapIndex = -1;
        for (let i = 0; i < gridNodes.length; i++) {
            const diff = Math.abs(gridNodes[i].price - currentPrice);
            if (diff < minDiff) { minDiff = diff; targetGapIndex = i; }
        }

        // Detect Profit Trigger
        if (lastGapIndex !== -1 && targetGapIndex !== lastGapIndex) {
            const crossed = Math.abs(targetGapIndex - lastGapIndex);
            const profitPerNode = gridSpacing * gridQty * contractSize;
            const realizedPnL = crossed * profitPerNode;
            dailyPnL += realizedPnL;
            
            await Trade.create({ type: 'Grid Fill', price: currentPrice, pnlUsd: realizedPnL });
            console.log(`Profit Captured! Shifted ${crossed} node(s). Approx PnL: $${realizedPnL.toFixed(4)}`);
        }
        lastGapIndex = targetGapIndex;

        // 3. Define the Active Window (Shadow Grid Optimization)
        const activeIndices = [];
        for(let i = Math.max(0, targetGapIndex - ACTIVE_WINDOW); i <= Math.min(gridNodes.length - 1, targetGapIndex + ACTIVE_WINDOW); i++) {
            if (i !== targetGapIndex) activeIndices.push(i);
        }

        // 4. Fetch Book & Align Orders with Anti-Spam Delays
        const openOrders = await mexc.fetchOpenOrders(SYMBOL);
        const ordersToKeep = [];

        for (let o of openOrders) {
            let matchedIdx = -1;
            let mDiff = Infinity;
            for(let i = 0; i < gridNodes.length; i++){
                const d = Math.abs(gridNodes[i].price - o.price);
                if(d < mDiff && d < (gridSpacing * 0.2)) { mDiff = d; matchedIdx = i; }
            }

            const expectedSide = matchedIdx < targetGapIndex ? 'buy' : 'sell';

            // Cancel if out of active window, wrong side, or wrong size
            if (!activeIndices.includes(matchedIdx) || o.side !== expectedSide || o.amount !== gridQty) {
                try {
                    await mexc.cancelOrder(o.id, SYMBOL);
                    await sleep(200); // 200ms ANTI-SPAM THROTTLE
                } catch(e) { }
            } else {
                ordersToKeep.push(matchedIdx);
            }
        }

        // 5. Place Missing Orders within Active Window
        for (let i of activeIndices) {
            if (!ordersToKeep.includes(i)) {
                const desiredSide = i < targetGapIndex ? 'buy' : 'sell';
                try {
                    await mexc.createLimitOrder(SYMBOL, desiredSide, gridQty, gridNodes[i].price);
                    await sleep(200); // 200ms ANTI-SPAM THROTTLE
                } catch(e) {
                    if (e.message.includes('balance') || e.message.includes('margin')) {
                        console.error("Margin low, pausing order placement momentarily.");
                        break; 
                    }
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
    if (dbStatus !== "Connected" || gridNodes.length === 0) return res.send(`<h2>AI Grid Initializing... (Fetching AI Data)</h2>`);
    try {
        const allTrades = await Trade.find().sort({ time: -1 }).limit(10).lean();
        const totalPnl = (await Trade.find()).reduce((sum, t) => sum + (t.pnlUsd || 0), 0);

        let startIdx = Math.max(0, lastGapIndex - ACTIVE_WINDOW - 1);
        let endIdx = Math.min(gridNodes.length - 1, lastGapIndex + ACTIVE_WINDOW + 1);
        let visualNodes = [];
        for(let i = endIdx; i >= startIdx; i--) { 
            const isActive = i >= targetGapIndex - ACTIVE_WINDOW && i <= targetGapIndex + ACTIVE_WINDOW && i !== lastGapIndex;
            visualNodes.push({
                price: gridNodes[i].price,
                side: i < lastGapIndex ? 'BUY' : i > lastGapIndex ? 'SELL' : 'GAP (Current)',
                color: i === lastGapIndex ? 'text-yellow' : isActive ? (i < lastGapIndex ? 'text-green' : 'text-red') : 'text-muted',
                status: isActive ? 'ACTIVE' : (i === lastGapIndex ? '<-- YOU ARE HERE' : 'SHADOW (Inactive)')
            });
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
                    <div class="card" style="margin-bottom: 0;"><div class="stat-title">Wallet</div><div class="stat-value">$${Number(walletBalance || 0).toFixed(2)}</div></div>
                    <div class="card" style="margin-bottom: 0;"><div class="stat-title">Daily Session PnL</div><div class="stat-value ${dailyPnL >= 0 ? 'text-green' : 'text-red'}">$${dailyPnL.toFixed(4)}</div></div>
                    <div class="card" style="margin-bottom: 0;"><div class="stat-title">All-Time PnL</div><div class="stat-value ${totalPnl >= 0 ? 'text-green' : 'text-red'}">$${totalPnl.toFixed(4)}</div></div>
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
                        ${visualNodes.map(n => `<div class="node-row"><span class="${n.color}">${n.side}</span><span>$${n.price.toFixed(2)}</span><span class="${n.color}">${n.status}</span></div>`).join('')}
                    </div>
                    <div style="margin-top:8px; font-size:10px; text-align:center; color:var(--muted);">To prevent margin exhaustion on $16 account, bot only places orders marked ACTIVE. Shadow levels are held in AI memory.</div>
                </div>

                <div class="card">
                    <h3 style="margin: 0 0 10px 0; font-size: 14px; color:var(--muted);">Recent Grid Fills</h3>
                    <div style="overflow-x:auto;">
                        <table><tr><th>Time</th><th>Event</th><th>Price Crossed</th><th>PnL USD</th></tr>
                        ${allTrades.map(t => `<tr>
                                <td>${formatPHT(t.time)}</td>
                                <td><span style="background:var(--blue); color:#fff; padding:2px 6px; border-radius:4px; font-size:10px;">${t.type}</span></td>
                                <td>$${(t.price||0).toFixed(2)}</td>
                                <td class="text-green">+$${(t.pnlUsd||0).toFixed(4)}</td>
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
        
        await sendNotification(`🚀 Nano Grid AI Online. Safeguards active.`);
        
        await buildDynamicGrid(); 
        
        // Check grid every 15 seconds (Only fires API calls if order actually missing)
        setInterval(reconcileGrid, 15000); 
        
        // Check balance quietly every minute
        setInterval(async () => { try { const b = await mexc.fetchBalance(); walletBalance = b.total['USDT'] || 0; } catch(e){} }, 60000);                          
        
        // Daily AI Recalibration
        setInterval(async () => {
            dailyPnL = 0; 
            await buildDynamicGrid();
        }, 86400000); 
        
    } catch (e) { console.error(e); setTimeout(start, 10000); }
}

app.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
    start();
});
