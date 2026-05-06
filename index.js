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
const riskFactor = 0.95; 
const takerFeeRate = 0.0002; 

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
let liveWalletBalance = 0;
let liveUnrealizedPnl = 0;
let currentMarketPrice = 0;
let globalContractSize = 0.0001; 
let activePosition = null;
let lastTradeTime = 0; 
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

// Formats time to Philippine Time (PHT)
const formatPHT = (dateInput) => {
    if (!dateInput) return 'N/A';
    return new Date(dateInput).toLocaleString('en-US', { 
        timeZone: 'Asia/Manila', 
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
};

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

const BotBrain = mongoose.model('BotBrain', new mongoose.Schema({
    trailMultiplier: { type: Number, default: 2.5 }, 
    stopMultiplier: { type: Number, default: 3.0 },  
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
    } catch(e) { console.log("Brain Load Error"); }
}

async function evolveBrain() {
    try {
        const recentTrades = await Trade.find().sort({ endTime: -1 }).limit(20);
        if (recentTrades.length < 20) return; 

        const wins = recentTrades.filter(t => t.isWin).length;
        const winRate = wins / 20;

        let updated = false;
        let brain = await BotBrain.findOne();

        if (winRate < 0.40 && brain.stopMultiplier < 4.5) {
            brain.stopMultiplier += 0.2; brain.trailMultiplier += 0.2; updated = true;
        } else if (winRate > 0.65 && brain.trailMultiplier > 1.8) {
            brain.trailMultiplier -= 0.1; updated = true;
        }

        if (updated) {
            await brain.save(); activeBrain = brain;
        }
    } catch (e) { console.error("AI Evolution Error:", e.message); }
}

// ==========================================
// CORE LOGIC 
// ==========================================
async function updateAccountEquity() {
    try {
        const balance = await mexc.fetchBalance();
        // MEXC often reports balance.total as strictly the FREE balance if margin is isolated.
        liveWalletBalance = balance.total['USDT'] || 0; 
    } catch(e) { console.error("Equity Sync Failed"); }
}

async function getMarketContext() {
    const[ohlcv1h, ohlcv15m] = await Promise.all([
        mexc.fetchOHLCV(symbol, '1h', undefined, 50),
        mexc.fetchOHLCV(symbol, '15m', undefined, 50)
    ]);
    const closes15m = ohlcv15m.map(c => c[4]);
    currentMarketPrice = closes15m[closes15m.length - 1];
    const currentCandleTime = ohlcv15m[ohlcv15m.length - 1][0]; 
    
    return { 
        currentPrice: currentMarketPrice, 
        currentCandleTime, 
        swing: { 
            trend: currentMarketPrice > SMA.calculate({ period: 20, values: ohlcv1h.map(c => c[4]) }).pop() ? 'BULLISH' : 'BEARISH',
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
        
        // Reset manual UI globals on exit
        liveUnrealizedPnl = 0; 
        activePosition = null;
        
        await updateAccountEquity();
        liveTotalEquity = liveWalletBalance; // After exit, wallet balance contains full margin + profit

        await Trade.create({ 
            side, entryPrice, exitPrice, 
            pnlPercentage: (netPnlUsd / initialMarginUsd) * 100, 
            pnlUsd: netPnlUsd, equityAfter: liveTotalEquity, isWin: netPnlUsd > 0,
            startTime: startTime || new Date(), endTime: new Date()
        });
        
        sendTelegramAlert(`💸 CLOSED ${side}\nNet: $${netPnlUsd.toFixed(2)}\nEquity: $${liveTotalEquity.toFixed(2)}`);
        
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
        globalContractSize = market.contractSize;
        const now = Date.now();

        const positions = await mexc.fetchPositions([symbol]);
        const longPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'long');
        const shortPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'short');

        if (longPos || shortPos) {
            const pos = longPos || shortPos;
            const entry = parseFloat(pos.entryPrice);
            const size = parseFloat(pos.contracts);
            const side = longPos ? 'LONG' : 'SHORT';
            
            // --- FIX: MANUAL PNL & EQUITY CALCULATION ---
            // Bypassing CCXT's empty unrealizedPnl field and calculating it exactly
            const marginUsed = (entry * size * globalContractSize) / leverage;
            const pnlPct = side === 'LONG' ? ((ctx.currentPrice - entry) / entry) * leverage * 100 : ((entry - ctx.currentPrice) / entry) * leverage * 100;
            const pnlUsd = side === 'LONG' ? (ctx.currentPrice - entry) * size * globalContractSize : (entry - ctx.currentPrice) * size * globalContractSize;
            
            liveUnrealizedPnl = pnlUsd;
            
            // Fix MEXC Equity Bug (If Wallet < Margin, MEXC hid the margin from the total balance)
            if (liveWalletBalance < marginUsed) {
                liveTotalEquity = liveWalletBalance + marginUsed + liveUnrealizedPnl;
            } else {
                liveTotalEquity = liveWalletBalance + liveUnrealizedPnl;
            }

            if (!activePosition) activePosition = { side, entryPrice: entry, startTime: now, pnlPct: pnlPct, size };
            else { activePosition.pnlPct = pnlPct; activePosition.size = size; }

            const durationSec = (now - activePosition.startTime) / 1000;
            const isEmergency = activePosition.pnlPct < -10.0; 

            if (durationSec > 40 || isEmergency) { 
                const atrDistance = ctx.swing.atr * activeBrain.stopMultiplier;
                const minStopDistance = ctx.currentPrice * 0.0030; 
                const buffer = Math.max(atrDistance, minStopDistance);

                if (side === 'LONG') {
                    if (peakPrice === 0 || ctx.currentPrice > peakPrice) peakPrice = ctx.currentPrice;
                    
                    let initialStop = entry - buffer;
                    let stopLoss = initialStop;

                    if (activePosition.pnlPct >= activeBrain.takeProfitTrigger) {
                        const floor = entry * (1 + (activeBrain.profitLockFloor / 100 / leverage));
                        const trail = peakPrice - (ctx.swing.atr * activeBrain.trailMultiplier * 0.6);
                        stopLoss = Math.max(floor, trail);
                    } else if (activePosition.pnlPct >= 2.0) {
                        stopLoss = Math.max(initialStop, peakPrice - (ctx.swing.atr * activeBrain.trailMultiplier));
                    } 

                    if (ctx.currentPrice < stopLoss) {
                        await mexc.createMarketSellOrder(symbol, parseFloat(longPos.contracts), { 'reduceOnly': true });
                        await processTradeExit('LONG', entry, ctx.currentPrice, parseFloat(longPos.contracts), globalContractSize, activePosition.startTime);
                        peakPrice = 0; lastTradeTime = now;
                    }
                } else { 
                    if (peakPrice === 0 || ctx.currentPrice < peakPrice) peakPrice = ctx.currentPrice;
                    
                    let initialStop = entry + buffer;
                    let stopLoss = initialStop;

                    if (activePosition.pnlPct >= activeBrain.takeProfitTrigger) {
                        const floor = entry * (1 - (activeBrain.profitLockFloor / 100 / leverage));
                        const trail = peakPrice + (ctx.swing.atr * activeBrain.trailMultiplier * 0.6);
                        stopLoss = Math.min(floor, trail);
                    } else if (activePosition.pnlPct >= 2.0) {
                        stopLoss = Math.min(initialStop, peakPrice + (ctx.swing.atr * activeBrain.trailMultiplier));
                    }

                    if (ctx.currentPrice > stopLoss) {
                        await mexc.createMarketBuyOrder(symbol, parseFloat(shortPos.contracts), { 'reduceOnly': true });
                        await processTradeExit('SHORT', entry, ctx.currentPrice, parseFloat(shortPos.contracts), globalContractSize, activePosition.startTime);
                        peakPrice = 0; lastTradeTime = now;
                    }
                }
            }
        } else {
            // No Active Position: Reset calculations
            liveUnrealizedPnl = 0;
            liveTotalEquity = liveWalletBalance; 
            activePosition = null;

            if (ctx.currentCandleTime === lastTradedCandleTime) return;

            if (liveTotalEquity > 10) {
                const contractsToTrade = Math.floor((liveTotalEquity * riskFactor * leverage) / ctx.currentPrice / globalContractSize);
                if (contractsToTrade >= 1) {
                    if (ctx.swing.trend === 'BULLISH' && ctx.swing.strength > activeBrain.minTrendStrength && ctx.swing.macd.histogram > 0) {
                        await mexc.createMarketBuyOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                        lastTradedCandleTime = ctx.currentCandleTime;
                        activePosition = { side: 'LONG', entryPrice: ctx.currentPrice, startTime: now, pnlPct: 0, size: contractsToTrade };
                        sendTelegramAlert(`🚀 LONG ENTRY: $${ctx.currentPrice}\nEquity: $${liveTotalEquity.toFixed(2)}`);
                        peakPrice = ctx.currentPrice;
                    } 
                    else if (ctx.swing.trend === 'BEARISH' && ctx.swing.strength > activeBrain.minTrendStrength && ctx.swing.macd.histogram < 0) {
                        await mexc.createMarketSellOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                        lastTradedCandleTime = ctx.currentCandleTime;
                        activePosition = { side: 'SHORT', entryPrice: ctx.currentPrice, startTime: now, pnlPct: 0, size: contractsToTrade };
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
        console.log("✅ ELITE SNIPER V5.5 ACTIVE");
        setInterval(runBot, 8000); 
    } catch(e) { console.error("Startup Error:", e.message); }
}
startBot();

// ==========================================
// DASHBOARD UI
// ==========================================
app.get('/', async (req, res) => {
    try {
        const allTrades = await Trade.find().sort({ endTime: -1 });
        const recentTrades = allTrades.slice(0, 15);
        
        const totalPnlUsd = allTrades.reduce((sum, t) => sum + (t.pnlUsd || 0), 0).toFixed(2);
        const winCount = allTrades.filter(t => t.isWin).length;
        const winRate = allTrades.length > 0 ? ((winCount / allTrades.length) * 100).toFixed(1) : 0;

        let posHtml = `<div class="empty-state">⚪ NO ACTIVE POSITIONS - SCANNING MARKET</div>`;
        
        if (activePosition) {
            const marginUsed = (activePosition.entryPrice * activePosition.size * globalContractSize) / leverage;
            const currentTradeEquity = marginUsed + liveUnrealizedPnl;
            const mode = (activePosition.pnlPct || 0) > activeBrain.takeProfitTrigger ? '🔥 BREAKOUT TRAIL' : ((activePosition.pnlPct || 0) > 2.0 ? '📈 STD TRAIL' : '🛡️ INITIAL STOP');
            const pnlColor = liveUnrealizedPnl >= 0 ? 'text-green' : 'text-red';
            const badgeClass = activePosition.side === 'LONG' ? 'badge-green' : 'badge-red';

            posHtml = `
            <div class="active-card pulse-border">
                <div class="card-header">
                    <h2><span class="pulse-dot ${activePosition.side === 'LONG'?'dot-green':'dot-red'}"></span> ACTIVE POSITION</h2>
                    <span class="badge ${badgeClass}">${activePosition.side}</span>
                </div>
                <div class="grid grid-cols-4 gap-4 mt-4">
                    <div class="stat-box">
                        <span class="label">Entry Price</span>
                        <span class="value">$${(activePosition.entryPrice || 0).toFixed(2)}</span>
                    </div>
                    <div class="stat-box">
                        <span class="label">Current Price</span>
                        <span class="value">$${currentMarketPrice.toFixed(2)}</span>
                    </div>
                    <div class="stat-box">
                        <span class="label">Unrealized PnL</span>
                        <span class="value ${pnlColor}">${(activePosition.pnlPct || 0).toFixed(2)}% <span style="font-size:14px; opacity:0.8;">(${liveUnrealizedPnl > 0 ? '+' : ''}$${liveUnrealizedPnl.toFixed(2)})</span></span>
                    </div>
                    <div class="stat-box">
                        <span class="label">Bot Mode</span>
                        <span class="value text-yellow">${mode}</span>
                    </div>
                    <div class="stat-box">
                        <span class="label">Margin Used (10x)</span>
                        <span class="value">$${marginUsed.toFixed(2)}</span>
                    </div>
                    <div class="stat-box">
                        <span class="label">Trade Equity</span>
                        <span class="value text-blue">$${currentTradeEquity.toFixed(2)}</span>
                    </div>
                    <div class="stat-box">
                        <span class="label">Position Size</span>
                        <span class="value">${activePosition.size} Cont.</span>
                    </div>
                    <div class="stat-box">
                        <span class="label">Time in Trade</span>
                        <span class="value">${Math.floor((Date.now() - activePosition.startTime)/60000)} mins</span>
                    </div>
                </div>
            </div>`;
        }

        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <title>Elite Sniper V5.5</title>
                <meta http-equiv="refresh" content="5">
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
                <style>
                    :root { --bg: #0b0f19; --card: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; --green: #10b981; --red: #ef4444; --blue: #3b82f6; --yellow: #f59e0b; }
                    body { background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; margin: 0; padding: 30px; }
                    .container { max-width: 1100px; margin: auto; }
                    h1 { color: #38bdf8; text-align: center; margin-bottom: 5px; font-weight: 800; }
                    .sub-header { text-align: center; color: var(--muted); margin-bottom: 30px; font-size: 14px; }
                    .grid { display: grid; }
                    .grid-cols-4 { grid-template-columns: repeat(4, 1fr); }
                    .gap-4 { gap: 15px; }
                    .mt-4 { margin-top: 15px; }
                    
                    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                    .stat-title { color: var(--muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
                    .stat-value { font-size: 26px; font-weight: 800; }
                    
                    .text-green { color: var(--green); } .text-red { color: var(--red); } .text-blue { color: var(--blue); } .text-yellow { color: var(--yellow); }
                    
                    .active-card { background: #0f172a; padding: 25px; border-radius: 12px; border: 1px solid #0ea5e9; margin-top: 25px; position: relative; }
                    .pulse-border { box-shadow: 0 0 15px rgba(14, 165, 233, 0.2); }
                    .card-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 15px; }
                    .card-header h2 { margin: 0; font-size: 18px; color: #38bdf8; display: flex; align-items: center; gap: 10px; }
                    
                    .badge { padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 800; letter-spacing: 1px; }
                    .badge-green { background: rgba(16, 185, 129, 0.2); color: var(--green); border: 1px solid var(--green); }
                    .badge-red { background: rgba(239, 68, 68, 0.2); color: var(--red); border: 1px solid var(--red); }
                    
                    .stat-box { background: var(--card); padding: 12px 15px; border-radius: 8px; border: 1px solid var(--border); }
                    .stat-box .label { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; }
                    .stat-box .value { display: block; font-size: 16px; font-weight: 600; }
                    
                    .empty-state { margin-top: 25px; padding: 40px; border: 1px dashed var(--border); color: var(--muted); border-radius: 12px; text-align: center; font-weight: 600; background: rgba(30, 41, 59, 0.3); }
                    
                    .pulse-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; animation: pulse 1.5s infinite; }
                    .dot-green { background: var(--green); box-shadow: 0 0 8px var(--green); }
                    .dot-red { background: var(--red); box-shadow: 0 0 8px var(--red); }
                    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }

                    table { width: 100%; border-collapse: collapse; margin-top: 15px; background: var(--card); border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                    th { background: #0f172a; color: var(--muted); text-align: left; padding: 16px; font-size: 13px; text-transform: uppercase; border-bottom: 1px solid var(--border); }
                    td { padding: 16px; font-size: 14px; border-bottom: 1px solid var(--border); font-weight: 600; }
                    tr:hover { background: rgba(255,255,255,0.02); }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🎯 Elite Sniper V5.5 Terminal</h1>
                    <div class="sub-header">Server Time (PHT): ${formatPHT(new Date())}</div>
                    
                    <div class="grid grid-cols-4 gap-4">
                        <div class="card">
                            <div class="stat-title">Free Wallet Balance</div>
                            <div class="stat-value">$${(liveWalletBalance || 0).toFixed(2)}</div>
                        </div>
                        <div class="card">
                            <div class="stat-title">Active PnL</div>
                            <div class="stat-value ${liveUnrealizedPnl >= 0 ? 'text-green' : 'text-red'}">${liveUnrealizedPnl > 0 ? '+' : ''}$${(liveUnrealizedPnl || 0).toFixed(2)}</div>
                        </div>
                        <div class="card">
                            <div class="stat-title">Total Account Equity</div>
                            <div class="stat-value text-blue">$${(liveTotalEquity || 0).toFixed(2)}</div>
                        </div>
                        <div class="card">
                            <div class="stat-title">All-Time Net / Win Rate</div>
                            <div class="stat-value ${parseFloat(totalPnlUsd) >= 0 ? 'text-green':'text-red'}">${parseFloat(totalPnlUsd) > 0 ? '+' : ''}$${totalPnlUsd} <span style="font-size: 14px; color: var(--muted);">(${winRate}%)</span></div>
                        </div>
                    </div>

                    ${posHtml}

                    <h3 style="margin-top:40px; color: var(--muted); font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">📜 Recent Trade Log</h3>
                    <table>
                        <tr>
                            <th>Closed At (PHT)</th>
                            <th>Side</th>
                            <th>PnL %</th>
                            <th>Net Profit</th>
                            <th>Ending Equity</th>
                        </tr>
                        ${recentTrades.map(t => `
                            <tr>
                                <td style="color: var(--muted); font-weight: 400;">${formatPHT(t.endTime)}</td>
                                <td><span class="badge ${t.side === 'LONG' ? 'badge-green' : 'badge-red'}">${t.side}</span></td>
                                <td class="${(t.pnlPercentage || 0) >= 0 ? 'text-green' : 'text-red'}">${(t.pnlPercentage || 0) > 0 ? '+' : ''}${(t.pnlPercentage || 0).toFixed(2)}%</td>
                                <td class="${(t.pnlUsd || 0) >= 0 ? 'text-green' : 'text-red'}">${(t.pnlUsd || 0) > 0 ? '+' : ''}$${(t.pnlUsd || 0).toFixed(2)}</td>
                                <td>$${(t.equityAfter || 0).toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </table>
                </div>
            </body>
            </html>
        `);
    } catch (e) { res.send(`Dashboard error: ${e.message}`); }
});

app.listen(port, () => console.log(`🌐 Server active on port ${port}`));
