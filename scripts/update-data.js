import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";
import { SMA, EMA, RSI, MACD, BollingerBands, Stochastic } from "technicalindicators";

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
    { symbol: 'PLTR', name: 'Palantir Technologies' },
    { symbol: 'SPY', name: 'SPDR S&P 500 ETF' },
    { symbol: 'CRM', name: 'Salesforce' },
    { symbol: 'XP', name: 'XP Inc.' },
    { symbol: 'AMD', name: 'AMD' },
    { symbol: 'INTC', name: 'Intel' },
    { symbol: 'DIS', name: 'Disney' },
    { symbol: 'MELI', name: 'MercadoLibre' },
    { symbol: 'BABA', name: 'Alibaba Group' },
    { symbol: 'SHOP', name: 'Shopify' },
    { symbol: 'UBER', name: 'Uber Technologies' },
    { symbol: 'PYPL', name: 'PayPal' },
    { symbol: 'SQ', name: 'Block Inc' },
    { symbol: 'COIN', name: 'Coinbase' },
    { symbol: 'BA', name: 'Boeing' },
    { symbol: 'LLY', name: 'Eli Lilly' },
    { symbol: 'AVGO', name: 'Broadcom' },
    { symbol: 'GGAL.BA', name: 'Grupo Financiero Galicia (AR)' },
    { symbol: 'YPFD.BA', name: 'YPF S.A. (AR)' },
    { symbol: 'PAMP.BA', name: 'Pampa Energía (AR)' },
    { symbol: 'BMA.BA', name: 'Banco Macro (AR)' },
    { symbol: 'TXAR.BA', name: 'Ternium Argentina (AR)' },
    { symbol: 'ALUA.BA', name: 'Aluar (AR)' },
    { symbol: 'CEPU.BA', name: 'Central Puerto (AR)' },
    { symbol: 'TGSU2.BA', name: 'Transportadora Gas del Sur (AR)' },
    { symbol: 'EDN.BA', name: 'Edenor (AR)' },
    { symbol: 'CRES.BA', name: 'Cresud (AR)' },
    { symbol: 'ARM', name: 'Arm Holdings' },
    { symbol: 'CRWD', name: 'Crowdstrike' },
    { symbol: 'SPOT', name: 'Spotify' },
    { symbol: 'SMCI', name: 'Super Micro Computer' },
    { symbol: 'ORCL', name: 'Oracle Corp.' },
    { symbol: 'UPST', name: 'Upstart Holdings' },
    { symbol: 'YPF', name: 'YPF S.A. (ADR)' },
    { symbol: 'MU', name: 'Micron Technology' },
    { symbol: 'CVX', name: 'Chevron Corp.' },
    { symbol: 'ADBE', name: 'Adobe Inc.' },
    { symbol: 'GLOB', name: 'Globant S.A.' },
    { symbol: 'BTC-USD', name: 'Bitcoin (USD)' },
    { symbol: 'NIO', name: 'NIO Inc.' },
    { symbol: 'NU', name: 'Nu Holdings Ltd.' }
];

const staticFundamentals = {
    'AAPL': { peRatio: 34.66, eps: 7.91, beta: 1.25, roe: 147.2 },
    'MSFT': { peRatio: 26.06, eps: 15.99, beta: 0.90, roe: 38.5 },
    'GOOGL': { peRatio: 29.73, eps: 10.91, beta: 1.05, roe: 23.6 },
    'AMZN': { peRatio: 28.85, eps: 7.29, beta: 1.15, roe: 18.2 },
    'TSLA': { peRatio: 386.41, eps: 1.08, beta: 2.15, roe: 21.0 },
    'NVDA': { peRatio: 46.01, eps: 4.03, beta: 1.70, roe: 69.2 },
    'META': { peRatio: 28.15, eps: 23.50, beta: 1.10, roe: 28.4 },
    'NFLX': { peRatio: 32.24, eps: 2.53, beta: 1.30, roe: 15.6 },
    'JPM': { peRatio: 16.12, eps: 20.01, beta: 1.11, roe: 16.5 },
    'V': { peRatio: 30.54, eps: 10.65, beta: 0.96, roe: 45.1 },
    'MA': { peRatio: 34.16, eps: 15.67, beta: 1.08, roe: 140.5 },
    'BAC': { peRatio: 14.76, eps: 3.83, beta: 1.35, roe: 11.2 },
    'KO': { peRatio: 26.08, eps: 3.03, beta: 0.58, roe: 41.5 },
    'PEP': { peRatio: 32.35, eps: 5.27, beta: 0.55, roe: 52.8 },
    'WMT': { peRatio: 44.95, eps: 2.87, beta: 0.51, roe: 18.9 },
    'MCD': { peRatio: 27.91, eps: 11.72, beta: 0.70, roe: -34.5 },
    'NKE': { peRatio: 37.60, eps: 1.70, beta: 1.12, roe: 35.8 },
    'PLTR': { peRatio: 285.50, eps: 0.09, beta: 2.75, roe: 7.2 },
    'SPY': { peRatio: 25.40, eps: 20.35, beta: 1.00, roe: 18.5 },
    'CRM': { peRatio: 72.30, eps: 4.25, beta: 1.20, roe: 7.5 },
    'XP': { peRatio: 12.80, eps: 1.85, beta: 1.45, roe: 21.0 },
    'AMD': { peRatio: 81.51, eps: 2.65, beta: 1.80, roe: 0.5 },
    'INTC': { peRatio: 'N/A', eps: -0.27, beta: 1.25, roe: -1.2 },
    'DIS': { peRatio: 15.96, eps: 6.81, beta: 1.35, roe: 2.5 },
    'MELI': { peRatio: 72.4, eps: 24.50, beta: 1.6, roe: 38.2 },
    'BABA': { peRatio: 12.5, eps: 6.27, beta: 0.6, roe: 14.8 },
    'SHOP': { peRatio: 110.5, eps: 0.75, beta: 2.0, roe: -5.2 },
    'UBER': { peRatio: 89.2, eps: 0.85, beta: 1.4, roe: 17.5 },
    'PYPL': { peRatio: 16.2, eps: 3.55, beta: 1.3, roe: 20.1 },
    'SQ': { peRatio: 75.3, eps: 1.05, beta: 2.3, roe: -1.8 },
    'COIN': { peRatio: 'N/A', eps: -4.50, beta: 3.2, roe: -14.6 },
    'BA': { peRatio: 'N/A', eps: -12.10, beta: 1.4, roe: 'N/A' },
    'LLY': { peRatio: 125.4, eps: 5.60, beta: 0.3, roe: 45.2 },
    'AVGO': { peRatio: 40.5, eps: 31.50, beta: 1.1, roe: 55.4 },
    'GGAL.BA': { peRatio: 10.5, eps: 345.5, beta: 1.8, roe: 25.4 },
    'YPFD.BA': { peRatio: 4.2, eps: 450.2, beta: 1.9, roe: 18.5 },
    'PAMP.BA': { peRatio: 6.8, eps: 210.4, beta: 1.4, roe: 20.1 },
    'BMA.BA': { peRatio: 9.4, eps: 512.3, beta: 1.7, roe: 22.8 },
    'TXAR.BA': { peRatio: 5.1, eps: 120.5, beta: 1.2, roe: 15.6 },
    'ALUA.BA': { peRatio: 6.5, eps: 85.2, beta: 1.1, roe: 14.2 },
    'CEPU.BA': { peRatio: 8.2, eps: 75.4, beta: 1.3, roe: 12.5 },
    'TGSU2.BA': { peRatio: 7.5, eps: 180.2, beta: 1.4, roe: 16.8 },
    'EDN.BA': { peRatio: 'N/A', eps: -45.2, beta: 1.5, roe: -5.2 },
    'CRES.BA': { peRatio: 12.4, eps: 95.5, beta: 1.6, roe: 10.4 },
    'ARM': { peRatio: 85.4, eps: 1.5, beta: 1.8, roe: 25.4 },
    'CRWD': { peRatio: 'N/A', eps: 0.8, beta: 1.9, roe: 'N/A' },
    'SPOT': { peRatio: 'N/A', eps: -1.2, beta: 1.6, roe: 'N/A' },
    'SMCI': { peRatio: 42.1, eps: 20.5, beta: 2.1, roe: 45.8 },
    'ORCL': { peRatio: 35.5, eps: 5.2, beta: 1.05, roe: 30.5 },
    'UPST': { peRatio: 'N/A', eps: -1.2, beta: 2.1, roe: -10.5 },
    'YPF': { peRatio: 5.2, eps: 6.5, beta: 1.8, roe: 18.5 },
    'MU': { peRatio: 18.5, eps: 7.8, beta: 1.3, roe: 22.5 },
    'CVX': { peRatio: 14.5, eps: 12.5, beta: 0.9, roe: 15.5 },
    'ADBE': { peRatio: 45.2, eps: 16.5, beta: 1.25, roe: 35.5 },
    'GLOB': { peRatio: 40.5, eps: 4.8, beta: 1.4, roe: 16.5 },
    'NU': { peRatio: 45.0, eps: 0.35, beta: 1.2, roe: 25.5 }
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

async function fetchVixAndTreasury() {
    if (!FRED_API_KEY) return null;
    console.log("Fetching Macro Data (VIX, US10Y) from FRED...");
    try {
        const vixUrl = `https://api.stlouisfed.org/fred/series/observations?series_id=VIXCLS&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`;
        const us10yUrl = `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`;

        const vixRes = await fetch(vixUrl);
        const vixData = await vixRes.json();
        let vix = null;
        if (vixData.observations && vixData.observations.length > 0 && vixData.observations[0].value !== ".") {
            vix = parseFloat(vixData.observations[0].value);
        }

        const us10yRes = await fetch(us10yUrl);
        const us10yData = await us10yRes.json();
        let us10y = null;
        if (us10yData.observations && us10yData.observations.length > 0 && us10yData.observations[0].value !== ".") {
            us10y = parseFloat(us10yData.observations[0].value);
        }

        return { vix, us10y };
    } catch (e) {
        console.error("Failed to fetch VIX/US10Y:", e);
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
            console.log(`Waiting 2 seconds...`);
            await wait(300);
        }

        try {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=2y`;
            const headerOptions = { headers: { 'User-Agent': 'Mozilla/5.0' } };
            const historyRes = await fetch(url, headerOptions);
            
            if (!historyRes.ok) {
                console.error(`HTTP Error ${historyRes.status} for ${symbol}`);
                continue;
            }

            const data = await historyRes.json();
            if (!data.chart || !data.chart.result || data.chart.result.length === 0) {
                console.error(`No data for ${symbol}`);
                continue;
            }

            const resultObj = data.chart.result[0];
            const timestamps = resultObj.timestamp;
            const quote = resultObj.indicators.quote[0];

            if (!timestamps || timestamps.length === 0 || !quote || !quote.close) {
                console.error(`Incomplete historical payload for ${symbol}`);
                continue;
            }

            let validResults = [];
            for (let j = 0; j < timestamps.length; j++) {
                if (quote.close[j] != null && quote.high[j] != null && quote.low[j] != null) {
                    validResults.push({
                        date: new Date(timestamps[j] * 1000).toISOString().split('T')[0],
                        close: parseFloat(quote.close[j]),
                        high: parseFloat(quote.high[j]),
                        low: parseFloat(quote.low[j]),
                        volume: parseFloat(quote.volume[j] || 0)
                    });
                }
            }

            const recentData = validResults.slice(-250); // Get latest 250 elements (1 trading year)
            const dates = recentData.map(d => d.date);
            const prices = recentData; // Objects with date, close, high, low, volume
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

            const bbData = BollingerBands.calculate({ period: 20, values: closePrices, stdDev: 2 });
            const latestBb = bbData.length > 0 ? bbData[bbData.length - 1] : { lower: 0, middle: 0, upper: 0 };

            // Reverse arrays for stochastic are NOT needed because our closePrices are already chronological
            const stochasticData = Stochastic.calculate({
                high: prices.map(p => p.high),
                low: prices.map(p => p.low),
                close: closePrices,
                period: 14,
                signalPeriod: 3
            });
            const latestStoch = stochasticData.length > 0 ? stochasticData[stochasticData.length - 1] : { k: 50, d: 50 };

            const currentPrice = closePrices[closePrices.length - 1];
            const prevPrice = closePrices[closePrices.length - 2];
            const change = currentPrice - prevPrice;
            const changePercent = (change / prevPrice) * 100;

            const recentHighs = prices.slice(-20).map(p => p.high);
            const recentLows = prices.slice(-20).map(p => p.low);
            const resistance = Math.max(...recentHighs);
            const support = Math.min(...recentLows);

            // Fetch News Sentiment & Real News Headlines
            let newsScore = 0;
            let newsSentimentStr = "NEUTRO";
            let realNewsData = [];
            try {
                const searchRes = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=5`, headerOptions);
                const searchData = await searchRes.json();
                if (searchData.news && searchData.news.length > 0) {
                    const symbolBase = symbol.split('.')[0];
                    const relatedNews = searchData.news.filter(n => {
                        if (!n.relatedTickers || n.relatedTickers.length === 0) return false;
                        return n.relatedTickers.includes(symbol) || n.relatedTickers.includes(symbolBase);
                    });

                    let totalScore = 0;
                    for (const n of relatedNews) {
                        const originalTitle = n.title || "";
                        const publisher = n.publisher || "Finance News";
                        const link = n.link || "#";
                        const pubTime = n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toLocaleDateString() : new Date().toLocaleDateString();
                        
                        let translatedTitle = originalTitle;
                        try {
                            const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=es&dt=t&q=${encodeURIComponent(originalTitle)}`);
                            const tData = await res.json();
                            if (tData && tData[0]) {
                                translatedTitle = tData[0].map(x => x[0]).join('');
                            }
                        } catch (e) {
                            // Fallback to english if API fails
                        }
                        
                        let articleScore = 0;
                        const words = originalTitle.toLowerCase().match(/\w+/g) || [];
                        const positiveWords = ['soar','surge','jump','beat','raised','upgrade','upgrades','positive','gain','gains','high','profit','buy','record','bull','bullish','growth','strong','dividend','smashes','smash','outperform','soaring','surging','jumping','wins','partner'];
                        const negativeWords = ['fall','plunge','drop','miss','missed','lower','lowered','downgrade','downgrades','negative','loss','sell','risk','bear','bearish','lawsuit','probe','delay','cut','cuts','weak','slump','underperform','warning','penalty','sues','falling','plunging','dropping','fines','probe'];
                        
                        for (let word of words) {
                            if (positiveWords.includes(word)) articleScore += 1;
                            if (negativeWords.includes(word)) articleScore -= 1;
                        }
                        totalScore += articleScore;
                        
                        let articleSentimentStr = "NEUTRO";
                        if (articleScore > 0) articleSentimentStr = "POSITIVO";
                        else if (articleScore < 0) articleSentimentStr = "NEGATIVO";

                        realNewsData.push({ 
                            title: translatedTitle, 
                            publisher, 
                            link, 
                            date: pubTime,
                            sentiment: articleSentimentStr,
                            score: articleScore
                        });
                    }
                    newsScore = Math.max(-5, Math.min(5, totalScore));
                    if (newsScore >= 2) newsSentimentStr = "POSITIVO";
                    else if (newsScore <= -2) newsSentimentStr = "NEGATIVO";
                }
            } catch(e) { console.error("News fetch error:", e); }

                const recentVols = prices.slice(-20).map(p => p.volume || 0);
                const avgVolume = recentVols.length > 0 ? recentVols.reduce((a,b)=>a+b,0)/recentVols.length : 1;
                
                // Calculo estricto del True Range y ATR a 14 dias
                const trData = [];
                for(let i=1; i<closePrices.length; i++){
                    const high = prices[i].high;
                    const low = prices[i].low;
                    const prevCloseLocal = prices[i-1].close;
                    const tr = Math.max(high - low, Math.abs(high - prevCloseLocal), Math.abs(low - prevCloseLocal));
                    trData.push(tr);
                }
                const recentTr = trData.slice(-14);
                const atrVal = recentTr.length > 0 ? recentTr.reduce((a,b)=>a+b,0)/recentTr.length : 0;

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
                    avgVolume: avgVolume,
                    atr: atrVal.toFixed(2),
                support: support.toFixed(2),
                resistance: resistance.toFixed(2),
                peRatio: staticFundamentals[symbol] ? staticFundamentals[symbol].peRatio : 'N/A',
                epsGrowth: staticFundamentals[symbol] ? staticFundamentals[symbol].eps : 'N/A',
                beta: staticFundamentals[symbol] ? staticFundamentals[symbol].beta : 'N/A',
                roe: staticFundamentals[symbol] ? staticFundamentals[symbol].roe : 'N/A',
                bollinger: {
                    upper: latestBb.upper.toFixed(2),
                    lower: latestBb.lower.toFixed(2)
                },
                stochastic: {
                    k: latestStoch.k.toFixed(2),
                    d: latestStoch.d.toFixed(2)
                },
                newsSentiment: newsScore,
                newsSentimentStr: newsSentimentStr,
                newsList: realNewsData,
                patterns: [],
                candles: [],
                history: JSON.stringify({
                    dates: dates.slice(-250),
                    prices: closePrices.slice(-250),
                    sma50: sma50Data.slice(-250),
                    ema20: ema20Data.slice(-250),
                    sma200: sma200Data.slice(-250)
                })
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
    const vixTreasuryData = await fetchVixAndTreasury();

    let combinedMacro = {};
    if (macroData) combinedMacro = { ...macroData };
    if (cclData) combinedMacro.ccl = cclData.ccl;
    if (vixTreasuryData) combinedMacro = { ...combinedMacro, vix: vixTreasuryData.vix, us10y: vixTreasuryData.us10y };

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
