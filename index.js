const ccxt = require('ccxt');
const express = require('express');

// --- 1. KEEP-ALIVE SERVER ---
const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Sniper Bot: Operational'));
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
const riskFactor = 0.10; // Uses 10% of balance per trade
const trailPercent = 0.005; 
const obiThreshold = 0.70; 

let isPositionOpen = false;
let highestPriceSeen = 0;
let currentContracts = 0;
let contractSize = 0.0001; 

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

        console.log(`[LOG] Price: ${currentPrice} | OBI: ${imbalance.toFixed(2)} | Balance: $${usdtBalance.toFixed(2)} | Open: ${isPositionOpen}`);

        // --- POSITION MANAGEMENT ---
        if (isPositionOpen) {
            if (currentPrice > highestPriceSeen) highestPriceSeen = currentPrice;
            const stopLossPrice = highestPriceSeen * (1 - trailPercent);

            if (currentPrice <= stopLossPrice) {
                console.log(`>>> CLOSING ${currentContracts} CONTRACTS at ${currentPrice} <<<`);
                await mexc.createLimitSellOrder(symbol, currentContracts, currentPrice);
                isPositionOpen = false;
                highestPriceSeen = 0;
            }
            return; 
        }

        // --- SNIPE DECISION ---
        if (imbalance > obiThreshold) {
            const buyingPower = usdtBalance * riskFactor * leverage;
            const contracts = Math.floor((buyingPower / currentPrice) / contractSize);

            if (contracts >= 1) {
                console.log(`>>> SNIPING LONG: ${contracts} contracts at ${currentPrice} <<<`);
                await mexc.createLimitBuyOrder(symbol, contracts, currentPrice);
                highestPriceSeen = currentPrice;
                currentContracts = contracts;
                isPositionOpen = true;
            }
        }
    } catch (e) {
        console.error("Loop Error:", e.message);
    }
}

// --- 4. STARTUP & RECOVERY ---
async function startBot() {
    try {
        const markets = await mexc.loadMarkets();
        contractSize = markets[symbol].contractSize;

        await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 1 });
        
        // RECOVERY: Check if we already have a position open on MEXC
        const positions = await mexc.fetchPositions([symbol]);
        const myPosition = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0);
        
        if (myPosition) {
            console.log(`RECOVERY: Found open position of ${myPosition.contracts} contracts.`);
            isPositionOpen = true;
            currentContracts = parseFloat(myPosition.contracts);
            highestPriceSeen = parseFloat(myPosition.entryPrice);
        }

        console.log(`SUCCESS: Setup Complete. 1 Contract = ${contractSize} BTC.`);
        setInterval(runBot, 10000); 
    } catch (error) {
        console.error("STARTUP ERROR:", error.message);
    }
}

startBot();
