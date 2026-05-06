const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const { RSI, SMA, ATR, MACD } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;

// ==========================================
// BOT CONFIGURATION
// ==========================================
const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskPerTradePercent = 2.0; // Risk 2% of total balance per trade
const takerFeeRate = 0.0006; // Estimated MEXC taker fee

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' },
    enableRateLimit: true 
});

// Global States
let isTrading = false;
let liveTotalEquity = 0; 
let liveWalletBalance = 0;
let liveUnrealizedPnl = 0;
let currentMarketPrice = 0;
let globalContractSize = 0;
let activePosition = null; 
let tp1Reached = false; 

// ==========================================
// DATABASE & AI BRAIN
// ==========================================
mongoose.connect(process.env.MONGO_URI).catch(err => console.error("❌ DB ERROR", err));

const Trade = mongoose.model('Trade', new mongoose.Schema({
    side: String, entryPrice: Number, exitPrice: Number,
    pnlPercentage: Number, pnlUsd: Number, equityAfter: Number, 
    isWin: Boolean, startTime: Date, endTime: { type: Date, default: Date.now }
}));

// ==========================================
// TECHNICAL ANALYSIS
// ==========================================
async function getMarketContext() {
    const [ohlcv1h, ohlcv15m, ohlcv5m] = await Promise.all([
        mexc.fetchOHLCV(symbol, '1h', undefined, 100),
        mexc.fetchOHLCV(symbol, '15m', undefined, 100),
        mexc.fetchOHLCV(symbol, '5m', undefined, 100)
    ]);

    const closes1h = ohlcv1h.map(c => c[4]);
    const closes15m = ohlcv15m.map(c => c[4]);
    const closes5m = ohlcv5m.map(c => c[4]);
    
    currentMarketPrice = closes5m[closes5m.length - 1];

    // Indicators
    const sma50_1h = SMA.calculate({ period: 50, values: closes1h });
    const rsi15m = RSI.calculate({ period: 14, values: closes15m });
    const macd5m = MACD.calculate({ 
        values: closes5m, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, 
        SimpleMAOscillator: false, SimpleMASignal: false 
    });
    const atr15m = ATR.calculate({ 
        period: 14, high: ohlcv15m.map(c => c[2]), low: ohlcv15m.map(c => c[3]), close: closes15m 
    });

    return {
        price: currentMarketPrice,
        trend1h: currentMarketPrice > sma50_1h.pop() ? 'BULL' : 'BEAR',
        rsi: rsi15m.pop(),
        macd: macd5m.pop(),
        atr: atr15m.pop(),
        volumeHigh: ohlcv5m[ohlcv5m.length-1][5] > (ohlcv5m.slice(-10).reduce((a, b) => a + b[5], 0) / 10)
    };
}

// ==========================================
// CORE TRADING LOGIC
// ==========================================
async function updateAccountEquity() {
    try {
        const balance = await mexc.fetchBalance();
        liveWalletBalance = balance.total['USDT'] || 0; 
    } catch(e) { console.error("Equity Sync Failed"); }
}

async function runBot() {
    if (isTrading) return; 
    isTrading = true;

    try {
        await updateAccountEquity();
        const ctx = await getMarketContext();
        const market = await mexc.market(symbol);
        globalContractSize = market.contractSize;

        const positions = await mexc.fetchPositions([symbol]);
        const pos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0);

        if (pos) {
            // --- POSITION MANAGEMENT ---
            const side = pos.side.toUpperCase();
            const entry = parseFloat(pos.entryPrice);
            const contracts = parseFloat(pos.contracts);
            const pnlUsd = side === 'LONG' ? 
                (ctx.price - entry) * contracts * globalContractSize : 
                (entry - ctx.price) * contracts * globalContractSize;
            
            liveUnrealizedPnl = pnlUsd;
            liveTotalEquity = liveWalletBalance + pnlUsd;

            // Define SL and TP levels (Risk:Reward 1:1.5)
            const stopDist = ctx.atr * 2.5; 
            const targetDist = stopDist * 1.5;

            if (side === 'LONG') {
                const stopLoss = tp1Reached ? entry + (entry * 0.001) : entry - stopDist;
                const tp1 = entry + targetDist;

                // Take Partial Profit
                if (!tp1Reached && ctx.price >= tp1) {
                    const half = Math.floor(contracts / 2);
                    if (half >= 1) {
                        await mexc.createMarketSellOrder(symbol, half, { 'reduceOnly': true });
                        tp1Reached = true;
                        sendTelegramAlert("🎯 TP1 Hit (50%)! Moving Stop Loss to Break-even.");
                    }
                }
                // Exit Condition (Stop Loss or Trend Flip)
                if (ctx.price <= stopLoss || (tp1Reached && ctx.macd.histogram < 0)) {
                    await mexc.createMarketSellOrder(symbol, contracts, { 'reduceOnly': true });
                    await recordTrade('LONG', entry, ctx.price, contracts);
                }
            } else {
                const stopLoss = tp1Reached ? entry - (entry * 0.001) : entry + stopDist;
                const tp1 = entry - targetDist;

                if (!tp1Reached && ctx.price <= tp1) {
                    const half = Math.floor(contracts / 2);
                    if (half >= 1) {
                        await mexc.createMarketBuyOrder(symbol, half, { 'reduceOnly': true });
                        tp1Reached = true;
                        sendTelegramAlert("🎯 TP1 Hit (50%)! Moving Stop Loss to Break-even.");
                    }
                }
                if (ctx.price >= stopLoss || (tp1Reached && ctx.macd.histogram > 0)) {
                    await mexc.createMarketBuyOrder(symbol, contracts, { 'reduceOnly': true });
                    await recordTrade('SHORT', entry, ctx.price, contracts);
                }
            }
        } else {
            // --- ENTRY LOGIC ---
            tp1Reached = false;
            liveUnrealizedPnl = 0;
            liveTotalEquity = liveWalletBalance;

            // Logic: 1h Trend + 15m RSI not Overbought + 5m MACD Momentum + Volume
            const isLongSignal = ctx.trend1h === 'BULL' && ctx.rsi < 65 && ctx.macd.histogram > 0 && ctx.volumeHigh;
            const isShortSignal = ctx.trend1h === 'BEAR' && ctx.rsi > 35 && ctx.macd.histogram < 0 && ctx.volumeHigh;

            if (isLongSignal || isShortSignal) {
                const stopDist = ctx.atr * 2.5;
                // Calculate Position Size based on risking 2% of balance
                // Formula: Size = (Balance * Risk%) / (Distance to Stop)
                const riskAmount = liveWalletBalance * (riskPerTradePercent / 100);
                const contractsToTrade = Math.floor(riskAmount / (stopDist * globalContractSize));

                if (contractsToTrade >= 1) {
                    const orderSide = isLongSignal ? 'buy' : 'sell';
                    const posType = isLongSignal ? 1 : 2; // MEXC internal: 1=Long, 2=Short
                    
                    await mexc.createMarketOrder(symbol, orderSide, contractsToTrade, undefined, {
                        'openType': 1, 'positionType': posType, 'leverage': leverage
                    });

                    sendTelegramAlert(`🚀 ENTERED ${orderSide.toUpperCase()} at ${ctx.price}\nRisk: $${riskAmount.toFixed(2)}`);
                }
            }
        }
    } catch (e) { console.error("Loop Error:", e.message); }
    finally { isTrading = false; }
}

async function recordTrade(side, entry, exit, size) {
    const pnlUsd = side === 'LONG' ? (exit - entry) * size * globalContractSize : (entry - exit) * size * globalContractSize;
    const fee = (entry + exit) * size * globalContractSize * takerFeeRate;
    const netPnl = pnlUsd - fee;

    await Trade.create({
        side, entryPrice: entry, exitPrice: exit,
        pnlUsd: netPnl, pnlPercentage: (netPnl / ((entry * size * globalContractSize) / leverage)) * 100,
        equityAfter: liveWalletBalance + netPnl, isWin: netPnl > 0, startTime: new Date()
    });
    sendTelegramAlert(`📉 CLOSED ${side}\nNet PnL: $${netPnl.toFixed(2)}`);
}

function sendTelegramAlert(message) {
    const token = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return; 
    const url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(message)}`;
    https.get(url).on('error', (e) => console.error("Telegram error:", e.message));
}

// ==========================================
// STARTUP & SERVER
// ==========================================
app.get('/', (req, res) => res.send(`Elite Sniper V6 Active. Equity: $${liveTotalEquity.toFixed(2)}`));

async function start() {
    await mexc.loadMarkets();
    console.log("✅ ELITE SNIPER V6.0 ONLINE");
    setInterval(runBot, 10000); // 10 second heart-beat
}

app.listen(port, () => start());
