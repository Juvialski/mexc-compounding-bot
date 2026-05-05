const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
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
const takerFeeRate = 0.0002; // 0.02% MEXC Futures Taker Fee
const obiThreshold = 0.20; 
const historyLimit = 5;         
let obiHistory = [];
let isTrading = false;
let peakPrice = 0; 

// ==========================================
// TELEGRAM NOTIFICATIONS
// ==========================================
async function sendTelegramAlert(message) {
    const token = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return; 
    
    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(message)}`;
        await fetch(url); 
    } catch (err) {
        console.error("Telegram error:", err.message);
    }
}

// ==========================================
// AI MEMORY & DATABASE SETUP (MONGOOSE)
// ==========================================
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ [DATABASE] AI Memory Connected Successfully!"))
    .catch(err => console.error("❌ [DATABASE ERROR]", err));

const BotBrainSchema = new mongoose.Schema({
    trailMultiplier: { type: Number, default: 1.5 },
    stopMultiplier: { type: Number, default: 2.0 },
    minTrendStrength: { type: Number, default: 25 },
    rsiOverbought: { type: Number, default: 70 },
    rsiOversold: { type: Number, default: 30 }
});
const BotBrain = mongoose.model('BotBrain', BotBrainSchema);

const TradeSchema = new mongoose.Schema({
    side: String,
    entryPrice: Number,
    exitPrice: Number,
    pnlPercentage: Number,
    pnlUsd: { type: Number, default: 0 },
    balanceAfter: { type: Number, default: 0 },
    isWin: Boolean,
    timestamp: { type: Date, default: Date.now }
});
const Trade = mongoose.model('Trade', TradeSchema);

let activeBrain = {
    trailMultiplier: 1.5, stopMultiplier: 2.0, minTrendStrength: 25, rsiOverbought: 70, rsiOversold: 30
};

async function loadBotBrain() {
    try {
        let brain = await BotBrain.findOne();
        if (!brain) {
            console.log("🧠 [AI] No previous brain found. Creating new DNA...");
            brain = await BotBrain.create({});
        }
        activeBrain = brain;
        console.log("🧬 [AI DNA LOADED]:", activeBrain);
    } catch (e) {
        console.error("Error loading brain:", e.message);
    }
}

// ==========================================
// LIVE DASHBOARD (EXPRESS UI)
// ==========================================
app.get('/', async (req, res) => {
    try {
        const allTrades = await Trade.find().sort({ timestamp: -1 });
        const recentTrades = allTrades.slice(0, 15); 
        const brain = await BotBrain.findOne() || activeBrain;

        const totalTrades = allTrades.length;
        const totalWins = allTrades.filter(t => t.isWin).length;
        const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(2) : 0;
        
        // Sum USD Pnl
        const totalPnlUsd = allTrades.reduce((sum, t) => sum + (t.pnlUsd || 0), 0).toFixed(2);
        
        // Fetch Live Balance 
        let liveBalance = 0;
        try {
            const balanceData = await mexc.fetchBalance();
            liveBalance = balanceData.total['USDT'] || 0;
        } catch (e) {
            liveBalance = allTrades.length > 0 ? allTrades[0].balanceAfter : 0; // Fallback to last recorded DB balance
        }

        const html = `
            <html>
            <head>
                <title>Elite Sniper V5 - Live Dashboard</title>
                <style>
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0b0f19; color: #e2e8f0; padding: 20px; }
                    .container { max-width: 1050px; margin: auto; }
                    .card { background: #1e293b; padding: 20px; border-radius: 12px; margin-bottom: 20px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.5); }
                    h1 { color: #38bdf8; text-align: center; border-bottom: 1px solid #334155; padding-bottom: 10px;}
                    h2 { color: #a78bfa; margin-top: 0; }
                    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 14px; }
                    th, td { border-bottom: 1px solid #334155; padding: 12px; text-align: left; }
                    th { background-color: #0f172a; color: #94a3b8; font-weight: 600;}
                    .win { color: #22c55e; font-weight: bold; }
                    .loss { color: #ef4444; font-weight: bold; }
                    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
                    .stat-row { display: flex; justify-content: space-between; margin-bottom: 8px; border-bottom: 1px dashed #334155; padding-bottom: 4px; }
                    .highlight { color: #facc15; font-weight: bold; font-size: 16px; }
                </style>
                <meta http-equiv="refresh" content="30">
            </head>
            <body>
                <div class="container">
                    <h1>🎯 Elite Sniper V5: Live Operations</h1>
                    <div class="grid">
                        <div class="card">
                            <h2>📊 Performance Stats</h2>
                            <div class="stat-row"><span>Live Account Balance:</span> <strong class="highlight">$${liveBalance.toFixed(2)}</strong></div>
                            <div class="stat-row"><span>Total Trades:</span> <strong>${totalTrades}</strong></div>
                            <div class="stat-row"><span>Win Rate:</span> <strong>${winRate}%</strong></div>
                            <div class="stat-row"><span>Total Net PnL (USD):</span> <strong class="${totalPnlUsd >= 0 ? 'win' : 'loss'}">$${totalPnlUsd}</strong></div>
                            <div class="stat-row"><span>Bot Status:</span> <strong>${isTrading ? "Processing..." : "Scanning Markets..."}</strong></div>
                        </div>
                        <div class="card">
                            <h2>🧬 Current AI DNA</h2>
                            <div class="stat-row"><span>Trail Multiplier:</span> <strong>${brain.trailMultiplier.toFixed(2)}</strong></div>
                            <div class="stat-row"><span>Stop Multiplier:</span> <strong>${brain.stopMultiplier.toFixed(2)}</strong></div>
                            <div class="stat-row"><span>Min Trend Strength:</span> <strong>${brain.minTrendStrength.toFixed(0)}</strong></div>
                            <div class="stat-row"><span>RSI Overbought:</span> <strong>${brain.rsiOverbought.toFixed(0)}</strong></div>
                            <div class="stat-row"><span>RSI Oversold:</span> <strong>${brain.rsiOversold.toFixed(0)}</strong></div>
                        </div>
                    </div>
                    <div class="card">
                        <h2>📝 Last 15 Trades</h2>
                        <table>
                            <tr><th>Date</th><th>Side</th><th>Entry</th><th>Exit</th><th>Net PnL ($)</th><th>Net PnL (%)</th><th>Result</th></tr>
                            ${recentTrades.map(t => `
                                <tr>
                                    <td>${new Date(t.timestamp).toLocaleString()}</td>
                                    <td>${t.side}</td>
                                    <td>$${t.entryPrice.toFixed(2)}</td>
                                    <td>$${t.exitPrice.toFixed(2)}</td>
                                    <td class="${t.isWin ? 'win' : 'loss'}">$${(t.pnlUsd || 0).toFixed(2)}</td>
                                    <td class="${t.isWin ? 'win' : 'loss'}">${(t.pnlPercentage || 0).toFixed(2)}%</td>
                                    <td class="${t.isWin ? 'win' : 'loss'}">${t.isWin ? 'WIN' : 'LOSS'}</td>
                                </tr>
                            `).join('')}
                        </table>
                    </div>
                </div>
            </body>
            </html>
        `;
        res.send(html);
    } catch (error) {
        res.status(500).send("Error loading dashboard.");
    }
});

app.listen(port, () => console.log(`🌐 Dashboard running on port ${port}`));

// ==========================================
// CORE TRADING FUNCTIONS
// ==========================================
async function getMarketContext() {
    const[ohlcv1h, ohlcv15m] = await Promise.all([
        mexc.fetchOHLCV(symbol, '1h', undefined, 50),
        mexc.fetchOHLCV(symbol, '15m', undefined, 50)
    ]);
    
    const closes1h = ohlcv1h.map(c => c[4]);
    const closes15m = ohlcv15m.map(c => c[4]);
    const highs15m = ohlcv15m.map(c => c[2]);
    const lows15m = ohlcv15m.map(c => c[3]);
    const volumes15m = ohlcv15m.map(c => c[5]);

    const smaValue1h = SMA.calculate({ period: 20, values: closes1h }).pop();
    const currentPrice = closes15m[closes15m.length - 1];
    const trend1h = currentPrice > smaValue1h ? 'BULLISH' : 'BEARISH';
    
    const adxData15m = ADX.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 }).pop();
    const trendStrength15m = adxData15m ? adxData15m.adx : 0;
    const rsi15m = RSI.calculate({ period: 14, values: closes15m }).pop();
    const atr15m = ATR.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m }).pop();
    const macd15m = MACD.calculate({ values: closes15m, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }).pop();
    const bb15m = BollingerBands.calculate({ period: 20, values: closes15m, stdDev: 2 }).pop();
    
    const obvValues15m = OBV.calculate({ close: closes15m, volume: volumes15m });
    const isVolumeConfirming15m = trend1h === 'BULLISH' ? obvValues15m[obvValues15m.length - 1] > obvValues15m[obvValues15m.length - 4] : obvValues15m[obvValues15m.length - 4] > obvValues15m[obvValues15m.length - 1];

    return { 
        currentPrice, 
        swing: { trend: trend1h, strength: trendStrength15m, rsi: rsi15m, atr: atr15m, macd: macd15m, bb: bb15m, volConfirm: isVolumeConfirming15m }
    };
}

// ==========================================
// EVOLUTION LOGIC (SELF-IMPROVEMENT)
// ==========================================
async function processTradeExit(side, entryPrice, exitPrice, contracts, contractSize) {
    try {
        // 1. Calculate the USD value of the position
        const positionValueEntry = entryPrice * contracts * contractSize;
        const positionValueExit = exitPrice * contracts * contractSize;
        
        // Initial Margin based on Leverage
        const initialMarginUsd = positionValueEntry / leverage;

        // 2. Calculate Raw PnL in USD
        let rawPnlUsd = 0;
        if (side === 'LONG') {
            rawPnlUsd = (exitPrice - entryPrice) * contracts * contractSize;
        } else {
            rawPnlUsd = (entryPrice - exitPrice) * contracts * contractSize;
        }
        
        // 3. Calculate Exact Fees in USD
        const entryFeeUsd = positionValueEntry * takerFeeRate;
        const exitFeeUsd = positionValueExit * takerFeeRate;
        const totalFeeUsd = entryFeeUsd + exitFeeUsd;
        
        // 4. Calculate True Net PnL
        const netPnlUsd = rawPnlUsd - totalFeeUsd;
        const netPnlPercentage = (netPnlUsd / initialMarginUsd) * 100;
        const isWin = netPnlUsd > 0;

        // 5. Fetch Account Balance After Trade
        const balanceData = await mexc.fetchBalance();
        const currentUsdtBalance = balanceData.total['USDT'] || 0;

        await Trade.create({ 
            side, entryPrice, exitPrice, 
            pnlPercentage: netPnlPercentage, 
            pnlUsd: netPnlUsd,
            balanceAfter: currentUsdtBalance,
            isWin 
        });

        console.log(`💾 [MEMORY] Trade saved. Result: ${isWin ? 'WIN' : 'LOSS'} | Net PnL: $${netPnlUsd.toFixed(2)} (${netPnlPercentage.toFixed(2)}%)`);
        
        sendTelegramAlert(
            `💸 TRADE CLOSED: ${side}\n` +
            `Result: ${isWin ? 'WIN ✅' : 'LOSS ❌'}\n` +
            `Net PnL: $${netPnlUsd.toFixed(2)} (${netPnlPercentage.toFixed(2)}%)\n` +
            `Entry: $${entryPrice}\n` +
            `Exit: $${exitPrice}\n\n` +
            `💼 Current Balance: $${currentUsdtBalance.toFixed(2)}`
        );

        evolveBot();
    } catch (e) {
        console.error("Error saving trade:", e.message);
    }
}

async function evolveBot() {
    try {
        const recentTrades = await Trade.find().sort({ timestamp: -1 }).limit(10);
        if (recentTrades.length < 10) return; 

        const wins = recentTrades.filter(t => t.isWin).length;
        const winRate = wins / recentTrades.length;
        
        console.log(`🤖 [EVOLUTION] Analyzing last 10 trades. Win Rate: ${(winRate * 100).toFixed(0)}%`);

        let brain = await BotBrain.findOne();
        let changed = false;

        if (winRate < 0.40) {
            brain.minTrendStrength = Math.min(brain.minTrendStrength + 2, 40); 
            brain.stopMultiplier = Math.max(brain.stopMultiplier - 0.2, 1.0);  
            brain.rsiOverbought = Math.min(brain.rsiOverbought + 2, 85);       
            brain.rsiOversold = Math.max(brain.rsiOversold - 2, 15);
            changed = true;
        } 
        else if (winRate >= 0.60) {
            brain.trailMultiplier = Math.min(brain.trailMultiplier + 0.1, 3.0); 
            changed = true;
        } 

        if (changed) {
            await brain.save();
            activeBrain = brain; 
            console.log(`🧬 [NEW DNA EVOLVED]:`, activeBrain);
            
            sendTelegramAlert(`🧬 AI DNA EVOLVED\nRecent Win Rate: ${(winRate * 100).toFixed(0)}%\nNew Stop Multiplier: ${brain.stopMultiplier.toFixed(2)}\nNew Trail Multiplier: ${brain.trailMultiplier.toFixed(2)}\nTrend Strength Reqd: ${brain.minTrendStrength}`);
        }
    } catch (e) {
        console.error("Evolution error:", e.message);
    }
}

// ==========================================
// MAIN BOT LOOP
// ==========================================
async function runBot() {
    if (isTrading) return; 
    isTrading = true;

    try {
        const openOrders = await mexc.fetchOpenOrders(symbol);
        
        if (openOrders.length > 0) {
            for (let order of openOrders) {
                try { await mexc.cancelOrder(order.id, symbol); } catch(e) {}
            }
        }

        // Fetch Market config to correctly calculate contract sizes for PnL
        const market = await mexc.market(symbol);
        const contractSize = market.contractSize;

        const ctx = await getMarketContext();
        const balance = await mexc.fetchBalance();
        const usdtBalance = balance.total['USDT'] || 0;

        const positions = await mexc.fetchPositions([symbol]);
        const longPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'long');
        const shortPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'short');

        const orderbook = await mexc.fetchOrderBook(symbol, 50);
        const sumBids = orderbook.bids.reduce((a, b) => a + b[1], 0);
        const sumAsks = orderbook.asks.reduce((a, b) => a + b[1], 0);
        const currentObi = (sumBids - sumAsks) / (sumBids + sumAsks);
        obiHistory.push(currentObi);
        if (obiHistory.length > historyLimit) obiHistory.shift();
        const avgObi = obiHistory.reduce((a, b) => a + b, 0) / obiHistory.length;

        console.log(`[LOG] Price: ${ctx.currentPrice} | Bal: $${usdtBalance.toFixed(2)} | Trend ADX: ${ctx.swing.strength.toFixed(1)}`);

        const activeAtr = ctx.swing.atr; 
        const trailMult = activeBrain.trailMultiplier;
        const stopMult = activeBrain.stopMultiplier;

        // --- LONG POSITION MANAGEMENT ---
        if (longPos) {
            if (peakPrice === 0 || ctx.currentPrice > peakPrice) peakPrice = ctx.currentPrice;
            const entryPrice = parseFloat(longPos.entryPrice);
            const contractsAmount = parseFloat(longPos.contracts);

            let stopLoss = entryPrice - (activeAtr * stopMult);
            if (ctx.currentPrice > entryPrice + (activeAtr * trailMult)) stopLoss = Math.max(stopLoss, entryPrice);
            const trailingStop = peakPrice - (activeAtr * trailMult);
            stopLoss = Math.max(stopLoss, trailingStop);

            const isSwingExit = ctx.swing.rsi > activeBrain.rsiOverbought && ctx.swing.macd.histogram < 0;

            if (ctx.currentPrice < stopLoss || isSwingExit) {
                console.log(`>>> EXIT LONG (SWING). MARKET STOP TRIGGERED.`);
                await mexc.createMarketSellOrder(symbol, contractsAmount, { 'reduceOnly': true });
                await processTradeExit('LONG', entryPrice, ctx.currentPrice, contractsAmount, contractSize);
                peakPrice = 0;
            }
        }

        // --- SHORT POSITION MANAGEMENT ---
        if (shortPos) {
            if (peakPrice === 0 || ctx.currentPrice < peakPrice) peakPrice = ctx.currentPrice;
            const entryPrice = parseFloat(shortPos.entryPrice);
            const contractsAmount = parseFloat(shortPos.contracts);

            let stopLoss = entryPrice + (activeAtr * stopMult);
            if (ctx.currentPrice < entryPrice - (activeAtr * trailMult)) stopLoss = Math.min(stopLoss, entryPrice);
            const trailingStop = peakPrice + (activeAtr * trailMult);
            stopLoss = Math.min(stopLoss, trailingStop);

            const isSwingExit = ctx.swing.rsi < activeBrain.rsiOversold && ctx.swing.macd.histogram > 0;

            if (ctx.currentPrice > stopLoss || isSwingExit) {
                console.log(`>>> EXIT SHORT (SWING). MARKET STOP TRIGGERED.`);
                await mexc.createMarketBuyOrder(symbol, contractsAmount, { 'reduceOnly': true });
                await processTradeExit('SHORT', entryPrice, ctx.currentPrice, contractsAmount, contractSize);
                peakPrice = 0;
            }
        }

        // --- ENTRY LOGIC (MARKET ORDERS) ---
        const btcToTrade = (usdtBalance * riskFactor * leverage) / ctx.currentPrice;
        let contractsToTrade = Math.floor(btcToTrade / contractSize);

        if (contractsToTrade >= 1 && !longPos && !shortPos && usdtBalance > 5) {
            const isOverextendedLong = ctx.currentPrice >= ctx.swing.bb.upper;
            const isOverextendedShort = ctx.currentPrice <= ctx.swing.bb.lower;

            if (ctx.currentPrice > ctx.swing.bb.middle && ctx.swing.rsi > activeBrain.rsiOverbought && ctx.swing.macd.histogram < 0 && avgObi < 0) {
                console.log(`>>> SWING REVERSAL SHORT MARKET: ${contractsToTrade} Contracts`);
                await mexc.createMarketSellOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                sendTelegramAlert(`🚀 ENTRY ALERT: SHORT (Reversal)\nPrice: ~$${ctx.currentPrice}\nContracts: ${contractsToTrade}\nBalance: $${usdtBalance.toFixed(2)}`);
                obiHistory =[]; peakPrice = ctx.currentPrice;
            }
            else if (ctx.currentPrice < ctx.swing.bb.middle && ctx.swing.rsi < activeBrain.rsiOversold && ctx.swing.macd.histogram > 0 && avgObi > 0) {
                console.log(`>>> SWING REVERSAL LONG MARKET: ${contractsToTrade} Contracts`);
                await mexc.createMarketBuyOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                sendTelegramAlert(`🚀 ENTRY ALERT: LONG (Reversal)\nPrice: ~$${ctx.currentPrice}\nContracts: ${contractsToTrade}\nBalance: $${usdtBalance.toFixed(2)}`);
                obiHistory =[]; peakPrice = ctx.currentPrice;
            }
            else if (ctx.swing.trend === 'BULLISH' && !isOverextendedLong && ctx.swing.macd.histogram > 0 && ctx.swing.strength > activeBrain.minTrendStrength && ctx.swing.volConfirm && avgObi > obiThreshold) {
                console.log(`>>> SWING TREND LONG MARKET: ${contractsToTrade} Contracts`);
                await mexc.createMarketBuyOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                sendTelegramAlert(`📈 ENTRY ALERT: LONG (Trend)\nPrice: ~$${ctx.currentPrice}\nContracts: ${contractsToTrade}\nBalance: $${usdtBalance.toFixed(2)}`);
                obiHistory =[]; peakPrice = ctx.currentPrice; 
            } 
            else if (ctx.swing.trend === 'BEARISH' && !isOverextendedShort && ctx.swing.macd.histogram < 0 && ctx.swing.strength > activeBrain.minTrendStrength && ctx.swing.volConfirm && avgObi < -obiThreshold) {
                console.log(`>>> SWING TREND SHORT MARKET: ${contractsToTrade} Contracts`);
                await mexc.createMarketSellOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                sendTelegramAlert(`📉 ENTRY ALERT: SHORT (Trend)\nPrice: ~$${ctx.currentPrice}\nContracts: ${contractsToTrade}\nBalance: $${usdtBalance.toFixed(2)}`);
                obiHistory =[]; peakPrice = ctx.currentPrice;
            }
        }
    } catch (e) {
        console.error("Loop Error:", e.message);
    } finally {
        isTrading = false;
    }
}

async function startBot() {
    try {
        await mexc.loadMarkets();
        try { 
            await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 1 }); 
            await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 2 }); 
        } catch (e) {}
        
        await loadBotBrain();

        console.log(`✅ SUCCESS: ELITE SNIPER V5 ACTIVE ON ${symbol}`);
        
        const balanceData = await mexc.fetchBalance();
        const initialBal = balanceData.total['USDT'] || 0;
        sendTelegramAlert(`✅ Bot Started: Elite Sniper V5 is active on ${symbol}.\nStarting Balance: $${initialBal.toFixed(2)}\nReady to trade.`);
        
        setInterval(runBot, 5000); 
    } catch (error) {
        console.error("STARTUP ERROR:", error.message);
    }
}

startBot();
