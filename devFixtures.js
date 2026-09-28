// DATOS DE EJEMPLO PARA DESARROLLO LOCAL (MODO MOCK)
// Solo se usan cuando la app corre en localhost / 127.0.0.1 / *.localhost / *.test / file://
// (ver realData.js -> IS_MOCK). Nunca se usan en producción. Sirven para ver y desarrollar la UI
// sin depender del backend ni de Firestore (que bloquean el acceso por CORS/permisos fuera de Vercel).

function buildHistory(days, startPrice, driftPct, wavePct, rsiVal, macdHist) {
    const dates = [];
    const prices = [];
    let p = startPrice;
    const base = new Date();
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(base);
        d.setDate(base.getDate() - i);
        dates.push(d.toISOString().split('T')[0]);
    }
    for (let i = 0; i < days; i++) {
        p = p * (1 + driftPct + Math.sin(i / 4) * wavePct);
        prices.push(parseFloat(p.toFixed(2)));
    }
    return {
        dates,
        prices,
        sma50: prices.map(v => parseFloat((v * 0.97).toFixed(2))),
        ema20: prices.map(v => parseFloat((v * 0.99).toFixed(2))),
        sma200: prices.map(v => parseFloat((v * 0.90).toFixed(2))),
        rsi: prices.map(() => rsiVal),
        macd: prices.map(() => ({ histogram: macdHist }))
    };
}

function buildStock(cfg) {
    const h = buildHistory(cfg.days || 220, cfg.startPrice, cfg.drift, cfg.wave, cfg.rsi, cfg.macdHist);
    const prices = h.prices;
    const price = prices[prices.length - 1];
    const prev = prices[prices.length - 2] || price;
    const change = parseFloat((price - prev).toFixed(2));
    const changePercent = parseFloat(((change / prev) * 100).toFixed(2));
    const recent = prices.slice(-20);
    return {
        symbol: cfg.symbol,
        name: cfg.name,
        price: price.toFixed(2),
        change: change.toFixed(2),
        changePercent: changePercent.toFixed(2),
        ema20: (price * 0.99).toFixed(2),
        sma50: (price * 0.97).toFixed(2),
        sma200: (price * 0.90).toFixed(2),
        rsi: cfg.rsi.toFixed(2),
        macd: { line: cfg.macdHist, signal: 0, histogram: cfg.macdHist },
        volume: cfg.volume || 1200000,
        avgVolume: cfg.avgVolume || 1000000,
        atr: (price * 0.02).toFixed(2),
        support: Math.min(...recent).toFixed(2),
        resistance: Math.max(...recent).toFixed(2),
        peRatio: cfg.peRatio,
        eps: cfg.eps,
        epsGrowth: cfg.epsGrowth,
        beta: cfg.beta,
        roe: cfg.roe,
        fundamentalsSource: 'static',
        dataAsOf: h.dates[h.dates.length - 1],
        bollinger: { upper: (price * 1.05).toFixed(2), lower: (price * 0.95).toFixed(2) },
        stochastic: { k: cfg.stochK.toFixed(2), d: cfg.stochD.toFixed(2) },
        newsSentiment: cfg.news || 0,
        newsSentimentStr: (cfg.news || 0) > 0 ? 'POSITIVO' : ((cfg.news || 0) < 0 ? 'NEGATIVO' : 'NEUTRO'),
        newsList: [],
        earningsDate: cfg.earningsDate || null,
        latestEarnings: null,
        history: h
    };
}

export function mockStocks() {
    return [
        buildStock({ symbol: 'AAPL', name: 'Apple Inc. (DEMO)', startPrice: 150, drift: 0.0015, wave: 0.004, rsi: 55, macdHist: 1.1, peRatio: 30, eps: 6.5, epsGrowth: 8, beta: 1.2, roe: 145, stochK: 45, stochD: 35, news: 1 }),
        buildStock({ symbol: 'TSLA', name: 'Tesla Inc. (DEMO)', startPrice: 180, drift: 0.001, wave: 0.012, rsi: 62, macdHist: 0.6, peRatio: 70, eps: 3.1, epsGrowth: -5, beta: 2.1, roe: 21, stochK: 82, stochD: 78, news: 0 }),
        buildStock({ symbol: 'KO', name: 'Coca-Cola (DEMO)', startPrice: 58, drift: 0.0005, wave: 0.002, rsi: 48, macdHist: -0.2, peRatio: 26, eps: 2.5, epsGrowth: 4, beta: 0.6, roe: 40, stochK: 40, stochD: 45, news: 0 }),
        buildStock({ symbol: 'SPY', name: 'S&P 500 ETF (DEMO)', startPrice: 440, drift: 0.0008, wave: 0.003, rsi: 53, macdHist: 0.4, peRatio: 25, eps: 20, epsGrowth: 6, beta: 1.0, roe: 18, stochK: 50, stochD: 48, news: 0 })
    ];
}

export function mockMacro() {
    return {
        lastUpdated: new Date().toISOString(),
        buffettIndicator: 185, buffettRecommendation: 'Sobrevalorado (DEMO)',
        cape: 32.5, tobinQ: 1.8, earningsYield: 4.2,
        ccl: 1450, vix: 16.5, us10y: 4.1
    };
}

export function mockCclHistory() {
    const out = {};
    const base = new Date();
    for (let i = 30; i >= 0; i--) {
        const d = new Date(base);
        d.setDate(base.getDate() - i);
        out[d.toISOString().split('T')[0]] = 1400 + Math.round(Math.sin(i / 3) * 40 + i);
    }
    return out;
}

export function mockHealth() {
    return {
        lastRun: new Date().toISOString(),
        dateStr: new Date().toISOString().split('T')[0],
        totalSymbols: 4, successCount: 4, failedCount: 0, failedSymbols: [],
        durationSec: 3, status: 'OK'
    };
}
