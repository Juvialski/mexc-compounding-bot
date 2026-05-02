const ccxt = require('ccxt');
const express = require('express');
const { ATR, SMA } = require('technicalindicators');

// 1. KEEP-ALIVE SERVER
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('BTC Sniper Bot is LIVE and Compounding!'));
app.listen(port, () => console.log(`Monitor active on port ${port}`));

// 2. MEXC CONNECTION
const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' }
});

// 3. BOT SETTINGS
const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskFactor = 0.10;        
const trailPercent = 0.005;     
const obiThreshold = 0.70;      

let isPositionOpen = false;
let entryPrice = 0;
let highestPriceSeen = 0;
let currentQty = 0;

async function runBot() {
    try {
        const balance = await mexc.fetchBalance();
        const usdtBalance = balance.total['USDT'] || 0;

        const ticker = await mexc.fetchTicker(symbol);
        const currentPrice = ticker.last;
        
        const orderbook = await mexc.fetchOrderBook(symbol, 10);
        const sumBids = orderbook.bids.reduce((a, b) => a + b[1], 0);
        const sumAsks = orderbook.asks.reduce((a, b) => a + b[1], 0);
        const imbalance = (sumBids - sumAsks) / (sumBids + sumAsks);

        console.log(`[LOG] Price: ${currentPrice} | OBI: ${imbalance.toFixed(2)} | Balance: $${usdtBalance.toFixed(2)}`);

        // TRAILING STOP LOGIC
        if (isPositionOpen) {
            if (currentPrice > highestPriceSeen) {
                highestPriceSeen = currentPrice;
            }

            const stopLossPrice = highestPriceSeen * (1 - trailPercent);

            if (currentPrice <= stopLossPrice) {
                console.log(`>>> CLOSING POSITION at ${currentPrice} (Trailing Stop Triggered) <<<`);
                
                await mexc.createLimitSellOrder(symbol, currentQty, currentPrice);
                
                isPositionOpen = false;
                highestPriceSeen = 0;
                currentQty = 0;
            }
            return; 
        }

        // COMPOUNDING SNIPE LOGIC
        if (!isPositionOpen && imbalance > obiThreshold) {
            const positionValue = usdtBalance * riskFactor * leverage;
            const btcQty = (positionValue / currentPrice).toFixed(3);

            console.log(`>>> SNIPING LONG: ${btcQty} BTC at ${currentPrice} <<<`);
            
            await mexc.createLimitBuyOrder(symbol, btcQty, currentPrice);
            
            entryPrice = currentPrice;
            highestPriceSeen = currentPrice;
            currentQty = btcQty;
            isPositionOpen = true;
        }

    } catch (e) {
        console.error("Loop Error:", e.message);
    }
}

// 4. STARTUP SEQUENCE
console.log("Initializing Bot for LIVE Trading...");
mexc.setLeverage(leverage, symbol)
    .then(() => {
        console.log(`SUCCESS: Leverage set to ${leverage}x. Starting Sniper Loop...`);
        setInterval(runBot, 10000); 
    })
    .catch((error) => {
        console.error("FATAL STARTUP ERROR");
        console.error("REASON:", error.message);
    });
