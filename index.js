// ==========================================
// Paste May 2026 - STEP-TRAILING & SMALL WINS EDITION
// ==========================================
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
            const is503 = error.message && error.message.includes('503');
            const is429 = error.message && error.message.includes('429');
            if ((is503 || is429) && attempt < maxRetries) {
                const delay = is429 ? 60000 : baseDelayMs * attempt; 
                console.warn(`Gemini API Rate Limit/Error. Retrying attempt ${attempt + 1} in ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                throw error; 
            }
        }
    }
}

// ==========================================
// EVOLVING PARAMETERS & CONSTANTS
// ==========================================
const SYMBOL = 'BTC/USDT:USDT';
const TIMEFRAME = '1m'; 
const LEVERAGE = 10;
const TAKER_FEE = 0.0006;
const SIMULATED_SLIPPAGE = 0.0005; 

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' },
    enableRateLimit: true 
});

let dna = { rsiThreshold: 40, atrMultiplier: 2.0, rewardRatio: 2.2, lastEvolved: 'Initialising...', aiReasoning: 'Waiting...' };

// Global States
let isTrading = false;
let walletBalance = 0;
let lastTicker = { last: 0 };
let contractSize = 0.0001; 
let lastOrderTime = 0; 
let activePosition = null;

// Dashboard States
let latestRSI = 50, latestSMA = 0, latestATR = 0, htfTrendIndicator = "Awaiting tick...";

// ==========================================
// AI NEW CO-PILOT STATES
// ==========================================
let currentRiskPercent = 5.0; 
let aiMacroRegime = "Awaiting MTF analysis...";
let aiRecentLessons =["No recent trades."];
let eodStrategyShift = "Awaiting first End-Of-Day Debrief...";
let latestAnomaly = "No anomalies detected yet.";
let inTradeAiStatus = "No active trade.";
let lastInTradeCheck = 0;
let volumeAnomalyCooldown = 0;

const formatPHT = (dateInput) => {
    if (!dateInput) return 'N/A';
    return new Date(dateInput).toLocaleString('en-US', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
};

async function sendNotification(message) {
    const webhookUrl = process.env.WEBHOOK_URL; 
    if (!webhookUrl) return; 
    try {
        await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `Sniper AI Co-Pilot\n${message}` }) });
    } catch (e) { }
}

// ==========================================
// DATABASE SETUP
// ==========================================
let dbStatus = "Connecting...";
mongoose.connect(process.env.MONGO_URI)
    .then(() => { dbStatus = "Connected"; console.log("DB Connected"); })
    .catch(err => { dbStatus = "Error connecting to DB"; console.error("DB ERROR:", err); });

const Trade = mongoose.model('Trade', new mongoose.Schema({
    side: String, entry: Number, exit: Number, pnlUsd: Number, pnlPercent: Number, 
    equityAfter: Number, isWin: Boolean, time: { type: Date, default: Date.now }, aiConfidence: Number 
}));

async function pruneDatabase() {
    try { await Trade.deleteMany({ time: { $lt: new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)) } }); } 
    catch (e) { }
}

// ==========================================
// EOD DEBRIEF
// ==========================================
async function eodDebrief() {
    try {
        const past24h = new Date(Date.now() - (24 * 60 * 60 * 1000));
        const trades = await Trade.find({ time: { $gte: past24h } });
        if(trades.length === 0) return;

        const wins = trades.filter(t => t.isWin).length;
        const total = trades.length;
        const pnl = trades.reduce((sum, t) => sum + (t.pnlPercent || 0), 0);

        const prompt = `
        You are the Master Strategist. Review the last 24h of crypto scalping.
        Total Trades: ${total} | Wins: ${wins} | Net PnL: ${pnl.toFixed(2)}%.
        Recent Lessons learned: ${aiRecentLessons.join(" | ")}.
        Provide an End-of-Day debrief and dictate a strategy rule for the bot to follow tomorrow.
        Use JSON schema: {"daily_summary": "1 sentence recap", "tomorrow_strategy": "1 sentence strict rule"}`;

        const aiDecision = await askAIWithRetry(prompt);
        eodStrategyShift = `Summary: ${aiDecision.daily_summary} | Rule: ${aiDecision.tomorrow_strategy}`;
        console.log(`[EOD DEBRIEF] ${eodStrategyShift}`);
        sendNotification(`EOD Master Debrief Completed\nStrategy Shift: ${aiDecision.tomorrow_strategy}`);
    } catch (e) { console.error("EOD Debrief Error:", e.message); }
}

// ==========================================
// MTF CONFLUENCE & DYNAMIC RISK
// ==========================================
async function analyzeMarketState() {
    try {
        const[ohlcv1m, ohlcv15m, ohlcv1h, ohlcv4h] = await Promise.all([
            mexc.fetchOHLCV(SYMBOL, '1m', undefined, 50),
            mexc.fetchOHLCV(SYMBOL, '15m', undefined, 50),
            mexc.fetchOHLCV(SYMBOL, '1h', undefined, 50),
            mexc.fetchOHLCV(SYMBOL, '4h', undefined, 50)
        ]);

        const getStats = (candles) => {
            const closes = candles.map(c => c[4]);
            return {
                price: closes[closes.length - 1],
                rsi: RSI.calculate({ period: 14, values: closes }).pop() || 50,
                sma: SMA.calculate({ period: 20, values: closes }).pop() || 0
            };
        };

        const m1 = getStats(ohlcv1m); const m15 = getStats(ohlcv15m);
        const h1 = getStats(ohlcv1h); const h4 = getStats(ohlcv4h);

        const recentTrades = await Trade.find().sort({ time: -1 }).limit(10);
        const wins = recentTrades.filter(t => t.isWin).length;
        const winRate = recentTrades.length > 0 ? (wins / recentTrades.length) * 100 : 50;

        const prompt = `
        You are the Head Risk & Market Analyst. 
        Current Account Balance: $${walletBalance.toFixed(2)} | Recent Win Rate: ${winRate.toFixed(0)}%.
        Timeframe Data for ${SYMBOL}:
        - 1m: Price $${m1.price}, RSI ${m1.rsi.toFixed(1)}, SMA $${m1.sma.toFixed(1)}
        - 15m: RSI ${m15.rsi.toFixed(1)}, SMA $${m15.sma.toFixed(1)}
        - 1H: RSI ${h1.rsi.toFixed(1)}, SMA $${h1.sma.toFixed(1)}
        - 4H: RSI ${h4.rsi.toFixed(1)}, SMA $${h4.sma.toFixed(1)}

        1. Determine the overarching regime (Confluence).
        2. Set a strict rule for 1m scalping based on the MTF alignment.
        3. Recommend a dynamic Risk % per trade (between 1.0 and 6.0). Lower risk if choppy or win rate is low.
        Use JSON: {"regime": "short description", "advice": "1 sentence rule", "recommended_risk_percent": 3.5}`;

        const aiDecision = await askAIWithRetry(prompt);

        aiMacroRegime = `${aiDecision.regime} - ${aiDecision.advice}`;
        currentRiskPercent = aiDecision.recommended_risk_percent;
        console.log(`[MTF Analyzed] Regime: ${aiMacroRegime} | New Risk: ${currentRiskPercent}%`);
    } catch (e) { console.error("Macro Analysis Error:", e.message); }
}

// ==========================================
// POST-TRADE REFLECTION
// ==========================================
async function postTradeReflection(tradeData) {
    try {
        const prompt = `
        Trade closed on ${SYMBOL}. Side: ${tradeData.side} | PnL: ${tradeData.pnlPercent.toFixed(2)}%.
        AI Confidence on entry: ${tradeData.aiConfidence}%.
        Provide a 1-sentence lesson learned to improve future setups.
        Use JSON: {"lesson": "your 1 sentence lesson"}`;

        const aiDecision = await askAIWithRetry(prompt);

        if (aiRecentLessons[0] === "No recent trades.") aiRecentLessons.shift();
        aiRecentLessons.push(`[${tradeData.pnlPercent > 0 ? 'WIN' : 'LOSS'}] ${aiDecision.lesson}`);
        if (aiRecentLessons.length > 3) aiRecentLessons.shift();
    } catch (e) {}
}

// ==========================================
// EVOLUTION ENGINE
// ==========================================
async function evolve() {
    try {
        const ohlcv = await mexc.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 1000);
        const closes = ohlcv.map(c => c[4]); const highs = ohlcv.map(c => c[2]); const lows = ohlcv.map(c => c[3]);
        const rsiV = RSI.calculate({ period: 14, values: closes });
        const atrV = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
        const smaV = SMA.calculate({ period: 100, values: closes });

        const offsetRSI = closes.length - rsiV.length;
        const offsetSMA = closes.length - smaV.length;
        const feePercent = (TAKER_FEE * 2) + SIMULATED_SLIPPAGE; 

        const testSettings = (rsiT, atrM, rr) => {
            let score = 0; let tradesCount = 0;
            for (let i = 100; i < closes.length - 15; i++) {
                const price = closes[i]; const rsi = rsiV[i - offsetRSI]; const sma = smaV[i - offsetSMA]; const atr = atrV[i - offsetRSI];
                const riskDist = atr * atrM; if (riskDist === 0) continue;
                const riskPct = riskDist / price; const rewardPct = (riskDist * rr) / price;

                if (price > sma && rsi < rsiT) {
                    tradesCount++; const sl = price - riskDist; const tp = price + (riskDist * rr);
                    for (let j = 1; j <= 120 && (i + j) < closes.length; j++) {
                        if (lows[i + j] <= sl) { score -= (riskPct + feePercent); break; }
                        if (highs[i + j] >= tp) { score += (rewardPct - feePercent); break; }
                    }
                }
                if (price < sma && rsi > (100 - rsiT)) {
                    tradesCount++; const sl = price + riskDist; const tp = price - (riskDist * rr);
                    for (let j = 1; j <= 120 && (i + j) < closes.length; j++) {
                        if (highs[i + j] >= sl) { score -= (riskPct + feePercent); break; }
                        if (lows[i + j] <= tp) { score += (rewardPct - feePercent); break; }
                    }
                }
            }
            return { score, tradesCount, rsiThreshold: rsiT, atrMultiplier: atrM, rewardRatio: rr };
        };

        let results =[];
        for (let r of[35, 40, 45, 50]) for (let a of[1.5, 2.0, 2.5]) for (let rr of[1.5, 2.0, 2.5, 3.0]) results.push(testSettings(r, a, rr));
        results.sort((a, b) => b.score - a.score);
        
        const top = results[0];
        dna = { rsiThreshold: top.rsiThreshold, atrMultiplier: top.atrMultiplier, rewardRatio: top.rewardRatio, lastEvolved: formatPHT(new Date()), aiReasoning: "AI selected optimal backtested DNA based on current volatility." };
    } catch (e) { console.error("Evolution Error:", e.message); }
}

// ==========================================
// CORE TRADING TICKER
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
        const closes = ohlcv.map(c => c[4]);
        const volumes = ohlcv.map(c => c[5]);
        const rsi = RSI.calculate({ period: 14, values: closes }).pop() || 50;
        const sma100 = SMA.calculate({ period: 100, values: closes }).pop() || price;
        const sma60 = SMA.calculate({ period: 60, values: closes }).pop() || price;
        const atr = ATR.calculate({ period: 14, high: ohlcv.map(c=>c[2]), low: ohlcv.map(c=>c[3]), close: closes }).pop() || 10;
        const volSMA = SMA.calculate({ period: 20, values: volumes }).pop() || 1;
        const currentVol = volumes[volumes.length - 1];

        latestRSI = rsi; latestSMA = sma100; latestATR = atr;
        htfTrendIndicator = price > sma60 ? "Bullish" : "Bearish";

        // Console log for watching target
        if (!activePosition && (rsi < dna.rsiThreshold + 10 || rsi > (100 - dna.rsiThreshold) - 10)) {
            console.log(`[WATCHING] Price: $${price} | 1m SMA100: $${sma100.toFixed(2)} | 1m RSI: ${rsi.toFixed(2)} | Target: <${dna.rsiThreshold} or >${100 - dna.rsiThreshold}`);
        }

        // VOLUME ANOMALY DETECTOR
        if (!activePosition && currentVol > (volSMA * 3.5) && Date.now() > volumeAnomalyCooldown) {
            console.log("Volume Anomaly Detected! Asking AI...");
            try {
                const prompt = `
                Volume Spike on ${SYMBOL} 1m chart! Current Volume is ${currentVol.toFixed(2)}, which is 350%+ above the SMA (${volSMA.toFixed(2)}).
                Price is currently $${price}, RSI is ${rsi.toFixed(2)}. 
                Is this a breakout to follow, or a fakeout to fade? 
                Use JSON: {"is_manipulation": true/false, "advice": "short explanation"}`;
                
                const aiDecision = await askAIWithRetry(prompt, 1, 1000);
                latestAnomaly = `Detected at ${formatPHT(new Date())} - ${aiDecision.advice}`;
                volumeAnomalyCooldown = Date.now() + (15 * 60 * 1000); 
            } catch (e) { console.error("Anomaly AI failed."); }
        }

        const rawPos = pos.find(p => p.symbol === SYMBOL && (parseFloat(p.contracts) > 0 || parseFloat(p.amount) > 0 || parseFloat(p.info?.position) > 0));

        if (rawPos) {
            const side = rawPos.side.toUpperCase();
            const entryPrice = Number(rawPos.entryPrice || rawPos.price || rawPos.average || 0);
            let contracts = Number(rawPos.contracts || rawPos.amount || rawPos.info?.position || 0);
            const pnlUsd = (side === 'LONG' ? (price - entryPrice) : (entryPrice - price)) * contracts * contractSize;
            const roe = (entryPrice > 0) ? ((side === 'LONG' ? (price - entryPrice) : (entryPrice - price)) / entryPrice) * LEVERAGE * 100 : 0;
            
            // ==========================================
            // DYNAMIC STEP-TRAILING LOGIC (REPLACES OLD BREAKEVEN)
            // ==========================================
            let maxRoe = activePosition?.maxRoe || roe;
            if (roe > maxRoe) maxRoe = roe; // Track highest ROE reached

            let lockedRoe = activePosition?.lockedRoe || 0;
            
            // Step up the guaranteed profit based on peak ROE
            if (maxRoe >= 40 && lockedRoe < 25) lockedRoe = 25;
            else if (maxRoe >= 25 && lockedRoe < 10) lockedRoe = 10;
            else if (maxRoe >= 15 && lockedRoe < 3) lockedRoe = 3; // +3% covers taker fees and leaves a micro-profit

            activePosition = { side, entry: entryPrice, size: contracts, pnlUsd, roe, maxRoe, lockedRoe, aiConfidence: activePosition?.aiConfidence || 100 };

            // Trigger the market close if price falls back to our locked profit tier
            if (lockedRoe > 0) {
                const stopHit = (side === 'LONG' && roe <= lockedRoe) || (side === 'SHORT' && roe <= lockedRoe);
                
                if (stopHit) {
                    console.log(`[PROFIT SECURED] Step-Trail hit at +${lockedRoe}% ROE. Executing Market Close...`);
                    await mexc.cancelAllOrders(SYMBOL).catch(e=>console.log(e)); // Clear exchange TP/SL
                    await mexc.createMarketOrder(SYMBOL, side === 'LONG' ? 'sell' : 'buy', contracts, undefined, { 'reduceOnly': true });
                    inTradeAiStatus = `Secured Step-Trail Win: +${lockedRoe}% ROE`;
                    return; // Exit tick loop so DB sync logic catches it next run
                }
            }

            // AI In-Trade Checking (Simplified, no longer alters physical Stop Loss)
            if (Date.now() - lastInTradeCheck > 180000) {
                lastInTradeCheck = Date.now();
                try {
                    const prompt = `
                    You are managing an active ${side} trade on ${SYMBOL}.
                    Entry: $${entryPrice} | Current Price: $${price} | ROE: ${roe.toFixed(2)}%.
                    1m RSI: ${rsi.toFixed(2)} | 1m SMA: $${sma100.toFixed(2)}.
                    Decide the best action:
                    - "HOLD": Let it run.
                    - "CLOSE_EARLY": Momentum is dying, exit now to save capital or lock current profit.
                    Use JSON: {"action": "HOLD" | "CLOSE_EARLY", "reason": "brief reason"}`;
                    
                    const aiDecision = await askAIWithRetry(prompt, 1, 1000);
                    inTradeAiStatus = `[${formatPHT(new Date())}] AI: ${aiDecision.action} - ${aiDecision.reason}`;
                    
                    if (aiDecision.action === "CLOSE_EARLY") {
                        console.log("AI dictated CLOSE_EARLY. Executing...");
                        await mexc.cancelAllOrders(SYMBOL).catch(e=>{});
                        await mexc.createMarketOrder(SYMBOL, side === 'LONG' ? 'sell' : 'buy', contracts, undefined, { 'reduceOnly': true });
                        await sendNotification(`AI Intervened: Closed Early. Reason: ${aiDecision.reason}`);
                    }
                } catch(e) { console.error("In-Trade AI Check Failed."); }
            }

        } else if (activePosition && !rawPos) {
            // Position Closed - Save to DB
            if (activePosition.entry === undefined || activePosition.pnlUsd === undefined) {
                if (Date.now() - lastOrderTime > 180000) { 
                    console.log("Order took too long to register. Canceling/Resetting...");
                    await mexc.cancelAllOrders(SYMBOL).catch(e=>console.log(e));
                    activePosition = null; 
                }
                return;
            }

            const finalRoe = (activePosition.entry > 0) ? (((activePosition.side === 'LONG' ? (price - activePosition.entry) : (activePosition.entry - price)) / activePosition.entry) * LEVERAGE * 100) : 0;
            const tradeToSave = { 
                side: activePosition.side, entry: activePosition.entry, exit: price, pnlUsd: activePosition.pnlUsd, 
                pnlPercent: finalRoe, equityAfter: walletBalance + activePosition.pnlUsd, 
                isWin: activePosition.pnlUsd > 0, time: new Date(), aiConfidence: activePosition.aiConfidence 
            };
            
            try { await Trade.create(tradeToSave); } 
            catch (dbErr) { console.error("DB Save Error, ignoring to keep bot alive:", dbErr.message); }

            await sendNotification(`Position Closed\nSide: ${activePosition.side}\nExit: $${price.toFixed(2)}\nPnL: $${activePosition.pnlUsd.toFixed(2)} (${finalRoe.toFixed(2)}%)`);
            postTradeReflection(tradeToSave);
            activePosition = null;
            inTradeAiStatus = "No active trade.";
            lastInTradeCheck = 0;

        } else if (Date.now() - lastOrderTime > 60000) {
            // Entry Logic
            let action = null; let orderSide = null;
            if (price > sma100 && rsi < dna.rsiThreshold) { action = 'LONG'; orderSide = 'buy'; }
            else if (price < sma100 && rsi > (100 - dna.rsiThreshold)) { action = 'SHORT'; orderSide = 'sell'; }

            if (action) {
                const riskAmount = walletBalance * (currentRiskPercent / 100);
                let qty = Math.floor(riskAmount / (atr * dna.atrMultiplier * contractSize));
                const maxAfford = Math.floor((walletBalance * LEVERAGE * 0.8) / (price * contractSize));
                if (qty > maxAfford) qty = maxAfford;

                if (qty >= 1) {
                    const stopDist = atr * dna.atrMultiplier;
                    const sl = action === 'LONG' ? price - stopDist : price + stopDist;
                    const tp = action === 'LONG' ? price + (stopDist * dna.rewardRatio) : price - (stopDist * dna.rewardRatio);

                    try {
                        // 1. INSTANT EXECUTION (Keep exchange SL/TP as absolute safety nets)
                        await mexc.createOrder(SYMBOL, 'market', orderSide, qty, undefined, { 'stopLoss': parseFloat(sl.toFixed(2)), 'takeProfit': parseFloat(tp.toFixed(2)) });
                        
                        lastOrderTime = Date.now();
                        activePosition = { aiConfidence: 50, maxRoe: 0, lockedRoe: 0 }; 
                        inTradeAiStatus = "Analyzing post-entry..."; 
                        
                        await sendNotification(`⚡ INSTANT ENTRY EXECUTED\nSide: ${action}\nMarket Price: ~$${price.toFixed(2)}\nSending to AI for background review...`);

                        const estFeeImpactRoe = (TAKER_FEE * 2 + SIMULATED_SLIPPAGE) * LEVERAGE * 100;

                        // 3. ASYNC AI REVIEW 
                        const prompt = `
                        I just executed a ${action} on ${SYMBOL} instantly at $${price}. RSI was ${rsi.toFixed(2)} | SMA was $${sma100.toFixed(2)}.
                        EOD Strategy: ${eodStrategyShift}
                        Macro Context: ${aiMacroRegime}
                        Recent Lessons: ${aiRecentLessons.join(" | ")}
                        
                        Review this executed trade. 
                        CRITICAL: Aborting this trade now will guarantee an immediate ~${estFeeImpactRoe.toFixed(2)}% ROE loss due to exchange taker fees. 
                        ONLY set "abort": true if you are highly confident the setup is a trap, violates our macro rules, and is heading straight for the Stop Loss. Otherwise, let it ride.
                        
                        Use JSON: {"abort": true/false, "confidence_score_1_to_100": 85, "reason": "brief reason"}`;
                        
                        askAIWithRetry(prompt, 1, 1000).then(async (aiDecision) => {
                            if (activePosition && (activePosition.side === undefined || activePosition.side === action)) { 
                                activePosition.aiConfidence = aiDecision.confidence_score_1_to_100;
                                inTradeAiStatus = `AI Review: ${aiDecision.reason}`;
                                
                                if (aiDecision.abort) {
                                    console.log(`[AI EMERGENCY ABORT] Reason: ${aiDecision.reason}`);
                                    await mexc.cancelAllOrders(SYMBOL).catch(e => console.log("Abort Cancel Error:", e.message));
                                    await mexc.createMarketOrder(SYMBOL, action === 'LONG' ? 'sell' : 'buy', qty, undefined, { 'reduceOnly': true }).catch(e => console.log("Abort Market Error:", e.message));
                                    await sendNotification(`🚨 AI EMERGENCY ABORT\nTrade closed immediately to protect capital from larger loss.\nReason: ${aiDecision.reason}`);
                                } else {
                                    console.log(`[AI APPROVED] Confidence: ${aiDecision.confidence_score_1_to_100}%`);
                                }
                            }
                        }).catch(e => {
                            inTradeAiStatus = "AI Review failed. Proceeding with standard trailing.";
                            console.error("Async AI Review Failed:", e.message);
                        });

                    } catch (err) {
                        console.error("Order Execution Error:", err.message);
                        lastOrderTime = Date.now() - 30000;
                    }
                } else {
                    console.log(`[WARNING] Calculated QTY (${qty}) is less than 1 contract.`);
                    lastOrderTime = Date.now() - 30000;
                }
            }
        }
    } catch (e) { console.error("Tick Error:", e.message); }
    finally { isTrading = false; }
}

// ==========================================
// ROUTES & DASHBOARD UI
// ==========================================
app.get('/reset-db', async (req, res) => { try { await Trade.deleteMany({}); res.send(`<h2>DB Cleared</h2>`); } catch(e){ res.send(e.message); } });
app.get('/ping', (req, res) => res.status(200).send('pong'));

app.get('/', async (req, res) => {
    if (dbStatus !== "Connected") return res.send(`<h2>System Initializing...</h2>`);
    try {
        const allTrades = await Trade.find().sort({ time: -1 }).limit(10).lean();
        const totalPnl = (await Trade.find()).reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
        const winCount = await Trade.countDocuments({ isWin: true });
        const totalCount = await Trade.countDocuments();
        const winRate = totalCount > 0 ? ((winCount / totalCount) * 100).toFixed(1) : 0;

        const currentPrice = Number(lastTicker.last || 0);
        
        const estimatedRisk = walletBalance * (currentRiskPercent / 100);
        let idealQty = latestATR > 0 ? Math.floor(estimatedRisk / (latestATR * dna.atrMultiplier * contractSize)) : 0;
        const maxAfford = currentPrice > 0 ? Math.floor((walletBalance * LEVERAGE * 0.8) / (currentPrice * contractSize)) : 0;
        
        let finalProjectedQty = idealQty;
        let marginWarning = '';
        if (idealQty > maxAfford) {
            finalProjectedQty = maxAfford;
            marginWarning = `<div style="font-size: 9px; color: var(--yellow); margin-top: 2px;">⚠️ Capped by Margin</div>`;
        }

        let activeCard = `<div class="card active-card"><h2 style="color:var(--muted); text-align:center; margin:0; font-size:16px;">SCANNING MARKET (PRICE: $${currentPrice.toFixed(2)})</h2></div>`;
        if (activePosition && activePosition.side) {
            const lockedText = activePosition.lockedRoe > 0 ? `<span class="text-green">+${activePosition.lockedRoe}% Locked</span>` : `<span class="text-muted">None</span>`;
            
            activeCard = `
            <div class="card active-card pulse-border">
                <div class="card-header"><h2 style="margin:0;"><span class="pulse-dot ${activePosition.side==='LONG'?'dot-green':'dot-red'}"></span> ACTIVE ${activePosition.side}</h2></div>
                <div class="grid" style="margin-top:15px;">
                    <div class="stat-box"><span class="label">Entry</span><span class="value">$${(activePosition.entry || 0).toFixed(1)}</span></div>
                    <div class="stat-box"><span class="label">Current ROE %</span><span class="value ${activePosition.roe >= 0 ? 'text-green' : 'text-red'}">${(activePosition.roe || 0).toFixed(2)}%</span></div>
                    <div class="stat-box"><span class="label">PnL USD</span><span class="value ${activePosition.pnlUsd >= 0 ? 'text-green' : 'text-red'}">$${(activePosition.pnlUsd || 0).toFixed(2)}</span></div>
                    <div class="stat-box"><span class="label">Secured Profit</span><span class="value">${lockedText}</span></div>
                </div>
                <div style="margin-top: 10px; font-size: 11px; color: var(--muted); background: rgba(0,0,0,0.3); padding: 5px; border-radius: 4px;">
                    <strong>🤖 Co-Pilot Status:</strong> ${inTradeAiStatus}
                </div>
            </div>`;
        }

        res.send(`
            <!DOCTYPE html><html><head><title>Sniper AI Co-Pilot</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="refresh" content="10">
            <style>
                :root { --bg: #0b0f19; --card: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; --green: #10b981; --red: #ef4444; --blue: #3b82f6; --purple: #a855f7; --yellow: #eab308; }
                body { background: var(--bg); color: var(--text); font-family: sans-serif; padding: 15px; margin: 0; }
                .container { max-width: 900px; margin: auto; }
                .header-flex { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
                .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
                .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 15px; margin-bottom: 15px; }
                .stat-title { color: var(--muted); font-size: 11px; text-transform: uppercase; }
                .stat-value { font-size: 18px; font-weight: 800; margin-top: 5px; }
                .active-card { border-color: var(--blue); background: #1a1e2d; }
                .stat-box { background: rgba(0,0,0,0.2); padding: 8px; border-radius: 8px; text-align: center; }
                .label { font-size: 9px; color: var(--muted); text-transform: uppercase; }
                .value { font-size: 14px; font-weight: 600; display: block; }
                .text-green { color: var(--green); } .text-red { color: var(--red); } .text-yellow { color: var(--yellow); } .text-purple { color: var(--purple); } .text-blue { color: var(--blue); } .text-muted { color: var(--muted); }
                .badge { padding: 3px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; }
                .badge-green { background: rgba(16,185,129,0.2); color: var(--green); } .badge-red { background: rgba(239,68,68,0.2); color: var(--red); }
                table { width: 100%; border-collapse: collapse; } th { text-align: left; font-size: 11px; color: var(--muted); padding: 8px; border-bottom: 1px solid var(--border); } td { padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; }
                .pulse-dot { height: 8px; width: 8px; border-radius: 50%; display: inline-block; margin-right: 5px; } .dot-green { background: var(--green); } .dot-red { background: var(--red); }
                .pulse-border { animation: border-pulse 2s infinite; }
                .ai-box { padding: 12px; border-radius: 4px; font-size: 12px; margin-top: 10px; line-height: 1.6; border-left: 3px solid; }
                .timestamp { font-size: 10px; color: var(--muted); }
                @keyframes border-pulse { 0%, 100% { border-color: var(--blue); } 50% { border-color: var(--border); } }
            </style></head>
            <body><div class="container">
                <div class="header-flex">
                    <h2 style="color:var(--purple); margin:0;">SNIPER AI CO-PILOT</h2>
                    <span class="timestamp">Last Refresh: ${new Date().toLocaleTimeString()}</span>
                </div>

                <div class="grid" style="margin-bottom: 15px;">
                    <div class="card" style="margin-bottom: 0;"><div class="stat-title">BTC/USDT</div><div class="stat-value text-blue">$${currentPrice.toFixed(2)}</div></div>
                    <div class="card" style="margin-bottom: 0;"><div class="stat-title">Wallet</div><div class="stat-value">$${Number(walletBalance || 0).toFixed(2)}</div></div>
                    <div class="card" style="margin-bottom: 0;"><div class="stat-title">Risk Allocation</div><div class="stat-value text-purple">${currentRiskPercent.toFixed(1)}%</div></div>
                    <div class="card" style="margin-bottom: 0;"><div class="stat-title">Net Profit</div><div class="stat-value ${totalPnl >= 0 ? 'text-green' : 'text-red'}">$${totalPnl.toFixed(2)}</div></div>
                    <div class="card" style="margin-bottom: 0;"><div class="stat-title">Win Rate</div><div class="stat-value">${winRate}%</div></div>
                </div>

                ${activeCard}

                <div class="card">
                    <h3 style="margin: 0 0 10px 0; font-size: 14px; color:var(--muted);">Live Technical Radar</h3>
                    <div class="grid">
                        <div class="stat-box"><span class="label">1m RSI</span><span class="value ${latestRSI < dna.rsiThreshold + 5 || latestRSI > (100 - dna.rsiThreshold) - 5 ? 'text-yellow' : ''}">${latestRSI.toFixed(2)}</span></div>
                        <div class="stat-box"><span class="label">Target LONG</span><span class="value text-green">< ${dna.rsiThreshold}</span></div>
                        <div class="stat-box"><span class="label">Target SHORT</span><span class="value text-red">> ${100 - dna.rsiThreshold}</span></div>
                        <div class="stat-box"><span class="label">100 SMA</span><span class="value">$${latestSMA.toFixed(2)}</span></div>
                        <div class="stat-box"><span class="label">1H Trend Context</span><span class="value ${htfTrendIndicator === 'Bullish' ? 'text-green' : 'text-red'}">${htfTrendIndicator}</span></div>
                        <div class="stat-box">
                            <span class="label">Projected Size</span>
                            <span class="value ${finalProjectedQty < 1 ? 'text-red' : 'text-purple'}">${finalProjectedQty} CTs</span>
                            ${marginWarning}
                        </div>
                    </div>
                    ${finalProjectedQty < 1 ? '<div style="margin-top:10px; font-size:11px; color:var(--red); text-align:center;">⚠️ Projected Trade Size is 0. Increase wallet balance or AI Risk % to trade.</div>' : ''}
                </div>
                
                <div class="card">
                    <h3 style="margin: 0; font-size: 14px; color:var(--muted);">AI Brain & Strategy Overlays</h3>
                    
                    <div class="ai-box" style="border-color: var(--blue); background: rgba(59, 130, 246, 0.05);">
                        <strong>End-Of-Day Master Shift:</strong><br/><em>"${eodStrategyShift}"</em>
                    </div>
                    
                    <div class="ai-box" style="border-color: var(--green); background: rgba(16,185,129,0.05);">
                        <strong>MTF Regime Confluence (1m/15m/1H/4H):</strong><br/><em>"${aiMacroRegime}"</em>
                    </div>

                    <div class="ai-box" style="border-color: var(--red); background: rgba(239, 68, 68, 0.05);">
                        <strong>Volume Anomaly Radar:</strong><br/><em>"${latestAnomaly}"</em>
                    </div>

                    <div class="ai-box" style="border-color: var(--yellow); background: rgba(234, 179, 8, 0.05);">
                        <strong>AI Post-Trade Lessons:</strong><br/>
                        <ul style="margin: 5px 0; padding-left: 20px;">${aiRecentLessons.map(l => `<li><em>${l}</em></li>`).join('')}</ul>
                    </div>
                </div>

                <div class="card">
                    <h3 style="margin: 0 0 10px 0; font-size: 14px; color:var(--muted);">Trade History</h3>
                    <div style="overflow-x:auto;">
                        <table><tr><th>Time</th><th>Side</th><th>PnL %</th><th>PnL USD</th><th>AI Score</th></tr>
                        ${allTrades.map(t => `<tr>
                                <td>${formatPHT(t.time)}</td>
                                <td><span class="badge ${t.side==='LONG'?'badge-green':'badge-red'}">${t.side}</span></td>
                                <td class="${(t.pnlPercent||0)>=0?'text-green':'text-red'}">${(t.pnlPercent||0).toFixed(2)}%</td>
                                <td class="${(t.pnlUsd||0)>=0?'text-green':'text-red'}">$${(t.pnlUsd||0).toFixed(2)}</td>
                                <td>${t.aiConfidence ? t.aiConfidence+'%' : 'N/A'}</td>
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
        const b = await mexc.fetchBalance(); walletBalance = b.total['USDT'] || 0;
        
        await analyzeMarketState(); 
        setTimeout(async () => { await evolve(); }, 3000); 
        await sendNotification(`AI Co-Pilot Online.`);
        
        setInterval(tick, 5000); // 5 sec       
        setInterval(analyzeMarketState, 900000); // 15 mins (MTF & Risk)
        setInterval(async () => { await evolve(); await pruneDatabase(); }, 3600000); // 1 hr (Evolution)
        setInterval(eodDebrief, 86400000); // 24 hrs (EOD Debrief)
        setInterval(async () => { try { const b = await mexc.fetchBalance(); walletBalance = b.total['USDT'] || 0; } catch(e){} }, 30000);                          
        
    } catch (e) { console.error(e); setTimeout(start, 10000); }
}

app.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
    start();
});
