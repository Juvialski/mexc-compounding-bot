const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const { RSI, SMA, ATR, ADX, OBV, MACD, BollingerBands } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' },
    enableRateLimit: true 
});

// ==========================================
// BOT CONFIGURATION
// ==========================================
const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskFactor = 0.95; 
const takerFeeRate = 0.0002; 
let isTrading = false;
let peakPrice = 0; 
let liveTotalEquity = 0; // Total Account Value (Balance + PnL)
let activePosition = null;

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
// DATABASE & MEMORY
// ==========================================
mongoose.connect(process.env.MONGO_URI).catch(err => console.error("❌ DB ERROR", err));

const TradeSchema = new mongoose.Schema({
    side: String,
    entryPrice: Number,
    exitPrice: Number,
    pnlPercentage: Number,
    pnlUsd: Number,
    equityAfter: Number, // Total account value after trade
    isWin: Boolean,
    startTime: { type: Date },
    endTime: { type: Date, default: Date.now }
});
const Trade = mongoose.model('Trade', TradeSchema);

const BotBrain = mongoose.model('BotBrain', new mongoose.Schema({
    trailMultiplier: { type: Number, default: 1.5 },
    stopMultiplier: { type: Number, default: 2.0 },
    takeProfitTrigger: { type: Number, default: 5.0 }, 
    profitLockFloor: { type: Number, default: 2.0 },   
    minTrendStrength: { type: Number, default: 25 }
}));

let activeBrain = { trailMultiplier: 1.5, stopMultiplier: 2.0, takeProfitTrigger: 5.0, profitLockFloor: 2.0, minTrendStrength: 25 };

async function loadBotBrain() {
    let brain = await BotBrain.findOne();
    if (!brain) brain = await BotBrain.create({});
    activeBrain = brain;
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
            <div style="background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #0ea5e9;">
                <h2 style="color: #38bdf8; margin: 0;">🟢 ACTIVE: ${activePosition.side}</h2>
                <div style="display: grid; grid-template-columns: 1fr 1fr; margin-top: 10px;">
                    <div>Entry: <b>$${activePosition.entryPrice}</b></div>
                    <div>PnL: <b style="color: ${activePosition.pnlPct >= 0 ? '#22c55e' : '#ef4444'}">${activePosition.pnlPct.toFixed(2)}%</b></div>
                    <div>Started: <b>${new Date(activePosition.startTime).toLocaleTimeString()}</b></div>
                    <div style="color: #facc15">Mode: ${activePosition.pnlPct > activeBrain.takeProfitTrigger ? '🔥 BREAKOUT' : '🔍 MONITORING'}</div>
                </div>
            </div>
        ` : `<div style="padding: 20px; border: 1px dashed #334155; color: #94a3b8; border-radius: 12px;">⚪ NO ACTIVE TRADES - SCANNING MARKET</div>`;

        res.send(`
            <html><head><title>Sniper V5.1</title><meta http-equiv="refresh" content="5"></head>
            <body style="background:#0b0f19; color:white; font-family:sans-serif; padding: 20px;">
                <h1 style="color: #38bdf8">🎯 Elite Sniper V5.1</h1>
                <div style="display:flex; gap: 20px; margin-bottom: 20px;">
                    <div style="background:#1e293b; padding:15px; border-radius:10px; flex:1;">
                        <span style="color:#94a3b8">TOTAL ACCOUNT EQUITY</span><br>
                        <strong style="font-size: 24px; color: #facc15">$${liveTotalEquity.toFixed(2)}</strong>
                    </div>
                    <div style="background:#1e293b; padding:15px; border-radius:10px; flex:1;">
                        <span style="color:#94a3b8">TOTAL ACCUMULATED PNL</span><br>
                        <strong style="font-size: 24px; color: ${totalPnlUsd >=0 ? '#22c55e':'#ef4444'}">$${totalPnlUsd}</strong>
                    </div>
                </div>
                ${posHtml}
                <h3 style="margin-top:30px;">📝 TRADE HISTORY (START/END TIME)</h3>
                <table style="width:100%; border-collapse: collapse; text-align: left;">
                    <tr style="background:#1e293b; color:#94a3b8;"><th style="padding:10px;">Entry Time</th><th style="padding:10px;">Side</th><th style="padding:10px;">PnL %</th><th style="padding:10px;">Duration</th><th style="padding:10px;">Total Equity After</th></tr>
                    ${recentTrades.map(t => {
                        const duration = Math.floor((t.endTime - t.startTime) / 60000); // in minutes
                        return `<tr style="border-bottom: 1px solid #334155;">
                            <td style="padding:10px;">${new Date(t.startTime).toLocaleString()}</td>
                            <td style="padding:10px;">${t.side}</td>
                            <td style="padding:10px; color:${t.isWin ? '#22c55e' : '#ef4444'}">${t.pnlPercentage.toFixed(2)}%</td>
                            <td style="padding:10px;">${duration}m</td>
                            <td style="padding:10px;">$${t.equityAfter.toFixed(2)}</td>
                        </tr>`;
                    }).join('')}
                </table>
            </body></html>
        `);
    } catch (e) { res.send("Dashboard error: " + e.message); }
});

// ==========================================
// LOGIC FUNCTIONS
// ==========================================
async function updateAccountEquity() {
    const balance = await mexc.fetchBalance();
    const positions = await mexc.fetchPositions([symbol]);
    
    // Total Equity = Wallet Balance + Unrealized PnL
    let walletBalance = balance.total['USDT'] || 0;
    let totalUnrealizedPnl = 0;

    positions.forEach(p => {
        if (parseFloat(p.contracts) > 0) {
            totalUnrealizedPnl += parseFloat(p.unrealizedPnl || 0);
        }
    });

    liveTotalEquity = walletBalance + totalUnrealizedPnl;
}

async function getMarketContext() {
    const[ohlcv1h, ohlcv15m] = await Promise.all([
        mexc.fetchOHLCV(symbol, '1h', undefined, 50),
        mexc.fetchOHLCV(symbol, '15m', undefined, 50)
    ]);
    const closes15m = ohlcv15m.map(c => c[4]);
    const currentPrice = closes15m[closes15m.length - 1];
    
    return { 
        currentPrice, 
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
            pnlUsd: netPnlUsd, 
            equityAfter: liveTotalEquity, 
            isWin: netPnlUsd > 0,
            startTime: startTime,
            endTime: new Date()
        });
        
        sendTelegramAlert(`💸 CLOSED ${side}\nNet: $${netPnlUsd.toFixed(2)}\nEquity: $${liveTotalEquity.toFixed(2)}`);
        activePosition = null;
    } catch (e) { console.error("Exit processing error:", e.message); }
}

// ==========================================
// BOT LOOP
// ==========================================
async function runBot() {
    if (isTrading) return; 
    isTrading = true;
    try {
        await updateAccountEquity();
        const ctx = await getMarketContext();
        const market = await mexc.market(symbol);
        const contractSize = market.contractSize;

        const positions = await mexc.fetchPositions([symbol]);
        const longPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'long');
        const shortPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'short');

        // POSITION RECOVERY (If bot restarts during a trade)
        if (longPos || shortPos) {
            const pos = longPos || shortPos;
            const entry = parseFloat(pos.entryPrice);
            const side = longPos ? 'LONG' : 'SHORT';
            const pnl = side === 'LONG' ? ((ctx.currentPrice - entry) / entry) * leverage * 100 : ((entry - ctx.currentPrice) / entry) * leverage * 100;
            
            if (!activePosition) {
                activePosition = { side, entryPrice: entry, startTime: new Date(pos.timestamp || Date.now()), pnlPct: pnl };
            } else {
                activePosition.pnlPct = pnl;
            }
        }

        // MANAGEMENT LOGIC
        if (longPos) {
            if (peakPrice === 0 || ctx.currentPrice > peakPrice) peakPrice = ctx.currentPrice;
            let stopLoss = activePosition.entryPrice - (ctx.swing.atr * activeBrain.stopMultiplier);
            
            if (activePosition.pnlPct >= activeBrain.takeProfitTrigger) {
                const floor = activePosition.entryPrice * (1 + (activeBrain.profitLockFloor / 100 / leverage));
                const trail = peakPrice - (ctx.swing.atr * (activeBrain.trailMultiplier * 0.7)); 
                stopLoss = Math.max(floor, trail);
            } else {
                stopLoss = Math.max(stopLoss, peakPrice - (ctx.swing.atr * activeBrain.trailMultiplier));
            }

            if (ctx.currentPrice < stopLoss) {
                await mexc.createMarketSellOrder(symbol, parseFloat(longPos.contracts), { 'reduceOnly': true });
                await processTradeExit('LONG', activePosition.entryPrice, ctx.currentPrice, parseFloat(longPos.contracts), contractSize, activePosition.startTime);
                peakPrice = 0;
            }
        } else if (shortPos) {
            if (peakPrice === 0 || ctx.currentPrice < peakPrice) peakPrice = ctx.currentPrice;
            let stopLoss = activePosition.entryPrice + (ctx.swing.atr * activeBrain.stopMultiplier);

            if (activePosition.pnlPct >= activeBrain.takeProfitTrigger) {
                const floor = activePosition.entryPrice * (1 - (activeBrain.profitLockFloor / 100 / leverage));
                const trail = peakPrice + (ctx.swing.atr * (activeBrain.trailMultiplier * 0.7));
                stopLoss = Math.min(floor, trail);
            } else {
                stopLoss = Math.min(stopLoss, peakPrice + (ctx.swing.atr * activeBrain.trailMultiplier));
            }

            if (ctx.currentPrice > stopLoss) {
                await mexc.createMarketBuyOrder(symbol, parseFloat(shortPos.contracts), { 'reduceOnly': true });
                await processTradeExit('SHORT', activePosition.entryPrice, ctx.currentPrice, parseFloat(shortPos.contracts), contractSize, activePosition.startTime);
                peakPrice = 0;
            }
        }

        // ENTRY LOGIC
        if (!longPos && !shortPos && liveTotalEquity > 10) {
            const contractsToTrade = Math.floor((liveTotalEquity * riskFactor * leverage) / ctx.currentPrice / contractSize);
            if (contractsToTrade >= 1) {
                if (ctx.swing.trend === 'BULLISH' && ctx.swing.strength > activeBrain.minTrendStrength && ctx.swing.macd.histogram > 0) {
                    await mexc.createMarketBuyOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                    activePosition = { side: 'LONG', entryPrice: ctx.currentPrice, startTime: new Date(), pnlPct: 0 };
                    sendTelegramAlert(`🚀 LONG ENTRY\nPrice: $${ctx.currentPrice}\nEquity: $${liveTotalEquity.toFixed(2)}`);
                    peakPrice = ctx.currentPrice;
                } else if (ctx.swing.trend === 'BEARISH' && ctx.swing.strength > activeBrain.minTrendStrength && ctx.swing.macd.histogram < 0) {
                    await mexc.createMarketSellOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                    activePosition = { side: 'SHORT', entryPrice: ctx.currentPrice, startTime: new Date(), pnlPct: 0 };
                    sendTelegramAlert(`📉 SHORT ENTRY\nPrice: $${ctx.currentPrice}\nEquity: $${liveTotalEquity.toFixed(2)}`);
                    peakPrice = ctx.currentPrice;
                }
            }
        }
    } catch (e) { console.error("Loop Error:", e.message); }
    finally { isTrading = false; }
}

async function startBot() {
    await loadBotBrain();
    app.listen(port);
    setInterval(runBot, 7000); 
}
startBot();
