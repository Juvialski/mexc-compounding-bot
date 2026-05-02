const ccxt = require('ccxt');
const express = require('express');
const { ATR, SMA } = require('technicalindicators');

// --- 1. KEEP-ALIVE SERVER ---
// This prevents Render from putting the bot to sleep
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('BTC Sniper Bot is Active and Compounding!'));
app.listen(port, () => console.log(`Monitor active on port ${port}`));

// --- 2. MEXC CONNECTION ---
// Pulls keys securely from Render Environment Variables
const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' } // Essential for Futures
});

// --- 3. BOT SETTINGS ---
const symbol = 'BTC/USDT:USDT'; // MEXC Futures format
const leverage = 10;
const riskFactor = 0.10;        // Uses 10% of your total balance per trade
const trailPercent = 0.005;     // 0.5% Trailing Stop
const obiThreshold = 0.70;      // 70% Order Book Imbalance required to snipe

// State Tracking
let isPositionOpen = false;
let entryPrice = 0;
let highestPriceSeen = 0;
let currentQty = 0;

async function runBot() {
    try {
        // A. Check Account Balance for Compounding
        const balance = await mexc.fetchBalance();
        const usdtBalance = balance.total['USDT'] || 0;

        // B. Get Market Data
        const ticker = await mexc.fetchTicker(symbol);
        const currentPrice = ticker.last;
        
        const orderbook = await mexc.fetchOrderBook(symbol, 10);
        const sumBids = orderbook.bids.reduce((a, b) => a + b[1], 0);
        const sumAsks = orderbook.asks.reduce((a, b) => a + b[1], 0);
        const imbalance = (sumBids - sumAsks) / (sumBids + sumAsks);

        console.log(`[LOG] Price: ${currentPrice} | OBI: ${imbalance.toFixed(2)} | Balance: $${usdtBalance.toFixed(2)}`);

        // C. TRAILING STOP LOGIC
        if (isPositionOpen) {
            if (currentPrice > highestPriceSeen) {
                highestPriceSeen = currentPrice;
            }

            const stopLossPrice = highestPriceSeen * (1 - trailPercent);

            if (currentPrice <= stopLossPrice) {
                console.log(`>>> CLOSING POSITION at ${currentPrice} (Trailing Stop Triggered) <<<`);
                
                // UNCOMMENT THE LINE BELOW TO START REAL TRADING
                // await mexc.createLimitSellOrder(symbol, currentQty, currentPrice);
                
                isPositionOpen = false;
                highestPriceSeen = 0;
                currentQty = 0;
            }
            return; // Don't look for new trades while one is open
        }

        // D. COMPOUNDING SNIPE LOGIC
        if (!isPositionOpen && imbalance > obiThreshold) {
            // Calculate BTC quantity based on 10% risk and 10x leverage
            const positionValue = usdtBalance * riskFactor * leverage;
            const btcQty = (positionValue / currentPrice).toFixed(3);

            console.log(`>>> SNIPING LONG: ${btcQty} BTC at ${currentPrice} <<<`);
            
            // UNCOMMENT THE LINE BELOW TO START REAL TRADING
            // await mexc.createLimitBuyOrder(symbol, btcQty, currentPrice);
            
            entryPrice = currentPrice;
            highestPriceSeen = currentPrice;
            currentQty = btcQty;
            isPositionOpen = true;
        }

    } catch (e) {
        console.error("Loop Error:", e.message);
    }
}

// --- 4. STARTUP SEQUENCE ---
console.log("Initializing Bot...");
mexc.setLeverage(leverage, symbol)
    .then(() => {
        console.log(`SUCCESS: Leverage set to ${leverage}x. Starting Sniper Loop...`);
        setInterval(runBot, 10000); // Runs every 10 seconds
    })
    .catch((error) => {
        console.error("!!! FATAL STARTUP ERROR !!!");
        console.error("REASON:", error.message);
        console.error("Check: API keys, Futures account activation, or symbol format.");
    });
