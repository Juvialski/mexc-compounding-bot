const ccxt = require('ccxt');
const express = require('express');

const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Multi-Sniper: Dual Direction (Long/Short) Pattern Mode'));
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

const historyLimit = 6; 
let obiHistory = [];    

let isLongOpen = false;
let highestPriceSeen = 0;

let isShortOpen = false;
let lowestPriceSeen = Infinity;

let contractSize = 0.0001; 

async function runBot() {
    try {
        const positions = await mexc.fetchPositions([symbol]);
        
        const longPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'long');
        const shortPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'short');
        
        const ticker = await mexc.fetchTicker(symbol);
        const currentPrice = ticker.last;

        if (!longPos) {
            isLongOpen = false;
            highestPriceSeen = 0;
        } else {
            isLongOpen = true;
            if (currentPrice > highestPriceSeen) highestPriceSeen = currentPrice;
        }

        if (!shortPos) {
            isShortOpen = false;
            lowestPriceSeen = Infinity;
        } else {
            isShortOpen = true;
            if (currentPrice < lowestPriceSeen) lowestPriceSeen = currentPrice;
        }

        const balance = await mexc.fetchBalance();
        const usdtBalance = balance.total['USDT'] || 0;
        
        const orderbook = await mexc.fetchOrderBook(symbol, 10);
        const sumBids = orderbook.bids.reduce((a, b) => a + b[1], 0);
        const sumAsks = orderbook.asks.reduce((a, b) => a + b[1], 0);
        const currentObi = (sumBids - sumAsks) / (sumBids + sumAsks);

        obiHistory.push(currentObi);
        if (obiHistory.length > historyLimit) obiHistory.shift();
        
        const avgObi = obiHistory.reduce((a, b) => a + b, 0) / obiHistory.length;

        console.log(`[LOG] Price: ${currentPrice} | Avg OBI: ${avgObi.toFixed(2)} | Bal: $${usdtBalance.toFixed(2)} | Longs: ${longPos ? longPos.contracts : 0} | Shorts: ${shortPos ? shortPos.contracts : 0}`);

        if (isLongOpen && longPos) {
            const stopLossLong = highestPriceSeen * (1 - trailPercent);
            if (currentPrice <= stopLossLong) {
                console.log(`>>> EXITING LONG: Price hit Trailing Stop at ${currentPrice} <<<`);
                await mexc.createLimitSellOrder(symbol, longPos.contracts, currentPrice, { 
                    'openType': 1, 
                    'leverage': leverage,
                    'positionType': 1 
                });
                isLongOpen = false;
            }
        }

        if (isShortOpen && shortPos) {
            const stopLossShort = lowestPriceSeen * (1 + trailPercent);
            if (currentPrice >= stopLossShort) {
                console.log(`>>> EXITING SHORT: Price hit Trailing Stop at ${currentPrice} <<<`);
                await mexc.createLimitBuyOrder(symbol, shortPos.contracts, currentPrice, { 
                    'openType': 1, 
                    'leverage': leverage,
                    'positionType': 2 
                });
                isShortOpen = false;
            }
        }

        const buyingPower = usdtBalance * riskFactor * leverage;
        const contractsToTrade = Math.floor((buyingPower / currentPrice) / contractSize);

        if (obiHistory.length >= historyLimit && contractsToTrade >= 1) {
            
            if (avgObi > obiThreshold) {
                console.log(`>>> PATTERN CONFIRMED: Sniping LONG ${contractsToTrade} contracts <<<`);
                await mexc.createLimitBuyOrder(symbol, contractsToTrade, currentPrice, { 
                    'openType': 1, 
                    'leverage': leverage,
                    'positionType': 1 
                });
                if (!isLongOpen) highestPriceSeen = currentPrice;
                isLongOpen = true;
                obiHistory = []; 
            } 
            
            else if (avgObi < -obiThreshold) {
                console.log(`>>> PATTERN CONFIRMED: Sniping SHORT ${contractsToTrade} contracts <<<`);
                await mexc.createLimitSellOrder(symbol, contractsToTrade, currentPrice, { 
                    'openType': 1, 
                    'leverage': leverage,
                    'positionType': 2 
                });
                if (!isShortOpen) lowestPriceSeen = currentPrice;
                isShortOpen = true;
                obiHistory = []; 
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
            await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 2 }); 
        } catch (e) { console.log("Leverage Setup Note:", e.message); }

        console.log(`SUCCESS: Dual-Direction (Long/Short) Pattern Sniper Active.`);
        setInterval(runBot, 10000); 
    } catch (error) {
        console.error("STARTUP ERROR:", error.message);
    }
}

startBot();
