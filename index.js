const ccxt = require('ccxt');
const express = require('express');
const { RSI, SMA, ATR, ADX, OBV } = require('technicalindicators');

const app = express();
const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Elite Sniper: Full Power Mode'));
app.listen(port);

const mexc = new ccxt.mexc({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    options: { 'defaultType': 'swap' }
});

const symbol = 'BTC/USDT:USDT'; 
const leverage = 10;
const riskFactor = 0.95; // Using 95% to account for fees and slippage
const obiThreshold = 0.70; 
const historyLimit = 5;         
let obiHistory = [];
let isTrading = false;
let peakPrice = 0; 

async function getMarketContext() {
    const ohlcv1h = await mexc.fetchOHLCV(symbol, '1h', undefined, 50);
    const ohlcv15m = await mexc.fetchOHLCV(symbol, '15m', undefined, 50);
    const closes1h = ohlcv1h.map(c => c[4]);
    const closes15m = ohlcv15m.map(c => c[4]);
    const highs15m = ohlcv15m.map(c => c[2]);
    const lows15m = ohlcv15m.map(c => c[3]);
    const volumes15m = ohlcv15m.map(c => c[5]);

    const smaValue = SMA.calculate({ period: 20, values: closes1h }).pop();
    const currentPrice = closes15m[closes15m.length - 1];
    const trend = currentPrice > smaValue ? 'BULLISH' : 'BEARISH';
    const adxData = ADX.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 }).pop();
    const trendStrength = adxData ? adxData.adx : 0;
    const rsiValue = RSI.calculate({ period: 14, values: closes15m }).pop();
    const obvValues = OBV.calculate({ close: closes15m, volume: volumes15m });
    const currentObv = obvValues[obvValues.length - 1];
    const prevObv = obvValues[obvValues.length - 4];
    const isVolumeConfirming = trend === 'BULLISH' ? currentObv > prevObv : currentObv < prevObv;
    const atrValue = ATR.calculate({ period: 14, high: highs15m, low: lows15m, close: closes15m }).pop();

    return { trend, trendStrength, rsi: rsiValue, atr: atrValue, isVolumeConfirming, currentPrice };
}

async function runBot() {
    if (isTrading) return; 
    isTrading = true;

    try {
        const ctx = await getMarketContext();
        const balance = await mexc.fetchBalance();
        const usdtBalance = balance.total['USDT'] || 0;

        const positions = await mexc.fetchPositions([symbol]);
        const longPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'long');
        const shortPos = positions.find(p => p.symbol === symbol && parseFloat(p.contracts) > 0 && p.side === 'short');

        const orderbook = await mexc.fetchOrderBook(symbol, 10);
        const sumBids = orderbook.bids.reduce((a, b) => a + b[1], 0);
        const sumAsks = orderbook.asks.reduce((a, b) => a + b[1], 0);
        const currentObi = (sumBids - sumAsks) / (sumBids + sumAsks);
        obiHistory.push(currentObi);
        if (obiHistory.length > historyLimit) obiHistory.shift();
        const avgObi = obiHistory.reduce((a, b) => a + b, 0) / obiHistory.length;

        console.log(`[LOG] Price: ${ctx.currentPrice} | Bal: $${usdtBalance.toFixed(2)} | RSI: ${ctx.rsi.toFixed(1)} | Pos: ${longPos ? 'LONG' : shortPos ? 'SHORT' : 'NONE'}`);

        if (longPos) {
            const entryPrice = parseFloat(longPos.entryPrice);
            if (peakPrice === 0 || ctx.currentPrice > peakPrice) peakPrice = ctx.currentPrice;

            let stopLoss = entryPrice - (ctx.atr * 2);
            if (ctx.currentPrice > entryPrice + (ctx.atr * 1.5)) stopLoss = Math.max(stopLoss, entryPrice);
            
            const trailingStop = peakPrice * 0.985;
            stopLoss = Math.max(stopLoss, trailingStop);

            if (ctx.currentPrice < stopLoss || ctx.rsi > 85) {
                console.log(`>>> FULL EXIT LONG. Price: ${ctx.currentPrice} | Final SL: ${stopLoss.toFixed(2)}`);
                await mexc.createMarketSellOrder(symbol, longPos.contracts, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                peakPrice = 0;
            }
        }

        if (shortPos) {
            const entryPrice = parseFloat(shortPos.entryPrice);
            if (peakPrice === 0 || ctx.currentPrice < peakPrice) peakPrice = ctx.currentPrice;

            let stopLoss = entryPrice + (ctx.atr * 2);
            if (ctx.currentPrice < entryPrice - (ctx.atr * 1.5)) stopLoss = Math.min(stopLoss, entryPrice);
            
            const trailingStop = peakPrice * 1.015;
            stopLoss = Math.min(stopLoss, trailingStop);

            if (ctx.currentPrice > stopLoss || ctx.rsi < 15) {
                console.log(`>>> FULL EXIT SHORT. Price: ${ctx.currentPrice} | Final SL: ${stopLoss.toFixed(2)}`);
                await mexc.createMarketBuyOrder(symbol, shortPos.contracts, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                peakPrice = 0;
            }
        }

        const market = await mexc.market(symbol);
        const contractSize = market.contractSize; 
        const btcToTrade = (usdtBalance * riskFactor * leverage) / ctx.currentPrice;
        let contractsToTrade = Math.floor(btcToTrade / contractSize);

        if (contractsToTrade >= 1 && !longPos && !shortPos && usdtBalance > 5) {
            if (ctx.trend === 'BULLISH' && ctx.trendStrength > 25 && ctx.isVolumeConfirming && avgObi > obiThreshold && ctx.rsi < 65) {
                console.log(`>>> FULL POWER LONG: ${contractsToTrade} Contracts`);
                await mexc.createMarketBuyOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 1, 'leverage': leverage });
                obiHistory = [];
                peakPrice = ctx.currentPrice; 
            } 
            else if (ctx.trend === 'BEARISH' && ctx.trendStrength > 25 && ctx.isVolumeConfirming && avgObi < -obiThreshold && ctx.rsi > 35) {
                console.log(`>>> FULL POWER SHORT: ${contractsToTrade} Contracts`);
                await mexc.createMarketSellOrder(symbol, contractsToTrade, { 'openType': 1, 'positionType': 2, 'leverage': leverage });
                obiHistory = [];
                peakPrice = ctx.currentPrice;
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
        await mexc.loadMarkets();
        try { 
            await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 1 }); 
            await mexc.setLeverage(leverage, symbol, { 'openType': 1, 'positionType': 2 }); 
        } catch (e) {}
        console.log(`SUCCESS: FULL BALANCE BOT ACTIVE ON ${symbol}`);
        setInterval(runBot, 10000); 
    } catch (error) {
        console.error("STARTUP ERROR:", error.message);
    }
}
startBot();
