const ccxt = require('ccxt');
const express = require('express');

// --- 1. KEEP-ALIVE SERVER ---
const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('BTC Sniper Bot is LIVE!'));
app.listen(port, () => console.log(`Monitor active on port ${port}`));

// --- 2. MEXC CONNECTION ---
const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' }
});

// --- 3. BOT SETTINGS ---
const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskFactor = 0.10;        
const trailPercent = 0.005;     
const obiThreshold = 0.70;      

let isPositionOpen = false;
let highestPriceSeen = 0;
let currentContracts = 0; // Changed from BTC qty to Contracts
let contractSize = 0.0001; // Default for MEXC BTC, updated on start

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

        if (isPositionOpen) {
            if (currentPrice > highestPriceSeen) highestPriceSeen = currentPrice;
            const stopLossPrice = highestPriceSeen * (1 - trailPercent);

            if (currentPrice <= stopLossPrice) {
                console.log(`>>> CLOSING ${currentContracts} CONTRACTS at ${currentPrice} (Trailing Stop) <<<`);
                await mexc.createLimitSellOrder(symbol, currentContracts, currentPrice);
                isPositionOpen = false;
                highestPriceSeen = 0;
                currentContracts = 0;
            }
            return; 
        }

        if (!isPositionOpen && imbalance > obiThreshold) {
            // 1. Calculate buying power in USDT
            const buyingPower = usdtBalance * riskFactor * leverage;
            // 2. Calculate raw BTC amount
            const targetBtc = buyingPower / currentPrice;
            // 3. Convert BTC to whole Contracts (e.g., 0.0012 BTC / 0.0001 = 12 contracts)
            const contracts = Math.floor(targetBtc / contractSize);

            if (contracts < 1) {
                console.log("[SKIP] Position size too small for minimum 1 contract.");
                return;
            }

            console.log(`>>> SNIPING LONG: ${contracts} contracts (~${(contracts * contractSize).toFixed(4)} BTC) at ${currentPrice} <<<`);
            
            await mexc.createLimitBuyOrder(symbol, contracts, currentPrice);
            
            highestPriceSeen = currentPrice;
            currentContracts = contracts;
            isPositionOpen = true;
        }

    } catch (e) {
        console.error("Loop Error:", e.message);
    }
}

// --- 4. STARTUP SEQUENCE ---
async function startBot() {
    try {
        console.log("Initializing Markets and Leverage...");
        const markets = await mexc.loadMarkets();
        
        // Dynamically get the contract size from the exchange
        if (markets[symbol]) {
            contractSize = markets[symbol].contractSize;
            console.log(`Market Loaded: 1 Contract = ${contractSize} BTC`);
        }

        await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 1 }); 
        await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 2 });
        
        console.log(`SUCCESS: Setup Complete. Starting Sniper Loop...`);
        setInterval(runBot, 10000); 
    } catch (error) {
        console.error("!!! FATAL STARTUP ERROR !!!", error.message);
    }
}

startBot();
