const ccxt = require('ccxt');
const express = require('express');

// 1. KEEP-ALIVE SERVER
const app = express();
app.get('/', (req, res) => res.send('Compounding Sniper Active'));
app.listen(process.env.PORT || 3000);

// 2. MEXC CONNECTION
const mexc = new ccxt.mexc({
    apiKey: 'YOUR_API_KEY',
    secret: 'YOUR_SECRET_KEY',
    options: { 'defaultType': 'swap' }
});

// 3. SETTINGS
const symbol = 'BTC/USDT:USDT';
const leverage = 10;
const riskFactor = 0.10;      // Use 10% of balance per trade
const trailPercent = 0.005;   // 0.5% Trailing Stop
const obiThreshold = 0.70;    // Require strong pressure to snipe

let isPositionOpen = false;
let entryPrice = 0;
let highestPriceSeen = 0;

async function runBot() {
    try {
        // A. Fetch current wallet balance for compounding
        const balanceInfo = await mexc.fetchBalance();
        const usdtBalance = balanceInfo.total['USDT'];

        const ticker = await mexc.fetchTicker(symbol);
        const currentPrice = ticker.last;

        const orderbook = await mexc.fetchOrderBook(symbol, 10);
        const sumBids = orderbook.bids.reduce((a, b) => a + b[1], 0);
        const sumAsks = orderbook.asks.reduce((a, b) => a + b[1], 0);
        const imbalance = (sumBids - sumAsks) / (sumBids + sumAsks);

        // B. TRAILING STOP LOGIC
        if (isPositionOpen) {
            if (currentPrice > highestPriceSeen) highestPriceSeen = currentPrice;
            const stopLossPrice = highestPriceSeen * (1 - trailPercent);

            if (currentPrice <= stopLossPrice) {
                console.log(`Closing Trade. Profit/Loss: ${((currentPrice/entryPrice - 1)*100*leverage).toFixed(2)}%`);
                // await mexc.createLimitSellOrder(symbol, qty, currentPrice);
                isPositionOpen = false;
                return;
            }
        }

        // C. COMPOUNDING SNIPE LOGIC
        if (!isPositionOpen && Math.abs(imbalance) > obiThreshold) {
            // Calculate compounding quantity
            const positionSizeUsdt = usdtBalance * riskFactor * leverage;
            const btcQty = (positionSizeUsdt / currentPrice).toFixed(3);

            if (imbalance > obiThreshold) {
                console.log(`Sniping LONG with ${btcQty} BTC (Compounded)`);
                // await mexc.createLimitBuyOrder(symbol, btcQty, currentPrice);
                entryPrice = currentPrice;
                highestPriceSeen = currentPrice;
                isPositionOpen = true;
            }
        }

    } catch (e) {
        console.log("Error:", e.message);
    }
}

// Start sequence
mexc.setLeverage(leverage, symbol).then(() => {
    setInterval(runBot, 10000); // Check every 10 seconds
});
