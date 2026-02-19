// Servicio para obtener datos reales usando Alpha Vantage API
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyC7bIZOsDhg0iXGrm6aBD3c37AD3ZkUmTE",
    authDomain: "advisoracciones.firebaseapp.com",
    projectId: "advisoracciones",
    storageBucket: "advisoracciones.firebasestorage.app",
    messagingSenderId: "454193425218",
    appId: "1:454193425218:web:54b7136d042ecd951876db",
    measurementId: "G-7KQ8CF2SXJ"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// import { API_KEY } from './config.js'; 
const API_KEY = 'LAXDIEALK6NX3JFH'; // CAMBIAR EN UN FUTURO


export class RealDataService {
    constructor() {
        this.db = db;
        this.baseUrl = 'https://www.alphavantage.co/query';
        // Lista de 24 acciones variadas
        this.activeStocks = [
            // Tech
            { symbol: 'AAPL', name: 'Apple Inc.' },
            { symbol: 'MSFT', name: 'Microsoft Corp.' },
            { symbol: 'GOOGL', name: 'Alphabet Inc.' },
            { symbol: 'AMZN', name: 'Amazon.com' },
            { symbol: 'TSLA', name: 'Tesla Inc.' },
            { symbol: 'NVDA', name: 'NVIDIA Corp.' },
            { symbol: 'META', name: 'Meta Platforms' },
            { symbol: 'NFLX', name: 'Netflix Inc.' },
            // Finance
            { symbol: 'JPM', name: 'JPMorgan Chase' },
            { symbol: 'V', name: 'Visa Inc.' },
            // Consumer & Retail
            { symbol: 'KO', name: 'Coca-Cola' },
            { symbol: 'PEP', name: 'PepsiCo' },
            { symbol: 'WMT', name: 'Walmart' },
            { symbol: 'MCD', name: 'McDonald\'s' },
            { symbol: 'NKE', name: 'Nike' },
            // Energy & Industrial
            { symbol: 'XOM', name: 'Exxon Mobil' },
            { symbol: 'CVX', name: 'Chevron' },
            // Pharma
            { symbol: 'JNJ', name: 'Johnson & Johnson' },
            { symbol: 'PFE', name: 'Pfizer' },
            // Semiconductors & Others
            { symbol: 'AMD', name: 'AMD' },
            { symbol: 'INTC', name: 'Intel' },
            { symbol: 'DIS', name: 'Disney' }
        ];

        // DATOS FUNDAMENTALES (Snapshot Febrero 2026)
        // Se usan estos valores estáticos para no duplicar el consumo de API (cada request de fundamental cuesta 1 credito)
        // Estos datos son reales de la fecha actual.
        this.staticFundamentals = {
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
            'INTC': { peRatio: 'N/A', eps: -0.27 }, // Negative PE
            'DIS': { peRatio: 15.96, eps: 6.81 }
        };

        this.limitReached = false;
    }

    // Helper para pausas (Throttling)
    wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    getTodayDateString() {
        return new Date().toISOString().split('T')[0];
    }

    getDailyUsage() {
        const key = `api_usage_${this.getTodayDateString()}`;
        return parseInt(localStorage.getItem(key) || '0');
    }

    incrementUsage() {
        const key = `api_usage_${this.getTodayDateString()}`;
        let current = this.getDailyUsage();
        localStorage.setItem(key, (current + 1).toString());
    }

    async fetchStockData(symbol) {
        // Si ya sabemos que alcanzamos el límite, no intentamos más
        if (this.limitReached) return null;

        // Registrar intento de uso de API
        this.incrementUsage();

        try {
            // 1. Obtener Histórico de Precios (Diario)
            const historyUrl = `${this.baseUrl}?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${API_KEY}`;
            const historyRes = await fetch(historyUrl);
            const historyData = await historyRes.json();

            // Verificar Error de API Key
            if (historyData['Error Message']) {
                console.error("API Error:", historyData['Error Message']);
                if (historyData['Error Message'].includes('apikey is invalid')) {
                    alert("ERROR CRÍTICO: La API Key de Alpha Vantage es inválida o falta.\n\nPor favor verifica el archivo config.js y asegúrate de tener una clave válida.\nPuedes obtener una gratis en alphavantage.co");
                    this.limitReached = true; // Detener intentos
                    return null;
                }
            }

            // Verificar Límite de API (Alpha Vantage devuelve "Information" o "Note")
            if (historyData['Information'] && historyData['Information'].includes('rate limit')) {
                console.warn("API LIMIT REACHED");
                this.limitReached = true;
                return 'LIMIT_REACHED';
            }
            if (historyData['Note']) {
                console.warn(`API Limit Warning for ${symbol}:`, historyData['Note']);
            }

            if (!historyData['Time Series (Daily)']) {
                console.error(`No data for ${symbol}`, historyData);
                return null;
            }

            const timeSeries = historyData['Time Series (Daily)'];
            const dates = Object.keys(timeSeries).slice(0, 250).reverse(); // Últimos 250 días
            const prices = dates.map(date => ({
                date,
                close: parseFloat(timeSeries[date]['4. close']),
                high: parseFloat(timeSeries[date]['2. high']),
                low: parseFloat(timeSeries[date]['3. low']),
                volume: parseFloat(timeSeries[date]['5. volume'])
            }));

            const closePrices = prices.map(p => p.close);

            // 2. Calcular Indicadores (Acceder via window.SMA o window.technicalindicators.SMA)

            // Helper para obtener funcion de indicador
            const getIndicator = (name) => {
                if (window[name]) return window[name];
                if (window.technicalindicators && window.technicalindicators[name]) return window.technicalindicators[name];
                return null;
            };

            const SMA = getIndicator('SMA');
            const EMA = getIndicator('EMA');
            const RSI = getIndicator('RSI');
            const MACD = getIndicator('MACD');

            // SMA 50
            const sma50Data = SMA ? SMA.calculate({ period: 50, values: closePrices }) : [];
            const sma50 = sma50Data.length > 0 ? sma50Data[sma50Data.length - 1] : 0;

            // EMA 20
            const ema20Data = EMA ? EMA.calculate({ period: 20, values: closePrices }) : [];
            const ema20 = ema20Data.length > 0 ? ema20Data[ema20Data.length - 1] : 0;

            // SMA 200
            const sma200Data = SMA ? SMA.calculate({ period: 200, values: closePrices }) : [];
            const sma200 = sma200Data.length > 0 ? sma200Data[sma200Data.length - 1] : 0;

            // RSI 14
            const rsiData = RSI ? RSI.calculate({ period: 14, values: closePrices }) : [];
            const rsi = rsiData.length > 0 ? rsiData[rsiData.length - 1] : 50;

            // MACD
            const macdInput = {
                values: closePrices,
                fastPeriod: 12,
                slowPeriod: 26,
                signalPeriod: 9,
                SimpleMAOscillator: false,
                SimpleMASignal: false
            };
            const macdData = MACD ? MACD.calculate(macdInput) : [];
            const latestMacd = macdData.length > 0 ? macdData[macdData.length - 1] : { MACD: 0, signal: 0, histogram: 0 };

            // Datos actuales
            const currentPrice = closePrices[closePrices.length - 1];
            const prevPrice = closePrices[closePrices.length - 2];
            const change = currentPrice - prevPrice;
            const changePercent = (change / prevPrice) * 100;

            // Soportes y Resistencias
            const recentHighs = prices.slice(-20).map(p => p.high);
            const recentLows = prices.slice(-20).map(p => p.low);
            const resistance = Math.max(...recentHighs);
            const support = Math.min(...recentLows);

            return {
                symbol: symbol,
                name: this.activeStocks.find(s => s.symbol === symbol).name,
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
                // Usar datos fundamentales estáticos si existen
                peRatio: (this.staticFundamentals && this.staticFundamentals[symbol]) ? this.staticFundamentals[symbol].peRatio : 'N/A',
                epsGrowth: (this.staticFundamentals && this.staticFundamentals[symbol]) ? this.staticFundamentals[symbol].eps : 'N/A',
                patterns: [],
                candles: [],
                // Return structured history for detailed chart
                history: {
                    dates: dates.slice(-60),
                    prices: closePrices.slice(-60),
                    sma50: sma50Data.slice(-60),
                    ema20: ema20Data.slice(-60),
                    sma200: sma200Data.slice(-60)
                }
            };

        } catch (error) {
            console.error(`Error fetching ${symbol}:`, error);
            return null;
        }
    }

    // --- FIREBASE HELPERS ---
    async getFirestoreData(date) {
        try {
            const docRef = doc(this.db, "stocks", date);
            const docSnap = await getDoc(docRef);
            if (docSnap.exists()) {
                return docSnap.data(); // Returns object { AAPL: {...}, MSFT: {...} }
            } else {
                return null;
            }
        } catch (e) {
            // Re-throw to handle in loadStocks with UI feedback
            throw e;
        }
    }

    async saveToFirestore(date, symbol, data) {
        try {
            const docRef = doc(this.db, "stocks", date);
            // Save incremental update
            await setDoc(docRef, {
                [symbol]: data
            }, { merge: true });
        } catch (e) {
            console.error("Error saving to Firestore:", e);
            throw e;
        }
    }

    // Método principal: Carga incremental y persistente con Firebase
    async loadStocks(onStockLoaded, onProgressMsg) {
        const today = this.getTodayDateString();
        const cacheKey = `stocks_cache_${today}`;

        // 1. Cargar lo que ya hay en caché (Local Storage)
        let currentCache = [];
        try {
            currentCache = JSON.parse(localStorage.getItem(cacheKey) || '[]');
        } catch (e) {
            console.error("Error reading cache", e);
            currentCache = [];
        }

        // Informar UI inicial con caché
        if (currentCache.length > 0) {
            onStockLoaded(currentCache);
        }

        // 2. Intentar obtener datos globales de Firebase (La nube)
        if (onProgressMsg) onProgressMsg("Sincronizando con la nube...");

        let firestoreData = null;
        try {
            // Intentar leer todo el documento del día
            firestoreData = await this.getFirestoreData(today);
        } catch (e) {
            console.error("Firestore Read Error:", e);
            if (onProgressMsg) onProgressMsg(`⚠️ Error de Conexión Nube: ${e.code || e.message}`);
            // Alert user if on production/github to debug
            if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
                alert(`Error conectando a Firebase (Nube): ${e.message}\n\nAsegúrate de agregar '${window.location.hostname}' a los 'Dominios Autorizados' en Firebase Console -> Authentication -> Settings.`);
            }
        }

        let cloudCount = 0;
        let mergedList = [...currentCache];
        const localMap = new Map(currentCache.map(s => [s.symbol, s]));

        if (firestoreData) {
            // firestoreData es un objeto { AAPL: {...}, MSFT: {...} }
            // Lo convertimos a array y mezclamos
            Object.values(firestoreData).forEach(stockData => {
                if (!localMap.has(stockData.symbol)) {
                    mergedList.push(stockData);
                    localMap.set(stockData.symbol, stockData); // Update map
                    cloudCount++;
                }
            });

            // Si hubo datos nuevos de la nube, actualizamos caché local y UI
            if (cloudCount > 0) {
                localStorage.setItem(cacheKey, JSON.stringify(mergedList));
                onStockLoaded(mergedList);
                if (onProgressMsg) onProgressMsg(`Sincronizado: ${cloudCount} acciones recuperadas de la nube.`);
            }
        }

        // 3. Identificar qué falta descargar hoy
        // Usamos la lista combinada (mergedList) para ver qué nos falta de this.activeStocks
        const currentMap = new Map(mergedList.map(s => [s.symbol, s]));
        const pendingStocks = this.activeStocks.filter(s => !currentMap.has(s.symbol));

        if (pendingStocks.length === 0) {
            if (onProgressMsg) onProgressMsg("Datos completos por hoy.");
            return;
        }

        // 4. Descargar faltantes secuencialmente
        for (let i = 0; i < pendingStocks.length; i++) {
            if (this.limitReached) {
                if (onProgressMsg) onProgressMsg("⚠️ Límite de API alcanzado. Deteniendo proceso.");
                break;
            }

            const stockDef = pendingStocks[i];
            const msg = `Descargando ${stockDef.symbol} (${i + 1}/${pendingStocks.length} faltantes)... Pausa 15s...`;
            if (onProgressMsg) onProgressMsg(msg);

            // Pausa antes de pedir (excepto el primero si venimos de la nada, pero mejor prevenir)
            if (i > 0) await this.wait(15000);


            const data = await this.fetchStockData(stockDef.symbol);

            if (data === 'LIMIT_REACHED') {
                if (onProgressMsg) onProgressMsg(`Fin de cuota diaria en ${stockDef.symbol}.`);
                this.limitReached = true;
                break;
            }

            if (data) {
                // Guardar en Firebase (Nube)
                try {
                    await this.saveToFirestore(today, stockDef.symbol, data);
                } catch (e) {
                    console.error("Firestore Save Error", e);
                }

                // Guardado Incremental Local
                mergedList.push(data); // Add to master list
                localStorage.setItem(cacheKey, JSON.stringify(mergedList));

                // Notificar a UI
                onStockLoaded(mergedList);
            } else {
                if (onProgressMsg) onProgressMsg(`Error al descargar ${stockDef.symbol}. Saltando.`);
            }
        }

        if (onProgressMsg) {
            if (this.limitReached) onProgressMsg("⚠️ Cuota Diaria Agotada. Vuelva mañana.");
            else onProgressMsg("Actualización Finalizada.");
        }
    }
}
