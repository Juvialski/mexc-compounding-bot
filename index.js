const ccxt = require('ccxt');
const express = require('express');

const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Multi-Sniper: Isolated Mode Forced'));
app.listen(port);

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' }
});

const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskFactor = 0.10; // Each snipe uses 10% of balance
const trailPercent = 0.005; 
const obiThreshold = 0.70; 

let isPositionOpen = false;
let highestPriceSeen = 0;
let contractSize = 0.0001; 

async function runBot() {
    try {
        // 1. SYNC & AGGREGATE: Check actual position size on MEXC
        const positions = await mexc.fetchPositions([symbol]);
        const activePos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0);
        
        if (!activePos) {
            if (isPositionOpen) console.log("NOTICE: Position cleared. Resetting.");
            isPositionOpen = false;
            highestPriceSeen = 0;
        } else {
            isPositionOpen = true;
            // Update highest price for the trailing stop of the entire bag
            const currentPrice = (await mexc.fetchTicker(symbol)).last;
            if (currentPrice > highestPriceSeen) highestPriceSeen = currentPrice;
        }

        const balance = await mexc.fetchBalance();
        const usdtBalance = balance.total['USDT'] || 0;
        const ticker = await mexc.fetchTicker(symbol);
        const currentPrice = ticker.last;
        
        const orderbook = await mexc.fetchOrderBook(symbol, 10);
        const sumBids = orderbook.bids.reduce((a, b) => a + b[1], 0);
        const sumAsks = orderbook.asks.reduce((a, b) => a + b[1], 0);
        const imbalance = (sumBids - sumAsks) / (sumBids + sumAsks);

        console.log(`[LOG] Price: ${currentPrice} | OBI: ${imbalance.toFixed(2)} | Bal: $${usdtBalance.toFixed(2)} | Position: ${isPositionOpen ? activePos.contracts : 0} contracts`);

        // 2. TRAILING STOP (Manages the total position)
        if (isPositionOpen && activePos) {
            const stopLossPrice = highestPriceSeen * (1 - trailPercent);
            if (currentPrice <= stopLossPrice) {
                console.log(`>>> EXITING TOTAL POSITION (${activePos.contracts} contracts) at ${currentPrice} <<<`);
                // Force Isolated (openType: 1) on exit
                await mexc.createLimitSellOrder(symbol, activePos.contracts, currentPrice, { 'openType': 1 });
                isPositionOpen = false;
                return; 
            }
        }

        // 3. MULTI-SNIPE LOGIC (Can run even if position is open)
        if (imbalance > obiThreshold) {
            const buyingPower = usdtBalance * riskFactor * leverage;
            const contractsToBuy = Math.floor((buyingPower / currentPrice) / contractSize);

            if (contractsToBuy >= 1) {
                console.log(`>>> ADDING/OPENING SNIPE: ${contractsToBuy} contracts at ${currentPrice} <<<`);
                
                // HARD FORCE ISOLATED: 'openType': 1 forces Isolated mode regardless of account defaults
                await mexc.createLimitBuyOrder(symbol, contractsToBuy, currentPrice, { 'openType': 1 });
                
                if (!isPositionOpen) highestPriceSeen = currentPrice;
                isPositionOpen = true;
            }
        }
    } catch (e) {
        console.error("Loop Error:", e.message);
    }
}

async function startBot() {
    try {
        const markets = await mexc.loadMarkets();
        contractSize = markets[symbol].contractSize;
        
        // Initial setup for Isolated mode
        try {
            await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 1 });
        } catch (e) { console.log("Leverage Setup Note:", e.message); }

        console.log(`SUCCESS: Multi-Sniper Synced. Force-Isolated Active.`);
        setInterval(runBot, 10000); 
    } catch (error) {
        console.error("STARTUP ERROR:", error.message);
    }
}

startBot();
