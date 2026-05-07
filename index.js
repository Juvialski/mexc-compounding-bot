require('dotenv').config();
const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const { RSI, SMA, ATR } = require('technicalindicators');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 10000;

// ==========================================
// GEMINI AI SETUP
// ==========================================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash", 
    generationConfig: {
        responseMimeType: "application/json",
    }
});

// ==========================================
// EVOLVING PARAMETERS & STATE
// ==========================================
let dna = {
    rsiThreshold: 30,
    atrMultiplier: 2.0,
    rewardRatio: 2.2,
    lastEvolved: 'Initialising...',
    aiReasoning: 'Waiting for first evolution...'
};

const SYMBOL = 'BTC/USDT:USDT';
const TIMEFRAME = '1m'; 
const LEVERAGE = 10;
const RISK_PERCENT = 5.0; 
const TAKER_FEE = 0.0006;
const SIMULATED_SLIPPAGE = 0.0005; 

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

// NEW AI MEMORY STATES
let aiMacroRegime = "Awaiting initial analysis...";
let aiRecentLessons = ["No recent trades to analyze."];

// Helper: Format to Philippine Time (PHT)
const formatPHT = (dateInput) => {
    if (!dateInput) return 'N/A';
    return new Date(dateInput).toLocaleString('en-US', { 
        timeZone: 'Asia/Manila',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true 
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
            body: JSON.stringify({ content: `🎯 **Sniper V11.4 (AI Edition)**\n${message}` })
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
    equityAfter: Number, isWin: Boolean, time: { type: Date, default: Date.now },
    aiConfidence: Number 
}));

async function pruneDatabase() {
    try {
        const thirtyDaysAgo = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000));
        await Trade.deleteMany({ time: { $lt: thirtyDaysAgo } });
    } catch (e) { console.error("DB Pruning Error:", e.message); }
}

// ==========================================
// AI PILLAR 2: MACRO REGIME ANALYSIS
// ==========================================
async function analyzeMarketState() {
    try {
        // Fetch 15-minute candles for Macro view
        const ohlcv15m = await mexc.fetchOHLCV(SYMBOL, '15m', undefined, 100);
        const closes = ohlcv15m.map(c => c[4]);
        
        const rsi15 = RSI.calculate({ period: 14, values: closes }).pop();
        const sma50 = SMA.calculate({ period: 50, values: closes }).pop();
        const price = closes[closes.length - 1];

        const prompt = `
        You are the Head Market Analyst for a crypto trading desk. 
        Analyze the 15-minute timeframe for ${SYMBOL}.
        Current Price: $${price} | 15m SMA(50): $${sma50.toFixed(2)} | 15m RSI: ${rsi15.toFixed(2)}.
        Determine the overarching market regime (e.g., Choppy, Trending Bullish, Overextended Bearish).
        Use this exact JSON schema: {"regime": "1-3 word description", "advice": "One sentence tip for 1-minute scalping right now."}`;

        const result = await aiModel.generateContent(prompt);
        const responseText = result.response.text().trim();
        const aiDecision = JSON.parse(responseText);

        aiMacroRegime = `${aiDecision.regime} - ${aiDecision.advice}`;
        console.log(`🌐 Macro State Updated: ${aiMacroRegime}`);
    } catch (e) {
        console.error("Macro Analysis Error:", e.message);
    }
}

// ==========================================
// AI PILLAR 4: POST-TRADE REFLECTION
// ==========================================
async function postTradeReflection(tradeData) {
    try {
        const prompt = `
        A 1-minute scalp trade just closed on ${SYMBOL}.
        Side: ${tradeData.side} | Entry: $${tradeData.entry} | Exit: $${tradeData.exit} | PnL: ${tradeData.pnlPercent.toFixed(2)}%.
        AI Confidence on entry was: ${tradeData.aiConfidence}%.
        Provide a 1-sentence lesson learned from this trade to improve future entries or risk management.
        Use this exact JSON schema: {"lesson": "your 1 sentence lesson"}`;

        const result = await aiModel.generateContent(prompt);
        const responseText = result.response.text().trim();
        const aiDecision = JSON.parse(responseText);

        // Add to memory, keep only the last 3 lessons to save tokens
        if (aiRecentLessons[0] === "No recent trades to analyze.") aiRecentLessons.shift();
        aiRecentLessons.push(`[${tradeData.pnlPercent > 0 ? 'WIN' : 'LOSS'}] ${aiDecision.lesson}`);
        if (aiRecentLessons.length > 3) aiRecentLessons.shift();

        console.log(`🧠 AI Learned: ${aiDecision.lesson}`);
    } catch (e) {
        console.error("Post-Trade Reflection Error:", e.message);
    }
}

// ==========================================
// AI PILLAR 1: EVOLUTION ENGINE
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
        const sma60V = SMA.calculate({ period: 60, values: closes }); 

        const offsetRSI = closes.length - rsiV.length;
        const offsetSMA = closes.length - smaV.length;
        const feePercent = (TAKER_FEE * 2) + SIMULATED_SLIPPAGE; 

        const testSettings = (rsiT, atrM, rr) => {
            let score = 0; let tradesCount = 0;
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
                    tradesCount++; const sl = price - riskDist; const tp = price + (riskDist * rr);
                    for (let j = 1; j <= 12; j++) {
                        let hitSL = lows[i + j] <= sl; let hitTP = highs[i + j] >= tp;
                        if (hitSL && hitTP) hitTP = false; 
                        if (hitSL) { score -= (riskPct + feePercent); break; }
                        if (hitTP) { score += (rewardPct - feePercent); break; }
                    }
                }
                if (price < sma && rsi > (100 - rsiT)) {
                    tradesCount++; const sl = price + riskDist; const tp = price - (riskDist * rr);
                    for (let j = 1; j <= 12; j++) {
                        let hitSL = highs[i + j] >= sl; let hitTP = lows[i + j] <= tp;
                        if (hitSL && hitTP) hitTP = false; 
                        if (hitSL) { score -= (riskPct + feePercent); break; }
                        if (hitTP) { score += (rewardPct - feePercent); break; }
                    }
                }
            }
            return { score, tradesCount, rsiThreshold: rsiT, atrMultiplier: atrM, rewardRatio: rr };
        };

        let results =[];
        for (let r of [25, 30, 35, 40]) {
            for (let a of [1.5, 2.0, 2.5]) {
                for (let rr of [1.5, 2.0, 2.5, 3.0]) {
                    results.push(testSettings(r, a, rr));
                }
            }
        }

        results.sort((a, b) => b.score - a.score);
        const top3 = results.slice(0, 3);
        
        const currentPrice = closes[closes.length - 1];
        const currentSMA = smaV[smaV.length - 1];
        const currentSMA60 = sma60V[sma60V.length - 1];
        const currentATR = atrV[atrV.length - 1];
        
        const trend = currentPrice > currentSMA ? "Bullish" : "Bearish";
        const htfTrend = currentPrice > currentSMA60 ? "Bullish" : "Bearish";

        try {
            const prompt = `
            You are a crypto quantitative analyst evaluating 1-minute BTC parameters.
            Current 1m Trend: ${trend} | 1H Trend: ${htfTrend} | Price: $${currentPrice} | Volatility: $${currentATR.toFixed(2)}.
            Top 3 parameter sets by net backtest score:
            1. RSI: ${top3[0].rsiThreshold}, ATRx: ${top3[0].atrMultiplier}, RR: ${top3[0].rewardRatio}, Score: ${top3[0].score.toFixed(4)}, Trades: ${top3[0].tradesCount}
            2. RSI: ${top3[1].rsiThreshold}, ATRx: ${top3[1].atrMultiplier}, RR: ${top3[1].rewardRatio}, Score: ${top3[1].score.toFixed(4)}, Trades: ${top3[1].tradesCount}
            3. RSI: ${top3[2].rsiThreshold}, ATRx: ${top3[2].atrMultiplier}, RR: ${top3[2].rewardRatio}, Score: ${top3[2].score.toFixed(4)}, Trades: ${top3[2].tradesCount}
            Select the best set (1, 2, or 3) to avoid curve-fitting.
            Use exact JSON schema: {"selection": 1, "reasoning": "short explanation"}`;

            const result = await aiModel.generateContent(prompt);
            const responseText = result.response.text().trim();
            const aiDecision = JSON.parse(responseText);
            const selected = top3[(aiDecision.selection - 1) || 0]; 
            
            dna = { 
                rsiThreshold: selected.rsiThreshold, atrMultiplier: selected.atrMultiplier, 
                rewardRatio: selected.rewardRatio, lastEvolved: formatPHT(new Date()),
                aiReasoning: aiDecision.reasoning
            };
            console.log(`🧬 DNA Evolved. Selection ${aiDecision.selection}: ${aiDecision.reasoning}`);
        } catch (aiErr) {
            console.error("Evolution AI Error. Fallback to top score.");
            dna = { ...top3[0], lastEvolved: formatPHT(new Date()), aiReasoning: "Fallback to highest backtest score (AI failed)." };
        }
    } catch (e) { console.error("Evolution Error:", e.message); }
}

// ==========================================
// AI PILLAR 3: TRADING TICKER & VALIDATION
// ==========================================
async function tick() {
    if (isTrading) return;
    isTrading = true;
    try {
        const[ticker, pos, ohlcv] = await Promise.all([
            mexc.fetchTicker(SYMBOL),
            mexc.fetchPositions([SYMBOL]),
            mexc.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 250)
        ]);

        lastTicker = ticker;
        const price = Number(ticker.last || 0);
        const rawPos = pos.find(p => p.symbol === SYMBOL && (parseFloat(p.contracts) > 0 || parseFloat(p.amount) > 0 || parseFloat(p.info?.position) > 0));

        if (rawPos) {
            const side = rawPos.side.toUpperCase();
            const entryPrice = Number(rawPos.entryPrice || rawPos.price || rawPos.average || 0);
            let contracts = Number(rawPos.contracts || rawPos.amount || 0);
            if (contracts === 0 && rawPos.info && rawPos.info.position) { contracts = Number(rawPos.info.position); }
            const isLong = side === 'LONG';
            const pnlUsd = (isLong ? (price - entryPrice) : (entryPrice - price)) * contracts * contractSize;
            let roe = 0;
            if (entryPrice > 0) {
                const diff = isLong ? (price - entryPrice) : (entryPrice - price);
                roe = (diff / entryPrice) * LEVERAGE * 100;
            }
            activePosition = { side, entry: entryPrice, size: contracts, pnlUsd, roe, aiConfidence: activePosition?.aiConfidence || 0 };

        } else if (activePosition && !rawPos) {
            const isLong = activePosition.side === 'LONG';
            const finalPnlUsd = (isLong ? (price - activePosition.entry) : (activePosition.entry - price)) * activePosition.size * contractSize;
            let finalRoe = 0;
            if (activePosition.entry > 0) {
                const diff = isLong ? (price - activePosition.entry) : (activePosition.entry - price);
                finalRoe = (diff / activePosition.entry) * LEVERAGE * 100;
            }

            const tradeToSave = { 
                side: activePosition.side, entry: activePosition.entry, exit: price, 
                pnlUsd: finalPnlUsd, pnlPercent: finalRoe, equityAfter: walletBalance + finalPnlUsd, 
                isWin: finalPnlUsd > 0, time: new Date(), aiConfidence: activePosition.aiConfidence || 0
            };

            await Trade.create(tradeToSave);
            await sendNotification(`**Position Closed** 🏁\nSide: ${activePosition.side}\nExit: $${price.toFixed(2)}\nPnL: $${finalPnlUsd.toFixed(2)} (${finalRoe.toFixed(2)}%)`);
            
            // Trigger Post-Trade AI Reflection (Does not block tick)
            postTradeReflection(tradeToSave);
            
            activePosition = null;

        } else if (Date.now() - lastOrderTime > 60000) {
            activePosition = null;
            const closes = ohlcv.map(c => c[4]);
            
            const rsi = RSI.calculate({ period: 14, values: closes }).pop();
            const sma = SMA.calculate({ period: 200, values: closes }).pop();
            const sma60 = SMA.calculate({ period: 60, values: closes }).pop(); 
            const atr = ATR.calculate({ period: 14, high: ohlcv.map(c=>c[2]), low: ohlcv.map(c=>c[3]), close: closes }).pop();

            let action = null; let orderSide = null;
            if (price > (sma || 0) && (rsi || 50) < dna.rsiThreshold) { action = 'LONG'; orderSide = 'buy'; }
            else if (price < (sma || 0) && (rsi || 50) > (100 - dna.rsiThreshold)) { action = 'SHORT'; orderSide = 'sell'; }

            if (action) {
                let aiConfidence = 100; let aiApproved = true; let aiNotes = "Technical Signal Triggered.";
                const htfTrend = price > sma60 ? "Bullish" : "Bearish";

                try {
                    const prompt = `
                    You are the ultimate crypto risk manager. A ${action} signal fired for 1m ${SYMBOL}.
                    Price: $${price} | 1m SMA(200): $${sma.toFixed(2)} | 1H Trend: ${htfTrend}
                    1m RSI: ${rsi.toFixed(2)} | 1m ATR: $${atr.toFixed(2)}
                    
                    MACRO REGIME CONTEXT: ${aiMacroRegime}
                    RECENT AI MEMORY (Lessons from past trades): ${aiRecentLessons.join(" | ")}
                    
                    Based on technicals, macro regime, and past lessons, validate this trade. 
                    Use exact JSON schema: {"approved": true/false, "confidence_score_1_to_100": 85, "reason": "brief reason"}`;
                    
                    const result = await aiModel.generateContent(prompt);
                    const responseText = result.response.text().trim();
                    const aiDecision = JSON.parse(responseText);

                    aiApproved = aiDecision.approved; aiConfidence = aiDecision.confidence_score_1_to_100; aiNotes = aiDecision.reason;
                } catch (e) { 
                    console.error("AI Validation Error:", e.message); 
                }

                if (aiApproved && aiConfidence >= 50) {
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
                            'takeProfit': parseFloat(tp.toFixed(2)),
                            'postOnly': true 
                        };

                        await mexc.createOrder(SYMBOL, 'limit', orderSide, qty, price, params);
                        lastOrderTime = Date.now();
                        activePosition = { aiConfidence }; 

                        await sendNotification(`**New Position Opened** 🚀\nSide: ${action}\nLimit Price: $${price.toFixed(2)}\nSize: ${qty}\nLeverage: ${LEVERAGE}x\n🧠 **AI Confidence:** ${aiConfidence}%\n💬 **Notes:** ${aiNotes}`);
                    }
                } else {
                    console.log(`🤖 AI Rejected Trade: ${action} - Confidence: ${aiConfidence}%. Reason: ${aiNotes}`);
                    lastOrderTime = Date.now() - 30000; // brief cooldown
                }
            }
        }
    } catch (e) { console.error("Tick Error:", e.message); }
    finally { isTrading = false; }
}

// ==========================================
// ROUTES & UI
// ==========================================
app.get('/reset-db', async (req, res) => {
    try { await Trade.deleteMany({}); res.send(`<h2>✅ Database Cleared!</h2>`); } 
    catch (e) { res.send(`Error: ${e.message}`); }
});

app.get('/ping', (req, res) => res.status(200).send('pong'));

app.get('/', async (req, res) => {
    if (dbStatus !== "Connected") return res.send(`<h2>System Initializing...</h2>`);
    try {
        const allTrades = await Trade.find().sort({ time: -1 }).limit(10).lean();
        const totalPnl = (await Trade.find()).reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
        const winCount = await Trade.countDocuments({ isWin: true });
        const totalCount = await Trade.countDocuments();
        const winRate = totalCount > 0 ? ((winCount / totalCount) * 100).toFixed(1) : 0;

        let activeCard = `<div class="card active-card"><h2 style="color:var(--muted); text-align:center; margin:0;">SCANNING MARKET...</h2></div>`;

        if (activePosition && activePosition.side) {
            activeCard = `
            <div class="card active-card pulse-border">
                <div class="card-header"><h2 style="margin:0;"><span class="pulse-dot ${activePosition.side === 'LONG'?'dot-green':'dot-red'}"></span> ACTIVE ${activePosition.side}</h2></div>
                <div class="grid" style="margin-top:15px;">
                    <div class="stat-box"><span class="label">Entry</span><span class="value">$${(activePosition.entry || 0).toFixed(1)}</span></div>
                    <div class="stat-box"><span class="label">ROE %</span><span class="value ${activePosition.roe >= 0 ? 'text-green' : 'text-red'}">${(activePosition.roe || 0).toFixed(2)}%</span></div>
                    <div class="stat-box"><span class="label">PnL USD</span><span class="value ${activePosition.pnlUsd >= 0 ? 'text-green' : 'text-red'}">$${(activePosition.pnlUsd || 0).toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">Size</span><span class="value">${activePosition.size || 0}</span></div>
                </div>
            </div>`;
        }

        res.send(`
            <!DOCTYPE html><html><head><title>Elite Sniper V11.4 AI</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="refresh" content="10">
            <style>
                :root { --bg: #0b0f19; --card: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; --green: #10b981; --red: #ef4444; --blue: #a855f7; --yellow: #eab308; }
                body { background: var(--bg); color: var(--text); font-family: sans-serif; padding: 15px; margin: 0; }
                .container { max-width: 900px; margin: auto; }
                .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
                .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 15px; margin-bottom: 15px; }
                .stat-title { color: var(--muted); font-size: 11px; text-transform: uppercase; }
                .stat-value { font-size: 18px; font-weight: 800; margin-top: 5px; }
                .active-card { border-color: var(--blue); background: #1a1025; }
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
                .ai-box { background: rgba(168, 85, 247, 0.05); padding: 12px; border-left: 3px solid var(--blue); border-radius: 4px; font-size: 12px; margin-top: 10px; line-height: 1.6; }
                .memory-box { background: rgba(234, 179, 8, 0.05); border-left: 3px solid var(--yellow); padding: 12px; border-radius: 4px; font-size: 12px; margin-top: 10px; line-height: 1.6; }
                @keyframes border-pulse { 0%, 100% { border-color: var(--blue); } 50% { border-color: var(--border); } }
            </style></head>
            <body><div class="container">
                <h2 style="text-align:center; color:var(--blue); margin-top:5px; margin-bottom:20px;">🧠 SNIPER V11.4 AI EDITION</h2>
                <div class="grid">
                    <div class="card"><div class="stat-title">Wallet</div><div class="stat-value">$${Number(walletBalance || 0).toFixed(2)}</div></div>
                    <div class="card"><div class="stat-title">BTC Price</div><div class="stat-value">$${Number(lastTicker.last || 0).toFixed(1)}</div></div>
                    <div class="card"><div class="stat-title">Net Profit</div><div class="stat-value ${totalPnl >= 0 ? 'text-green' : 'text-red'}">$${totalPnl.toFixed(2)}</div></div>
                    <div class="card"><div class="stat-title">Win Rate</div><div class="stat-value">${winRate}%</div></div>
                </div>
                ${activeCard}
                
                <div class="card">
                    <h3 style="margin: 0; font-size: 14px; color:var(--muted);">🧠 AI Brain & Memory States</h3>
                    
                    <div class="ai-box">
                        <strong>🧬 DNA Evolution (Tested Hourly):</strong><br/>
                        <span style="color:var(--muted);">Last Evolved: ${dna.lastEvolved} | RSI: ${dna.rsiThreshold} | ATR: ${dna.atrMultiplier}x | RR: ${dna.rewardRatio}x</span><br/>
                        <em>"${dna.aiReasoning}"</em>
                    </div>
                    
                    <div class="ai-box" style="border-left-color: var(--green); background: rgba(16,185,129,0.05);">
                        <strong>🌐 15m Macro Regime (Updated 30m):</strong><br/>
                        <em>"${aiMacroRegime}"</em>
                    </div>

                    <div class="memory-box">
                        <strong>💡 AI Short-Term Memory (Post-Trade Lessons):</strong><br/>
                        <ul style="margin: 5px 0; padding-left: 20px;">
                            ${aiRecentLessons.map(lesson => `<li><em>${lesson}</em></li>`).join('')}
                        </ul>
                    </div>
                </div>

                <div class="card">
                    <h3 style="margin: 0 0 10px 0; font-size: 14px; color:var(--muted);">Trade History (10 Recent)</h3>
                    <div style="overflow-x:auto;">
                        <table><tr><th>Time</th><th>Side</th><th>PnL %</th><th>PnL USD</th><th>AI Score</th></tr>
                        ${allTrades.map(t => {
                            const pnlPct = Number(t.pnlPercent) || 0;
                            const tradeTime = t.time ? new Date(t.time) : new Date();
                            return `<tr>
                                <td>${formatPHT(tradeTime)}</td>
                                <td><span class="badge ${t.side==='LONG'?'badge-green':'badge-red'}">${t.side}</span></td>
                                <td class="${pnlPct>=0?'text-green':'text-red'}">${pnlPct.toFixed(2)}%</td>
                                <td class="${(t.pnlUsd || 0)>=0?'text-green':'text-red'}">$${(t.pnlUsd || 0).toFixed(2)}</td>
                                <td>${t.aiConfidence ? t.aiConfidence+'%' : 'N/A'}</td>
                            </tr>`
                        }).join('')}
                        </table>
                    </div>
                </div>
            </div></body></html>`);
    } catch (e) { res.send(`<div>UI Error: ${e.message}</div>`); }
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
        
        // Stagger startup calls to respect burst rate limits
        await analyzeMarketState(); 
        setTimeout(async () => { await evolve(); }, 3000); 
        
        await sendNotification(`System Started & AI Architecture Online.`);
        
        setInterval(tick, 5000);           
        setInterval(analyzeMarketState, 1800000); // Every 30 mins
        setInterval(async () => { await evolve(); await pruneDatabase(); }, 3600000); // Every 1 hour      
        setInterval(async () => { try { const b = await mexc.fetchBalance(); walletBalance = b.total['USDT'] || 0; } catch(e) {} }, 30000);                          
        
    } catch (e) { console.error(e); setTimeout(start, 10000); }
}

app.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
    start();
});
