import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";
import { SMA, EMA, RSI, MACD } from "technicalindicators";

const firebaseConfig = {
    apiKey: "AIzaSyC7bIZOsDhg0iXGrm6aBD3c37AD3ZkUmTE",
    authDomain: "advisoracciones.firebaseapp.com",
    projectId: "advisoracciones",
    storageBucket: "advisoracciones.firebasestorage.app",
    messagingSenderId: "454193425218",
    appId: "1:454193425218:web:54b7136d042ecd951876db",
    measurementId: "G-7KQ8CF2SXJ"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const API_KEY = process.env.API_KEY;

if (!API_KEY) {
    console.error("API_KEY environment variable is not defined");
    process.exit(1);
}

const FRED_API_KEY = process.env.FRED_API_KEY;
if (!FRED_API_KEY) {
    console.warn("FRED_API_KEY environment variable is not defined. Macro data will be skipped.");
}

const activeStocks = [
    { symbol: 'AAPL', name: 'Apple Inc.' },
    { symbol: 'MSFT', name: 'Microsoft Corp.' },
    { symbol: 'GOOGL', name: 'Alphabet Inc.' },
    { symbol: 'AMZN', name: 'Amazon.com' },
    { symbol: 'TSLA', name: 'Tesla Inc.' },
    { symbol: 'NVDA', name: 'NVIDIA Corp.' },
    { symbol: 'META', name: 'Meta Platforms' },
    { symbol: 'NFLX', name: 'Netflix Inc.' },
    { symbol: 'JPM', name: 'JPMorgan Chase' },
    { symbol: 'V', name: 'Visa Inc.' },
    { symbol: 'KO', name: 'Coca-Cola' },
    { symbol: 'PEP', name: 'PepsiCo' },
    { symbol: 'WMT', name: 'Walmart' },
    { symbol: 'MCD', name: 'McDonald\'s' },
    { symbol: 'NKE', name: 'Nike' },
    { symbol: 'XOM', name: 'Exxon Mobil' },
    { symbol: 'CVX', name: 'Chevron' },
    { symbol: 'JNJ', name: 'Johnson & Johnson' },
    { symbol: 'PFE', name: 'Pfizer' },
    { symbol: 'AMD', name: 'AMD' },
    { symbol: 'INTC', name: 'Intel' },
    { symbol: 'DIS', name: 'Disney' }
];

const staticFundamentals = {
    'AAPL': { peRatio: 34.66, eps: 7.91 },
    'MSFT': { peRatio: 26.06, eps: 15.99 },
    'GOOGL': { peRatio: 29.73, eps: 10.91 },
    'AMZN': { peRatio: 28.85, eps: 7.29 },
    'TSLA': { peRatio: 386.41, eps: 1.08 },
    'NVDA': { peRatio: 46.01, eps: 4.03 },
    'META': { peRatio: 28.15, eps: 23.50 },
    'NFLX': { peRatio: 32.24, eps: 2.53 },
    'JPM': { peRatio: 16.12, eps: 20.01 },
    'V': { peRatio: 30.54, eps: 10.65 },
    'MA': { peRatio: 34.16, eps: 15.67 },
    'BAC': { peRatio: 14.76, eps: 3.83 },
    'KO': { peRatio: 26.08, eps: 3.03 },
    'PEP': { peRatio: 32.35, eps: 5.27 },
    'WMT': { peRatio: 44.95, eps: 2.87 },
    'MCD': { peRatio: 27.91, eps: 11.72 },
    'NKE': { peRatio: 37.60, eps: 1.70 },
    'XOM': { peRatio: 22.28, eps: 6.69 },
    'CVX': { peRatio: 27.16, eps: 6.66 },
    'JNJ': { peRatio: 21.72, eps: 11.05 },
    'PFE': { peRatio: 15.83, eps: 1.72 },
    'AMD': { peRatio: 81.51, eps: 2.65 },
    'INTC': { peRatio: 'N/A', eps: -0.27 },
    'DIS': { peRatio: 15.96, eps: 6.81 }
};

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchBuffettIndicator() {
    if (!FRED_API_KEY) return null;
    console.log("Fetching Macro Data (Buffett Indicator) from FRED...");
    try {
        // 1. GDP (Gross Domestic Product) - Billions of Dollars
        const gdpUrl = `https://api.stlouisfed.org/fred/series/observations?series_id=GDP&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`;
        const gdpRes = await fetch(gdpUrl);
        const gdpData = await gdpRes.json();
        const gdpValue = parseFloat(gdpData.observations[0].value);

        // 2. Total Market Cap proxy: Nonfinancial corporate business; corporate equities - Millions of Dollars
        const capUrl = `https://api.stlouisfed.org/fred/series/observations?series_id=NCBEILQ027S&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`;
        const capRes = await fetch(capUrl);
        const capData = await capRes.json();
        const capValue = parseFloat(capData.observations[0].value) / 1000; // Convert to Billions to match GDP

        const buffettIndicator = (capValue / gdpValue) * 100;

        return {
            buffettIndicator: parseFloat(buffettIndicator.toFixed(2)),
            gdp: parseFloat(gdpValue.toFixed(2)),
            marketCap: parseFloat(capValue.toFixed(2)),
            lastUpdated: new Date().toISOString()
        };
    } catch (error) {
        console.error("Failed to fetch Buffett Indicator:", error);
        return null;
    }
}

async function fetchDolarCCL() {
    console.log("Fetching Dólar CCL from DolarAPI...");
    try {
        const url = 'https://dolarapi.com/v1/dolares/contadoconliqui';
        const res = await fetch(url);
        const data = await res.json();

        // DolarAPI returns: { compra, venta, casa, nombre, moneda, fechaActualizacion }
        // We will use the 'venta' price as the reference for CEDEARs
        const cclValue = parseFloat(data.venta);

        return {
            ccl: cclValue,
            lastUpdated: data.fechaActualizacion || new Date().toISOString()
        };
    } catch (error) {
        console.error("Failed to fetch Dólar CCL:", error);
        return null;
    }
}

async function main() {
    const today = new Date().toISOString().split('T')[0];
    console.log(`Starting data sync for ${today}...`);

    for (let i = 0; i < activeStocks.length; i++) {
        const symbol = activeStocks[i].symbol;
        const name = activeStocks[i].name;
        console.log(`[${i + 1}/${activeStocks.length}] Fetching data for ${symbol}...`);

        if (i > 0) {
            console.log(`Waiting 15 seconds to avoid rate limits...`);
            await wait(15000);
        }

        try {
            const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${API_KEY}`;
            const historyRes = await fetch(url);
            const historyData = await historyRes.json();

            if (historyData['Error Message']) {
                console.error(`API Error for ${symbol}:`, historyData['Error Message']);
                continue;
            }

            if (historyData['Information'] && historyData['Information'].includes('rate limit')) {
                console.error("API LIMIT REACHED. Stopping operation.");
                process.exit(1);
            }

            if (!historyData['Time Series (Daily)']) {
                console.error(`No data for ${symbol}`, historyData);
                continue;
            }

            const timeSeries = historyData['Time Series (Daily)'];
            const dates = Object.keys(timeSeries).slice(0, 250).reverse();
            const prices = dates.map(date => ({
                date,
                close: parseFloat(timeSeries[date]['4. close']),
                high: parseFloat(timeSeries[date]['2. high']),
                low: parseFloat(timeSeries[date]['3. low']),
                volume: parseFloat(timeSeries[date]['5. volume'])
            }));

            const closePrices = prices.map(p => p.close);

            const sma50Data = SMA.calculate({ period: 50, values: closePrices });
            const sma50 = sma50Data.length > 0 ? sma50Data[sma50Data.length - 1] : 0;

            const ema20Data = EMA.calculate({ period: 20, values: closePrices });
            const ema20 = ema20Data.length > 0 ? ema20Data[ema20Data.length - 1] : 0;

            const sma200Data = SMA.calculate({ period: 200, values: closePrices });
            const sma200 = sma200Data.length > 0 ? sma200Data[sma200Data.length - 1] : 0;

            const rsiData = RSI.calculate({ period: 14, values: closePrices });
            const rsi = rsiData.length > 0 ? rsiData[rsiData.length - 1] : 50;

            const macdInput = {
                values: closePrices,
                fastPeriod: 12,
                slowPeriod: 26,
                signalPeriod: 9,
                SimpleMAOscillator: false,
                SimpleMASignal: false
            };
            const macdData = MACD.calculate(macdInput);
            const latestMacd = macdData.length > 0 ? macdData[macdData.length - 1] : { MACD: 0, signal: 0, histogram: 0 };

            const currentPrice = closePrices[closePrices.length - 1];
            const prevPrice = closePrices[closePrices.length - 2];
            const change = currentPrice - prevPrice;
            const changePercent = (change / prevPrice) * 100;

            const recentHighs = prices.slice(-20).map(p => p.high);
            const recentLows = prices.slice(-20).map(p => p.low);
            const resistance = Math.max(...recentHighs);
            const support = Math.min(...recentLows);

            const finalData = {
                symbol: symbol,
                name: name,
                price: currentPrice.toFixed(2),
                change: change.toFixed(2),
                changePercent: changePercent.toFixed(2),
                sma50: sma50.toFixed(2),
                ema20: ema20.toFixed(2),
                sma200: sma200.toFixed(2),
                rsi: rsi.toFixed(2),
                macd: {
                    line: latestMacd.MACD,
                    signal: latestMacd.signal,
                    histogram: latestMacd.histogram
                },
                volume: prices[prices.length - 1].volume,
                avgVolume: 0,
                support: support.toFixed(2),
                resistance: resistance.toFixed(2),
                peRatio: staticFundamentals[symbol] ? staticFundamentals[symbol].peRatio : 'N/A',
                epsGrowth: staticFundamentals[symbol] ? staticFundamentals[symbol].eps : 'N/A',
                patterns: [],
                candles: [],
                history: {
                    dates: dates.slice(-60),
                    prices: closePrices.slice(-60),
                    sma50: sma50Data.slice(-60),
                    ema20: ema20Data.slice(-60),
                    sma200: sma200Data.slice(-60)
                }
            };

            const docRef = doc(db, "stocks", today);
            await setDoc(docRef, {
                [symbol]: finalData
            }, { merge: true });

            console.log(`Successfully synced ${symbol} to Firestore.`);

        } catch (error) {
            console.error(`Failed to update ${symbol}:`, error);
        }
    }

    // --- Macro Data Sync (Buffett Indicator & Dólar CCL) ---
    const macroData = await fetchBuffettIndicator();
    const cclData = await fetchDolarCCL();

    let combinedMacro = {};
    if (macroData) combinedMacro = { ...macroData };
    if (cclData) combinedMacro.ccl = cclData.ccl;

    // Always store the last update time
    combinedMacro.lastUpdated = new Date().toISOString();

    if (Object.keys(combinedMacro).length > 1) { // More than just lastUpdated
        try {
            const macroRef = doc(db, "macro", "latest");
            await setDoc(macroRef, combinedMacro, { merge: true });
            console.log("Successfully synced Macro Data to Firestore:", combinedMacro);

            // Si queremos guardar el historial del CCL para el gráfico
            if (cclData && cclData.ccl) {
                const cclHistoryRef = doc(db, "macro", "ccl_history");
                await setDoc(cclHistoryRef, {
                    [today]: cclData.ccl
                }, { merge: true });
                console.log(`Successfully saved CCL history point for ${today}: $${cclData.ccl}`);
            }
        } catch (error) {
            console.error("Failed to update Macro Data:", error);
        }
    }

    console.log("Sync complete! Exiting system.");
    process.exit(0);
}

main();
