const ccxt = require('ccxt');
const express = require('express');

const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Sniper Bot: Active Sync Mode'));
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
let currentContracts = 0;
let contractSize = 0.0001; 

async function runBot() {
    try {
        // 1. SYNC: Check actual position status on MEXC every loop
        const positions = await mexc.fetchPositions([symbol]);
        const activePos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0);
        
        if (!activePos && isPositionOpen) {
            console.log("NOTICE: Position closed on exchange. Resetting bot state.");
            isPositionOpen = false;
            highestPriceSeen = 0;
            currentContracts = 0;
        }

        const balance = await mexc.fetchBalance();
        const usdtBalance = balance.total['USDT'] || 0;
        const ticker = await mexc.fetchTicker(symbol);
        const currentPrice = ticker.last;
        
        const orderbook = await mexc.fetchOrderBook(symbol, 10);
        const sumBids = orderbook.bids.reduce((a, b) => a + b[1], 0);
        const sumAsks = orderbook.asks.reduce((a, b) => a + b[1], 0);
        const imbalance = (sumBids - sumAsks) / (sumBids + sumAsks);

        console.log(`[LOG] Price: ${currentPrice} | OBI: ${imbalance.toFixed(2)} | Bal: $${usdtBalance.toFixed(2)} | Open: ${isPositionOpen}`);

        // 2. MANAGE POSITION
        if (isPositionOpen && activePos) {
            if (currentPrice > highestPriceSeen) highestPriceSeen = currentPrice;
            const stopLossPrice = highestPriceSeen * (1 - trailPercent);

            if (currentPrice <= stopLossPrice) {
                console.log(`>>> TRIGGERING EXIT at ${currentPrice} <<<`);
                await mexc.createLimitSellOrder(symbol, activePos.contracts, currentPrice);
                isPositionOpen = false;
            }
            return; 
        }

        // 3. SNIPE
        if (!isPositionOpen && imbalance > obiThreshold) {
            const buyingPower = usdtBalance * riskFactor * leverage;
            const contracts = Math.floor((buyingPower / currentPrice) / contractSize);

            if (contracts >= 1) {
                console.log(`>>> SNIPING LONG: ${contracts} contracts at ${currentPrice} <<<`);
                await mexc.createLimitBuyOrder(symbol, contracts, currentPrice);
                isPositionOpen = true;
                highestPriceSeen = currentPrice;
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
        
        // Try to set leverage, but don't crash if margin mode fails
        try {
            await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 1 });
        } catch (mErr) {
            console.log("Margin/Leverage Note:", mErr.message);
        }

        console.log(`SUCCESS: Bot Synced. 1 Contract = ${contractSize} BTC.`);
        setInterval(runBot, 10000); 
    } catch (error) {
        console.error("STARTUP ERROR:", error.message);
    }
}

startBot();
