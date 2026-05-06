const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const { RSI, SMA, ATR, BollingerBands, ADX } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;

// ==========================================
// BOT CONFIGURATION
// ==========================================
const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskPerTradePercent = 2.0; // Reduced to 2% for sustainability
const takerFeeRate = 0.0006; 
const PROBABILITY_THRESHOLD = 80; // Only trade if score >= 80

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' },
    enableRateLimit: true 
});

// Global States
let isTrading = false;
let liveWalletBalance = 0; 
let liveMarginUsed = 0;    
let liveUnrealizedPnl = 0;
let currentMarketPrice = 0;
let globalContractSize = 1.0; 
let activePosition = null;
let tp1Reached = false;
let lastOrderUpdateTime = 0;

let botThinking = {
    score: 0,
    trend: 'Analysing...',
    volatility: 'Stable',
    rsi: 0,
    logic: [],
    buyTarget: 0,
    sellTarget: 0,
    lastUpdate: Date.now()
};

// ==========================================
// UTILS & DATABASE
// ==========================================
function sendTelegramAlert(message) {
    const token = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return; 
    const url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(message)}`;
    https.get(url).on('error', (e) => console.error("Telegram error:", e.message));
}

const formatPHT = (dateInput) => {
    if (!dateInput) return 'N/A';
    return new Date(dateInput).toLocaleString('en-US', { 
        timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
};

mongoose.connect(process.env.MONGO_URI).catch(err => console.error("❌ DB ERROR", err));

const Trade = mongoose.model('Trade', new mongoose.Schema({
    side: String, entryPrice: Number, exitPrice: Number,
    pnlPercentage: Number, pnlUsd: Number, equityAfter: Number, 
    isWin: Boolean, startTime: { type: Date, default: Date.now },
    endTime: { type: Date, default: Date.now }
}));

// ==========================================
// PROBABILITY ENGINE
// ==========================================
async function getMarketContext() {
    const [ohlcv1m, ohlcv15m, ohlcv1h] = await Promise.all([
        mexc.fetchOHLCV(symbol, '1m', undefined, 100),
        mexc.fetchOHLCV(symbol, '15m', undefined, 100),
        mexc.fetchOHLCV(symbol, '1h', undefined, 200)
    ]);

    const closes1m = ohlcv1m.map(c => c[4]);
    const closes15m = ohlcv15m.map(c => c[4]);
    const highs15m = ohlcv15m.map(c => c[2]);
    const lows15m = ohlcv15m.map(c => c[3]);
    const volumes15m = ohlcv15m.map(c => c[5]);

    // Indicators
    const rsi1m = RSI.calculate({ period: 14, values: closes1m }).pop() || 50;
    const rsi15m = RSI.calculate({ period: 14, values: closes15m }).pop() || 50;
    const bb1m = BollingerBands.calculate({ period: 20, stdDev: 2.5, values: closes1m }).pop() || { upper: 0, lower: 0 };
    const sma1h = SMA.calculate({ period: 200, values: ohlcv1h.map(c => c[4]) }).pop() || 0;
    const atr15m = ATR.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m }).pop() || 0;
    
    const adxData = ADX.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m }).pop();
    const adx = adxData ? adxData.adx : 0;

    // Volume Analysis
    const avgVol = volumes15m.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const currentVol = volumes15m[volumes15m.length - 1];
    const volSpike = currentVol > avgVol * 1.8;

    return { rsi1m, rsi15m, bb1m, sma1h, atr15m, adx, volSpike, recentHigh: Math.max(...highs15m.slice(-20)), recentLow: Math.min(...lows15m.slice(-20)) };
}

function calculateProbability(side, ctx, price) {
    let score = 0;
    let logic = [];

    // 1. Trend Alignment (Weight: 30)
    const isBullish = price > ctx.sma1h;
    if (side === 'LONG' && isBullish) { score += 30; logic.push("1H Trend Up (+30)"); }
    if (side === 'SHORT' && !isBullish) { score += 30; logic.push("1H Trend Down (+30)"); }

    // 2. ADX Filter (Weight: 20)
    // We want LOW ADX for mean reversion (sniping extremes)
    if (ctx.adx < 25) { score += 20; logic.push("Low Volatility Environment (+20)"); }
    else if (ctx.adx > 40) { score -= 30; logic.push("High Trend Risk (-30)"); }

    // 3. RSI Multi-Timeframe (Weight: 25)
    if (side === 'LONG') {
        if (ctx.rsi1m < 30) { score += 15; logic.push("1M Oversold (+15)"); }
        if (ctx.rsi15m < 45) { score += 10; logic.push("15M Support Zone (+10)"); }
    } else {
        if (ctx.rsi1m > 70) { score += 15; logic.push("1M Overbought (+15)"); }
        if (ctx.rsi15m > 55) { score += 10; logic.push("15M Resistance Zone (+10)"); }
    }

    // 4. Volume Exhaustion (Weight: 25)
    if (ctx.volSpike) { score += 25; logic.push("Volume Climax Detected (+25)"); }

    return { score, logic };
}

// ==========================================
// TRADING ENGINE
// ==========================================
async function runBot() {
    if (isTrading) return;
    isTrading = true;

    try {
        const [ticker, positions, ctx] = await Promise.all([
            mexc.fetchTicker(symbol),
            mexc.fetchPositions([symbol]),
            getMarketContext()
        ]);
        
        currentMarketPrice = ticker.last;
        const pos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0);

        if (pos) {
            // POSITION MANAGEMENT
            const side = pos.side.toUpperCase();
            const entry = parseFloat(pos.entryPrice);
            const size = parseFloat(pos.contracts);
            liveUnrealizedPnl = parseFloat(pos.unrealizedPnl);
            liveMarginUsed = (entry * size * globalContractSize) / leverage;

            if (!activePosition) activePosition = { side, entryPrice: entry, startTime: Date.now() };

            // Dynamic ATR Stop Loss
            const stopDist = ctx.atr15m * 1.5;
            const takeProfitPrice = side === 'LONG' ? ctx.recentHigh : ctx.recentLow;

            // TP1 Logic (Close 50% at Recent High/Low)
            if (!tp1Reached) {
                const isTp1 = side === 'LONG' ? (currentMarketPrice >= takeProfitPrice) : (currentMarketPrice <= takeProfitPrice);
                if (isTp1) {
                    const halfSize = Math.floor(size / 2);
                    if (halfSize > 0) {
                        await mexc.createOrder(symbol, 'market', side === 'LONG' ? 'sell' : 'buy', halfSize, undefined, { 'reduceOnly': true });
                        sendTelegramAlert(`🎯 TP1 Reached! Closing 50%. Moving SL to Entry.`);
                        tp1Reached = true;
                    }
                }
            }

            // Stop Loss Logic
            const slPrice = tp1Reached ? entry : (side === 'LONG' ? entry - stopDist : entry + stopDist);
            const isStopped = side === 'LONG' ? (currentMarketPrice <= slPrice) : (currentMarketPrice >= slPrice);

            if (isStopped) {
                await mexc.createOrder(symbol, 'market', side === 'LONG' ? 'sell' : 'buy', size, undefined, { 'reduceOnly': true });
                await recordExit(side, entry, currentMarketPrice, size, activePosition.startTime);
            }

        } else {
            // ENTRY SEARCH
            liveUnrealizedPnl = 0; activePosition = null; tp1Reached = false; liveMarginUsed = 0;

            const longEval = calculateProbability('LONG', ctx, currentMarketPrice);
            const shortEval = calculateProbability('SHORT', ctx, currentMarketPrice);

            const bestScore = Math.max(longEval.score, shortEval.score);
            const bestSide = longEval.score > shortEval.score ? 'LONG' : 'SHORT';
            const bestLogic = longEval.score > shortEval.score ? longEval.logic : shortEval.logic;

            botThinking = {
                score: bestScore,
                trend: currentMarketPrice > ctx.sma1h ? 'BULLISH' : 'BEARISH',
                volatility: ctx.adx > 30 ? 'TRENDING' : 'RANGING',
                rsi: ctx.rsi1m.toFixed(1),
                logic: bestLogic,
                buyTarget: ctx.bb1m.lower,
                sellTarget: ctx.bb1m.upper,
                lastUpdate: Date.now()
            };

            if (bestScore >= PROBABILITY_THRESHOLD && (Date.now() - lastOrderUpdateTime > 60000)) {
                const openOrders = await mexc.fetchOpenOrders(symbol);
                if (openOrders.length === 0) {
                    const totalEquity = liveWalletBalance + liveMarginUsed;
                    const amountUsd = totalEquity * (riskPerTradePercent / 100) * leverage;
                    const qty = mexc.amountToPrecision(symbol, amountUsd / currentMarketPrice);
                    
                    const entryPrice = bestSide === 'LONG' ? ctx.bb1m.lower : ctx.bb1m.upper;

                    if (parseFloat(qty) > 0) {
                        await mexc.createOrder(symbol, 'limit', bestSide === 'LONG' ? 'buy' : 'sell', qty, entryPrice, {
                            'positionType': bestSide === 'LONG' ? 1 : 2,
                            'openType': 1
                        });
                        sendTelegramAlert(`⚡ SNIPER HOOK SET: ${bestSide} at $${entryPrice} (Score: ${bestScore}%)`);
                        lastOrderUpdateTime = Date.now();
                    }
                }
            }
        }
    } catch (e) {
        console.error(`Execution Error: ${e.message}`);
    } finally {
        isTrading = false;
    }
}

async function recordExit(side, entry, exit, size, start) {
    const rawPnl = side === 'LONG' ? (exit - entry) * size * globalContractSize : (entry - exit) * size * globalContractSize;
    const netPnl = rawPnl - ((entry + exit) * size * globalContractSize * takerFeeRate);
    
    const balance = await mexc.fetchBalance();
    liveWalletBalance = balance.total['USDT'] || liveWalletBalance;

    await Trade.create({
        side, entryPrice: entry, exitPrice: exit, pnlUsd: netPnl,
        pnlPercentage: (netPnl / ((entry * size * globalContractSize) / leverage)) * 100,
        equityAfter: liveWalletBalance, isWin: netPnl > 0, startTime: start, endTime: new Date()
    });
    
    sendTelegramAlert(`💰 TRADE CLOSED: ${side} | Net PnL: $${netPnl.toFixed(2)}`);
}

// ==========================================
// DASHBOARD & STARTUP
// ==========================================
app.get('/', async (req, res) => {
    const allTrades = await Trade.find().sort({ endTime: -1 }).limit(10);
    const totalPnl = (await Trade.find()).reduce((s, t) => s + t.pnlUsd, 0);
    
    res.send(`
        <html>
        <head>
            <title>Sniper V9.0 Terminal</title>
            <meta http-equiv="refresh" content="5">
            <style>
                body { background: #0f172a; color: #f8fafc; font-family: sans-serif; padding: 20px; }
                .card { background: #1e293b; padding: 20px; border-radius: 10px; border: 1px solid #334155; margin-bottom: 20px; }
                .score-bar { background: #334155; height: 20px; border-radius: 10px; overflow: hidden; margin: 10px 0; }
                .score-fill { background: #3b82f6; height: 100%; transition: width 0.5s; }
                .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; }
                .text-green { color: #10b981; } .text-red { color: #ef4444; }
                table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                th, td { padding: 12px; text-align: left; border-bottom: 1px solid #334155; }
            </style>
        </head>
        <body>
            <h1>🎯 Elite Sniper V9.0 <small style="font-size: 12px; color: #94a3b8;">PROBABILITY ENGINE</small></h1>
            
            <div class="grid">
                <div class="card">
                    <h3>Market Health</h3>
                    <p>Trend: ${botThinking.trend}</p>
                    <p>Volatility: ${botThinking.volatility}</p>
                    <p>1M RSI: ${botThinking.rsi}</p>
                </div>
                <div class="card">
                    <h3>Probability Score</h3>
                    <div style="font-size: 32px; font-weight: bold;">${botThinking.score}%</div>
                    <div class="score-bar"><div class="score-fill" style="width: ${botThinking.score}%"></div></div>
                    <p style="font-size: 12px;">Threshold for Entry: ${PROBABILITY_THRESHOLD}%</p>
                </div>
                <div class="card">
                    <h3>Balance & PnL</h3>
                    <p>Wallet: $${liveWalletBalance.toFixed(2)}</p>
                    <p>Total Net Profit: <span class="${totalPnl >= 0 ? 'text-green' : 'text-red'}">$${totalPnl.toFixed(2)}</span></p>
                </div>
            </div>

            <div class="card">
                <h3>Current Logic Matrix</h3>
                <ul>${botThinking.logic.map(l => `<li>${l}</li>`).join('')}</ul>
            </div>

            <h3>Recent Trades</h3>
            <table>
                <tr><th>Time</th><th>Side</th><th>PnL %</th><th>PnL USD</th></tr>
                ${allTrades.map(t => `
                    <tr>
                        <td>${formatPHT(t.endTime)}</td>
                        <td>${t.side}</td>
                        <td class="${t.pnlPercentage >= 0 ? 'text-green' : 'text-red'}">${t.pnlPercentage.toFixed(2)}%</td>
                        <td class="${t.pnlUsd >= 0 ? 'text-green' : 'text-red'}">$${t.pnlUsd.toFixed(2)}</td>
                    </tr>
                `).join('')}
            </table>
        </body>
        </html>
    `);
});

async function start() {
    const market = await mexc.loadMarkets();
    globalContractSize = market[symbol].contractSize || 1.0;
    
    const balance = await mexc.fetchBalance();
    liveWalletBalance = balance.total['USDT'] || 0;

    setInterval(runBot, 5000);
    console.log("🚀 V9.0 Probability Engine Started");
}

app.listen(port, () => start());
