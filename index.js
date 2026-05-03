const ccxt = require('ccxt');
const express = require('express');

const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Multi-Sniper: Isolated Leverage Fixed'));
app.listen(port);

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' }
});

const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskFactor = 0.10; 
const trailPercent = 0.005; 
const obiThreshold = 0.70; 

let isPositionOpen = false;
let highestPriceSeen = 0;
let contractSize = 0.0001; 

async function runBot() {
    try {
        const positions = await mexc.fetchPositions([symbol]);
        const activePos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0);
        
        const ticker = await mexc.fetchTicker(symbol);
        const currentPrice = ticker.last;

        if (!activePos) {
            if (isPositionOpen) console.log("NOTICE: Position cleared. Resetting.");
            isPositionOpen = false;
            highestPriceSeen = 0;
        } else {
            isPositionOpen = true;
            if (currentPrice > highestPriceSeen) highestPriceSeen = currentPrice;
        }

        const balance = await mexc.fetchBalance();
        const usdtBalance = balance.total['USDT'] || 0;
        
        const orderbook = await mexc.fetchOrderBook(symbol, 10);
        const sumBids = orderbook.bids.reduce((a, b) => a + b[1], 0);
        const sumAsks = orderbook.asks.reduce((a, b) => a + b[1], 0);
        const imbalance = (sumBids - sumAsks) / (sumBids + sumAsks);

        console.log(`[LOG] Price: ${currentPrice} | OBI: ${imbalance.toFixed(2)} | Bal: $${usdtBalance.toFixed(2)} | Position: ${isPositionOpen ? activePos.contracts : 0} contracts`);

        if (isPositionOpen && activePos) {
            const stopLossPrice = highestPriceSeen * (1 - trailPercent);
            if (currentPrice <= stopLossPrice) {
                console.log(`>>> EXITING TOTAL POSITION (${activePos.contracts} contracts) at ${currentPrice} <<<`);
                // Added leverage parameter to exit order
                await mexc.createLimitSellOrder(symbol, activePos.contracts, currentPrice, { 
                    'openType': 1, 
                    'leverage': leverage 
                });
                isPositionOpen = false;
                return; 
            }
        }

        if (imbalance > obiThreshold) {
            const buyingPower = usdtBalance * riskFactor * leverage;
            const contractsToBuy = Math.floor((buyingPower / currentPrice) / contractSize);

            if (contractsToBuy >= 1) {
                console.log(`>>> ADDING/OPENING SNIPE: ${contractsToBuy} contracts at ${currentPrice} <<<`);
                // Added leverage parameter to entry order
                await mexc.createLimitBuyOrder(symbol, contractsToBuy, currentPrice, { 
                    'openType': 1, 
                    'leverage': leverage 
                });
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
        
        try {
            await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 1 });
        } catch (e) { console.log("Leverage Setup Note:", e.message); }

        console.log(`SUCCESS: Multi-Sniper Fixed. Forced Isolated Leverage Active.`);
        setInterval(runBot, 10000); 
    } catch (error) {
        console.error("STARTUP ERROR:", error.message);
    }
}

startBot();
