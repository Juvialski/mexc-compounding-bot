const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const { RSI, SMA, ATR } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;

// ==========================================
// EVOLVING PARAMETERS (The Bot's DNA)
// ==========================================
let dna = {
    rsiThreshold: 30,
    atrMultiplier: 1.5,
    rewardRatio: 1.5,
    lastEvolved: 'Never'
};

const SYMBOL = 'BTC/USDT:USDT';
const LEVERAGE = 10;
const RISK_PERCENT = 5.0; // Higher risk for small $29 account
const TAKER_FEE = 0.0006;

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' },
    enableRateLimit: true 
});

let isTrading = false;
let walletBalance = 0;
let lastTicker = { last: 0 };
let contractSize = 0.0001; 
let lastOrderTime = 0; 

// ==========================================
// DATABASE (MongoDB Free Tier)
// ==========================================
mongoose.connect(process.env.MONGO_URI).catch(err => console.error("❌ DB ERROR:", err));
const Trade = mongoose.model('Trade', new mongoose.Schema({
    side: String, entry: Number, exit: Number, pnl: Number, time: { type: Date, default: Date.now }
}));

// ==========================================
// EVOLUTION ENGINE (Self-Optimizing Backtest)
// ==========================================
async function evolve() {
    try {
        console.log("🧬 Evolution Cycle: Backtesting last 24h...");
        // 288 candles of 5m = 24 hours. Light on RAM.
        const ohlcv = await mexc.fetchOHLCV(SYMBOL, '5m', undefined, 288);
        const closes = ohlcv.map(c => c[4]);
        const highs = ohlcv.map(c => c[2]);
        const lows = ohlcv.map(c => c[3]);

        const rsiV = RSI.calculate({ period: 14, values: closes });
        const atrV = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
        const smaV = SMA.calculate({ period: 200, values: closes });

        const offsetRSI = closes.length - rsiV.length;
        const offsetSMA = closes.length - smaV.length;

        const testSettings = (rsiT, atrM, rr) => {
            let score = 0;
            // Backtest logic
            for (let i = 200; i < closes.length - 15; i++) {
                const price = closes[i];
                const rsi = rsiV[i - offsetRSI];
                const sma = smaV[i - offsetSMA];
                const atr = atrV[i - offsetRSI];

                if (price > sma && rsi < rsiT) { // Strategy: Trend pullback
                    const sl = atr * atrM;
                    const tp = sl * rr;
                    for (let j = 1; j <= 12; j++) {
                        if (lows[i + j] < price - sl) { score -= 1; break; }
                        if (highs[i + j] > price + tp) { score += rr; break; }
                    }
                }
            }
            return score;
        };

        let bestScore = -999;
        const rsiTests = [25, 30, 35];
        const atrTests = [1.2, 1.5, 2.0];
        const rrTests = [1.5, 1.8, 2.2];

        for (let r of rsiTests) {
            for (let a of atrTests) {
                for (let rr of rrTests) {
                    const s = testSettings(r, a, rr);
                    if (s > bestScore) {
                        bestScore = s;
                        dna = { 
                            rsiThreshold: r, 
                            atrMultiplier: a, 
                            rewardRatio: rr, 
                            lastEvolved: new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }) 
                        };
                    }
                }
            }
        }
        console.log("✅ New DNA Found:", dna);
    } catch (e) { console.error("Evolution Fail:", e.message); }
}

// ==========================================
// CORE TRADING TICKER
// ==========================================
async function tick() {
    if (isTrading) return;
    isTrading = true;
    try {
        const [ticker, pos, ohlcv] = await Promise.all([
            mexc.fetchTicker(SYMBOL),
            mexc.fetchPositions([SYMBOL]),
            mexc.fetchOHLCV(SYMBOL, '1m', undefined, 210)
        ]);

        lastTicker = ticker;
        const price = Number(ticker.last);
        const activePos = pos.find(p => p.symbol === SYMBOL && parseFloat(p.contracts) > 0);

        if (activePos) {
            // 1. POSITION MANAGEMENT
            const side = activePos.side.toUpperCase();
            const entry = Number(activePos.entryPrice);
            const size = Number(activePos.contracts);
            
            const closes = ohlcv.map(c => c[4]);
            const atr = ATR.calculate({ period: 14, high: ohlcv.map(c=>c[2]), low: ohlcv.map(c=>c[3]), close: closes }).pop();
            
            const stopDist = atr * dna.atrMultiplier;
            const sl = side === 'LONG' ? entry - stopDist : entry + stopDist;
            const tp = side === 'LONG' ? entry + (stopDist * dna.rewardRatio) : entry - (stopDist * dna.rewardRatio);

            const hitSL = side === 'LONG' ? price <= sl : price >= sl;
            const hitTP = side === 'LONG' ? price >= tp : price <= tp;

            if (hitSL || hitTP) {
                await mexc.createOrder(SYMBOL, 'market', side === 'LONG' ? 'sell' : 'buy', size, undefined, { 'reduceOnly': true });
                const pnlUsd = (side === 'LONG' ? (price - entry) : (entry - price)) * size * contractSize;
                await Trade.create({ side, entry, exit: price, pnl: pnlUsd });
                console.log(`💰 Closed ${side}. PnL: $${pnlUsd.toFixed(2)}`);
            }
        } else if (Date.now() - lastOrderTime > 60000) { 
            // 2. ENTRY LOGIC
            const closes = ohlcv.map(c => c[4]);
            const rsi = RSI.calculate({ period: 14, values: closes }).pop();
            const sma = SMA.calculate({ period: 200, values: closes }).pop();
            const atr = ATR.calculate({ period: 14, high: ohlcv.map(c=>c[2]), low: ohlcv.map(c=>c[3]), close: closes }).pop();

            let action = null;
            if (price > sma && rsi < dna.rsiThreshold) action = 'buy';
            if (price < sma && rsi > (100 - dna.rsiThreshold)) action = 'sell';

            if (action) {
                // SMALL ACCOUNT QUANTITY CALCULATION
                const riskUsd = walletBalance * (RISK_PERCENT / 100);
                const stopDist = atr * dna.atrMultiplier;
                const lossPerContract = stopDist * contractSize;
                
                let qty = Math.floor(riskUsd / lossPerContract);

                // Check wallet affordability (Max contracts we can buy with $29 at 10x)
                const maxAffordable = Math.floor((walletBalance * LEVERAGE * 0.8) / (price * contractSize));
                if (qty > maxAffordable) qty = maxAffordable;

                if (qty >= 1) {
                    await mexc.createOrder(SYMBOL, 'market', action, qty, undefined, { 'openType': 1 });
                    lastOrderTime = Date.now();
                    console.log(`🚀 Entered ${action} | Qty: ${qty} | Affordability: ${maxAffordable}`);
                } else {
                    console.log(`⚠️ Balance $${walletBalance.toFixed(2)} too low for current BTC volatility.`);
                }
            }
        }
    } catch (e) { console.error("Tick Error:", e.message); }
    finally { isTrading = false; }
}

async function updateAccount() {
    try {
        const bal = await mexc.fetchBalance();
        walletBalance = bal.total['USDT'] || 0;
    } catch (e) {}
}

// UI / Dashboard
app.get('/', (req, res) => {
    res.send(`
    <body style="background:#0b0f19; color:#38bdf8; font-family:sans-serif; padding:40px; line-height:1.6;">
        <div style="max-width:600px; margin:auto; border:1px solid #1e293b; padding:20px; border-radius:12px; background:#111827;">
            <h1 style="color:#fff; border-bottom:1px solid #1e293b; padding-bottom:10px;">🎯 SNIPER V10 (BTC)</h1>
            <p style="font-size:20px;">Wallet: <b style="color:#10b981;">$${walletBalance.toFixed(2)}</b></p>
            <p>BTC Price: <b>$${lastTicker.last || '0'}</b></p>
            <div style="background:#1e293b; padding:15px; border-radius:8px; margin-top:20px;">
                <h3 style="margin-top:0; color:#94a3b8;">EVOLVED DNA</h3>
                <div style="display:grid; grid-template-columns: 1fr 1fr;">
                    <span>RSI Threshold: <b>${dna.rsiThreshold}</b></span>
                    <span>ATR Multiplier: <b>${dna.atrMultiplier}</b></span>
                    <span>Reward Ratio: <b>${dna.rewardRatio}</b></span>
                    <span>Last Update: <b style="font-size:10px;">${dna.lastEvolved}</b></span>
                </div>
            </div>
            <p style="font-size:12px; color:#475569; margin-top:20px;">Status: System Running | Keep-Alive: Active</p>
        </div>
    </body>`);
});

async function start() {
    try {
        console.log("🚀 Initializing Sniper V10...");
        const markets = await mexc.loadMarkets();
        contractSize = markets[SYMBOL].contractSize;
        
        await updateAccount();
        await evolve(); // Get DNA before starting

        setInterval(tick, 2000);           // Check price/pos every 2 seconds
        setInterval(updateAccount, 15000); // Check balance every 15 seconds
        setInterval(evolve, 3600000);      // Re-evolve strategy every hour
    } catch (e) { 
        console.error("Start Error:", e.message); 
        setTimeout(start, 10000); 
    }
}

app.listen(port, () => start());
