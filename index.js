const ccxt = require('ccxt');
const express = require('express');
const { RSI, SMA, ATR } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Pro-Sniper Bot: Operational'));
app.listen(port);

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' }
});

// --- SETTINGS ---
const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskFactor = 0.05;      // Use 5% of balance per trade
const obiThreshold = 0.65;    // Order book imbalance sensitivity
const historyLimit = 5;       // OBI smoothing
let obiHistory = [];

// --- DYNAMIC STATE ---
let contractSize = 1;
let isTrading = false;

/**
 * Fetch Market Context (The "Pro" Logic)
 */
async function getMarketContext() {
    // Fetch 1h candles for Trend, 15m for Momentum
    const ohlcv1h = await mexc.fetchOHLCV(symbol, '1h', undefined, 50);
    const ohlcv15m = await mexc.fetchOHLCV(symbol, '15m', undefined, 50);

    const closes1h = ohlcv1h.map(c => c[4]);
    const closes15m = ohlcv15m.map(c => c[4]);
    const highs = ohlcv15m.map(c => c[2]);
    const lows = ohlcv15m.map(c => c[3]);

    // 1. Trend Filter (SMA 20)
    const smaValue = SMA.calculate({ period: 20, values: closes1h }).pop();
    const currentPrice = closes1h[closes1h.length - 1];
    const trend = currentPrice > smaValue ? 'BULLISH' : 'BEARISH';

    // 2. Momentum (RSI 14)
    const rsiValue = RSI.calculate({ period: 14, values: closes15m }).pop();

    // 3. Volatility (ATR for dynamic stops)
    const atrValue = ATR.calculate({ period: 14, high: highs, low: lows, close: closes15m }).pop();

    // 4. Support/Resistance (Last 24 bars)
    const support = Math.min(...lows.slice(-24));
    const resistance = Math.max(...highs.slice(-24));

    return { trend, rsi: rsiValue, atr: atrValue, support, resistance, currentPrice };
}

async function runBot() {
    if (isTrading) return; // Prevent overlapping loops
    isTrading = true;

    try {
        const context = await getMarketContext();
        const positions = await mexc.fetchPositions([symbol]);
        
        const longPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'long');
        const shortPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'short');

        const balance = await mexc.fetchBalance();
        const usdtBalance = balance.total['USDT'] || 0;

        // --- ORDER BOOK IMBALANCE CALCULATION ---
        const orderbook = await mexc.fetchOrderBook(symbol, 10);
        const sumBids = orderbook.bids.reduce((a, b) => a + b[1], 0);
        const sumAsks = orderbook.asks.reduce((a, b) => a + b[1], 0);
        const currentObi = (sumBids - sumAsks) / (sumBids + sumAsks);
        
        obiHistory.push(currentObi);
        if (obiHistory.length > historyLimit) obiHistory.shift();
        const avgObi = obiHistory.reduce((a, b) => a + b, 0) / obiHistory.length;

        console.log(`[${new Date().toISOString().split('T')[1].split('.')[0]}] Price: ${context.currentPrice} | Trend: ${context.trend} | RSI: ${context.rsi.toFixed(2)} | OBI: ${avgObi.toFixed(2)}`);

        // --- EXIT LOGIC (ATR-BASED TRAILING STOP) ---
        // If Long: Exit if price drops below (Current Price - 1.5 * ATR)
        if (longPos) {
            const stopLevel = context.currentPrice - (context.atr * 1.5);
            if (context.currentPrice < stopLevel || context.rsi > 80) {
                console.log(">>> CLOSING LONG (Stop Hit or RSI Overbought)");
                await mexc.createMarketSellOrder(symbol, longPos.contracts, { 'openType': 1, 'positionType': 1 });
            }
        }

        // If Short: Exit if price rises above (Current Price + 1.5 * ATR)
        if (shortPos) {
            const stopLevel = context.currentPrice + (context.atr * 1.5);
            if (context.currentPrice > stopLevel || context.rsi < 20) {
                console.log(">>> CLOSING SHORT (Stop Hit or RSI Oversold)");
                await mexc.createMarketBuyOrder(symbol, shortPos.contracts, { 'openType': 1, 'positionType': 2 });
            }
        }

        // --- ENTRY LOGIC (THE SNIPE) ---
        const buyingPower = usdtBalance * riskFactor * leverage;
        const contractsToTrade = Math.floor((buyingPower / context.currentPrice) / contractSize) * contractSize;

        if (contractsToTrade > 0 && !longPos && !shortPos) {
            
            // LONG CRITERIA: Trend is Bullish + OBI is positive + RSI is not overbought
            if (context.trend === 'BULLISH' && avgObi > obiThreshold && context.rsi < 60) {
                console.log(`>>> SNIPING LONG: ${contractsToTrade} units`);
                await mexc.createMarketBuyOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 1 });
                obiHistory = [];
            } 
            
            // SHORT CRITERIA: Trend is Bearish + OBI is negative + RSI is not oversold
            else if (context.trend === 'BEARISH' && avgObi < -obiThreshold && context.rsi > 40) {
                console.log(`>>> SNIPING SHORT: ${contractsToTrade} units`);
                await mexc.createMarketSellOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 2 });
                obiHistory = [];
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
        console.log("Initializing Markets...");
        const markets = await mexc.loadMarkets();
        contractSize = markets[symbol].contractSize;
        
        // Ensure Leverage is set correctly
        try {
            await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 1 }); 
            await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 2 }); 
        } catch (e) { console.log("Leverage Note:", e.message); }

        console.log(`SUCCESS: Pro-Sniper Bot Active on ${symbol}`);
        
        // Check every 10 seconds
        setInterval(runBot, 10000); 
    } catch (error) {
        console.error("STARTUP ERROR:", error.message);
    }
}

startBot();
