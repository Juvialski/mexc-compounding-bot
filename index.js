const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const { RSI, SMA, ATR, ADX, MACD, BollingerBands } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;

// ==========================================
// BOT CONFIGURATION
// ==========================================
const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskFactor = 0.95; // Risk factor kept at 95% per user request
const takerFeeRate = 0.0002; // 0.02%

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' },
    enableRateLimit: true 
});

// Global States
let isTrading = false;
let peakPrice = 0; 
let liveTotalEquity = 0; 
let activePosition = null;
let lastTradeTime = 0; 

// --- FIX: ANTI-WHIPSAW ---
// Tracks the timestamp of the last 15m candle traded to prevent back-to-back entries
let lastTradedCandleTime = 0; 

// ==========================================
// UTILS & NOTIFICATIONS
// ==========================================
function sendTelegramAlert(message) {
    const token = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return; 
    const url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(message)}`;
    https.get(url).on('error', (e) => console.error("Telegram error:", e.message));
}

// ==========================================
// DATABASE SETUP & AI MEMORY
// ==========================================
mongoose.connect(process.env.MONGO_URI).catch(err => console.error("❌ DB ERROR", err));

const TradeSchema = new mongoose.Schema({
    side: String,
    entryPrice: Number,
    exitPrice: Number,
    pnlPercentage: Number,
    pnlUsd: Number,
    equityAfter: Number, 
    isWin: Boolean,
    startTime: { type: Date, default: Date.now },
    endTime: { type: Date, default: Date.now }
});
const Trade = mongoose.model('Trade', TradeSchema);

// --- FIX: LOOSER DEFAULTS ---
const BotBrain = mongoose.model('BotBrain', new mongoose.Schema({
    trailMultiplier: { type: Number, default: 2.5 }, // Loosened from 1.5
    stopMultiplier: { type: Number, default: 3.0 },  // Loosened from 2.0
    takeProfitTrigger: { type: Number, default: 5.0 }, 
    profitLockFloor: { type: Number, default: 2.0 },   
    minTrendStrength: { type: Number, default: 25 }
}));

let activeBrain = { trailMultiplier: 2.5, stopMultiplier: 3.0, takeProfitTrigger: 5.0, profitLockFloor: 2.0, minTrendStrength: 25 };

async function loadBotBrain() {
    try {
        let brain = await BotBrain.findOne();
        if (!brain) brain = await BotBrain.create({});
        activeBrain = brain;
        console.log("🧬 AI DNA Loaded:", activeBrain);
    } catch(e) { console.log("Brain Load Error"); }
}

// --- FIX: ACTUAL SELF-LEARNING MECHANISM ---
async function evolveBrain() {
    try {
        const recentTrades = await Trade.find().sort({ endTime: -1 }).limit(20);
        if (recentTrades.length < 20) return; // Need enough data to learn

        const wins = recentTrades.filter(t => t.isWin).length;
        const winRate = wins / 20;

        let updated = false;
        let brain = await BotBrain.findOne();

        // If win rate is terrible (< 40%), loosen stops to survive volatility
        if (winRate < 0.40 && brain.stopMultiplier < 4.5) {
            brain.stopMultiplier += 0.2;
            brain.trailMultiplier += 0.2;
            updated = true;
            console.log(`🧠 AI LEARNING: Win rate poor (${(winRate*100).toFixed(0)}%). Loosening stops to ${brain.stopMultiplier.toFixed(1)}x ATR.`);
        } 
        // If win rate is excellent (> 65%), tighten trails slightly to capture more profit
        else if (winRate > 0.65 && brain.trailMultiplier > 1.8) {
            brain.trailMultiplier -= 0.1;
            updated = true;
            console.log(`🧠 AI LEARNING: Win rate high (${(winRate*100).toFixed(0)}%). Tightening trail to ${brain.trailMultiplier.toFixed(1)}x ATR.`);
        }

        if (updated) {
            await brain.save();
            activeBrain = brain;
        }
    } catch (e) { console.error("AI Evolution Error:", e.message); }
}

// ==========================================
// DASHBOARD UI
// ==========================================
app.get('/', async (req, res) => {
    try {
        const allTrades = await Trade.find().sort({ endTime: -1 });
        const recentTrades = allTrades.slice(0, 15);
        const totalPnlUsd = allTrades.reduce((sum, t) => sum + (t.pnlUsd || 0), 0).toFixed(2);

        const posHtml = activePosition ? `
            <div style="background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #0ea5e9; box-shadow: 0 0 15px rgba(14, 165, 233, 0.3);">
                <h2 style="color: #38bdf8; margin: 0;">🟢 ACTIVE: ${activePosition.side}</h2>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 15px;">
                    <div>Entry: <b>$${(activePosition.entryPrice || 0).toFixed(2)}</b></div>
                    <div>Unrealized PnL: <b style="color: ${(activePosition.pnlPct || 0) >= 0 ? '#22c55e' : '#ef4444'}">${(activePosition.pnlPct || 0).toFixed(2)}%</b></div>
                    <div>Time In Trade: <b>${Math.floor((Date.now() - activePosition.startTime)/60000)}m</b></div>
                    <div style="color: #facc15; font-weight: bold;">Mode: ${(activePosition.pnlPct || 0) > activeBrain.takeProfitTrigger ? '🔥 BREAKOUT TRAILING' : ((activePosition.pnlPct || 0) > 2.0 ? '📈 STANDARD TRAIL' : '🛡️ INITIAL STOP')}</div>
                </div>
            </div>
        ` : `<div style="padding: 30px; border: 1px dashed #334155; color: #94a3b8; border-radius: 12px; text-align: center;">⚪ NO ACTIVE POSITIONS - SCANNING MARKET</div>`;

        res.send(`
            <html><head><title>Elite Sniper V5.3</title><meta http-equiv="refresh" content="10"></head>
            <body style="background:#0b0f19; color:#e2e8f0; font-family: 'Segoe UI', sans-serif; padding: 20px;">
                <div style="max-width: 900px; margin: auto;">
                    <h1 style="color: #38bdf8; text-align: center;">🎯 Elite Sniper V5.3</h1>
                    
                    <div style="display:flex; gap: 20px; margin-bottom: 20px;">
                        <div style="background:#1e293b; padding:20px; border-radius:12px; flex:1; border: 1px solid #334155;">
                            <div style="color:#94a3b8; font-size: 12px; margin-bottom: 5px;">TOTAL ACCOUNT EQUITY</div>
                            <strong style="font-size: 28px; color: #facc15">$${(liveTotalEquity || 0).toFixed(2)}</strong>
                        </div>
                        <div style="background:#1e293b; padding:20px; border-radius:12px; flex:1; border: 1px solid #334155;">
                            <div style="color:#94a3b8; font-size: 12px; margin-bottom: 5px;">TOTAL NET PROFIT</div>
                            <strong style="font-size: 28px; color: ${parseFloat(totalPnlUsd) >= 0 ? '#22c55e':'#ef4444'}">$${totalPnlUsd}</strong>
                        </div>
                    </div>

                    ${posHtml}

                    <h3 style="margin-top:40px; color: #94a3b8;">📜 RECENT TRADE JOURNAL</h3>
                    <table style="width:100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden;">
                        <tr style="background:#0f172a; color:#94a3b8; text-align: left;">
                            <th style="padding:15px;">Closed At</th>
                            <th style="padding:15px;">Side</th>
                            <th style="padding:15px;">PnL %</th>
                            <th style="padding:15px;">PnL USD</th>
                            <th style="padding:15px;">Equity After</th>
                        </tr>
                        ${recentTrades.map(t => `
                            <tr style="border-bottom: 1px solid #334155;">
                                <td style="padding:15px; font-size: 14px;">${t.endTime ? new Date(t.endTime).toLocaleString() : 'N/A'}</td>
                                <td style="padding:15px; font-weight: bold;">${t.side || 'N/A'}</td>
                                <td style="padding:15px; color:${(t.pnlPercentage || 0) >= 0 ? '#22c55e' : '#ef4444'}">${(t.pnlPercentage || 0).toFixed(2)}%</td>
                                <td style="padding:15px; color:${(t.pnlUsd || 0) >= 0 ? '#22c55e' : '#ef4444'}">$${(t.pnlUsd || 0).toFixed(2)}</td>
                                <td style="padding:15px;">$${(t.equityAfter || 0).toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </table>
                </div>
            </body></html>
        `);
    } catch (e) { res.send(`Dashboard error: ${e.message}`); }
});

app.listen(port, () => console.log(`🌐 Server active on port ${port}`));

// ==========================================
// CORE LOGIC 
// ==========================================
async function updateAccountEquity() {
    try {
        const balance = await mexc.fetchBalance();
        const positions = await mexc.fetchPositions([symbol]);
        let walletBalance = balance.total['USDT'] || 0;
        let totalUnrealizedPnl = 0;
        positions.forEach(p => { if (parseFloat(p.contracts) > 0) totalUnrealizedPnl += parseFloat(p.unrealizedPnl || 0); });
        liveTotalEquity = walletBalance + totalUnrealizedPnl;
    } catch(e) { console.error("Equity Sync Failed"); }
}

async function getMarketContext() {
    const[ohlcv1h, ohlcv15m] = await Promise.all([
        mexc.fetchOHLCV(symbol, '1h', undefined, 50),
        mexc.fetchOHLCV(symbol, '15m', undefined, 50)
    ]);
    const closes15m = ohlcv15m.map(c => c[4]);
    const currentPrice = closes15m[closes15m.length - 1];
    const currentCandleTime = ohlcv15m[ohlcv15m.length - 1][0]; // Extract exact timestamp of current 15m candle
    
    return { 
        currentPrice, 
        currentCandleTime, // Passed down to prevent whipsaws
        swing: { 
            trend: currentPrice > SMA.calculate({ period: 20, values: ohlcv1h.map(c => c[4]) }).pop() ? 'BULLISH' : 'BEARISH',
            strength: ADX.calculate({ high: ohlcv15m.map(c => c[2]), low: ohlcv15m.map(c => c[3]), close: closes15m, period: 14 }).pop()?.adx || 0,
            atr: ATR.calculate({ period: 14, high: ohlcv15m.map(c => c[2]), low: ohlcv15m.map(c => c[3]), close: closes15m }).pop(),
            macd: MACD.calculate({ values: closes15m, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }).pop()
        }
    };
}

async function processTradeExit(side, entryPrice, exitPrice, contracts, contractSize, startTime) {
    try {
        const initialMarginUsd = (entryPrice * contracts * contractSize) / leverage;
        let rawPnlUsd = (side === 'LONG') ? (exitPrice - entryPrice) * contracts * contractSize : (entryPrice - exitPrice) * contracts * contractSize;
        const totalFeeUsd = (entryPrice + exitPrice) * contracts * contractSize * takerFeeRate;
        const netPnlUsd = rawPnlUsd - totalFeeUsd;
        
        await updateAccountEquity();

        await Trade.create({ 
            side, entryPrice, exitPrice, 
            pnlPercentage: (netPnlUsd / initialMarginUsd) * 100, 
            pnlUsd: netPnlUsd, equityAfter: liveTotalEquity, isWin: netPnlUsd > 0,
            startTime: startTime || new Date(), endTime: new Date()
        });
        
        sendTelegramAlert(`💸 CLOSED ${side}\nNet: $${netPnlUsd.toFixed(2)}\nEquity: $${liveTotalEquity.toFixed(2)}`);
        activePosition = null;
        
        // Trigger AI Evaluation occasionally after an exit
        if (Math.random() > 0.7) evolveBrain(); 

    } catch (e) { console.error("Trade recording error:", e.message); }
}

async function runBot() {
    if (isTrading) return; 
    isTrading = true;
    try {
        await updateAccountEquity();
        const ctx = await getMarketContext();
        const market = await mexc.market(symbol);
        const contractSize = market.contractSize;
        const now = Date.now();

        const positions = await mexc.fetchPositions([symbol]);
        const longPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'long');
        const shortPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'short');

        if (longPos || shortPos) {
            const pos = longPos || shortPos;
            const entry = parseFloat(pos.entryPrice);
            const side = longPos ? 'LONG' : 'SHORT';
            const pnl = side === 'LONG' ? ((ctx.currentPrice - entry) / entry) * leverage * 100 : ((entry - ctx.currentPrice) / entry) * leverage * 100;
            
            if (!activePosition) activePosition = { side, entryPrice: entry, startTime: now, pnlPct: pnl };
            else activePosition.pnlPct = pnl;

            const durationSec = (now - activePosition.startTime) / 1000;
            const isEmergency = activePosition.pnlPct < -10.0; // Widened hard fail-safe to 10% to prevent sudden death on spikes

            if (durationSec > 40 || isEmergency) { 
                
                // --- FIX: DELAYED TRAIL & WIDER STOPS ---
                const atrDistance = ctx.swing.atr * activeBrain.stopMultiplier;
                const minStopDistance = ctx.currentPrice * 0.0030; // Min 0.30% away
                const buffer = Math.max(atrDistance, minStopDistance);

                if (side === 'LONG') {
                    if (peakPrice === 0 || ctx.currentPrice > peakPrice) peakPrice = ctx.currentPrice;
                    
                    let initialStop = entry - buffer;
                    let stopLoss = initialStop;

                    if (activePosition.pnlPct >= activeBrain.takeProfitTrigger) {
                        // Level 3: Breakout Trailing (Tight Trail to protect massive profit)
                        const floor = entry * (1 + (activeBrain.profitLockFloor / 100 / leverage));
                        const trail = peakPrice - (ctx.swing.atr * activeBrain.trailMultiplier * 0.6);
                        stopLoss = Math.max(floor, trail);
                    } else if (activePosition.pnlPct >= 2.0) {
                        // Level 2: Standard Trailing (Only activates once we hit 2% profit)
                        stopLoss = Math.max(initialStop, peakPrice - (ctx.swing.atr * activeBrain.trailMultiplier));
                    } // Level 1: Initial Stop Loss remains if below 2% profit

                    if (ctx.currentPrice < stopLoss) {
                        await mexc.createMarketSellOrder(symbol, parseFloat(longPos.contracts), { 'reduceOnly': true });
                        await processTradeExit('LONG', entry, ctx.currentPrice, parseFloat(longPos.contracts), contractSize, activePosition.startTime);
                        peakPrice = 0; lastTradeTime = now;
                    }
                } else { // SHORT
                    if (peakPrice === 0 || ctx.currentPrice < peakPrice) peakPrice = ctx.currentPrice;
                    
                    let initialStop = entry + buffer;
                    let stopLoss = initialStop;

                    if (activePosition.pnlPct >= activeBrain.takeProfitTrigger) {
                        // Level 3: Breakout Trailing
                        const floor = entry * (1 - (activeBrain.profitLockFloor / 100 / leverage));
                        const trail = peakPrice + (ctx.swing.atr * activeBrain.trailMultiplier * 0.6);
                        stopLoss = Math.min(floor, trail);
                    } else if (activePosition.pnlPct >= 2.0) {
                        // Level 2: Standard Trailing 
                        stopLoss = Math.min(initialStop, peakPrice + (ctx.swing.atr * activeBrain.trailMultiplier));
                    } // Level 1: Initial Stop Loss 

                    if (ctx.currentPrice > stopLoss) {
                        await mexc.createMarketBuyOrder(symbol, parseFloat(shortPos.contracts), { 'reduceOnly': true });
                        await processTradeExit('SHORT', entry, ctx.currentPrice, parseFloat(shortPos.contracts), contractSize, activePosition.startTime);
                        peakPrice = 0; lastTradeTime = now;
                    }
                }
            }
        } else {
            // --- FIX: CANDLE-BASED ENTRY COOLDOWN ---
            // Don't re-enter if we already traded this exact 15-minute candle
            if (ctx.currentCandleTime === lastTradedCandleTime) return;

            if (liveTotalEquity > 10) {
                const contractsToTrade = Math.floor((liveTotalEquity * riskFactor * leverage) / ctx.currentPrice / contractSize);
                if (contractsToTrade >= 1) {
                    if (ctx.swing.trend === 'BULLISH' && ctx.swing.strength > activeBrain.minTrendStrength && ctx.swing.macd.histogram > 0) {
                        await mexc.createMarketBuyOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                        
                        lastTradedCandleTime = ctx.currentCandleTime; // Mark this candle as traded
                        activePosition = { side: 'LONG', entryPrice: ctx.currentPrice, startTime: now, pnlPct: 0 };
                        sendTelegramAlert(`🚀 LONG ENTRY: $${ctx.currentPrice}\nEquity: $${liveTotalEquity.toFixed(2)}`);
                        peakPrice = ctx.currentPrice;
                    } 
                    else if (ctx.swing.trend === 'BEARISH' && ctx.swing.strength > activeBrain.minTrendStrength && ctx.swing.macd.histogram < 0) {
                        await mexc.createMarketSellOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                        
                        lastTradedCandleTime = ctx.currentCandleTime; // Mark this candle as traded
                        activePosition = { side: 'SHORT', entryPrice: ctx.currentPrice, startTime: now, pnlPct: 0 };
                        sendTelegramAlert(`📉 SHORT ENTRY: $${ctx.currentPrice}\nEquity: $${liveTotalEquity.toFixed(2)}`);
                        peakPrice = ctx.currentPrice;
                    }
                }
            }
        }
    } catch (e) { console.error("Loop Error:", e.message); }
    finally { isTrading = false; }
}

async function startBot() {
    try {
        await mexc.loadMarkets();
        await loadBotBrain();
        console.log("✅ ELITE SNIPER V5.3 ACTIVE");
        sendTelegramAlert("✅ Elite Sniper V5.3 is online.");
        setInterval(runBot, 8000); 
    } catch(e) { console.error("Startup Error:", e.message); }
}
startBot();
