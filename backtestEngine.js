import { analyzeStockWithMarketCondition } from './analysisEngine.js';

/**
 * MOTOR DE BACKTEST (Out-Of-Sample, con costos y sizing por riesgo).
 * Extraído de app.js para poder testearlo de forma aislada en Node (ver test/backtestEngine.test.mjs).
 * Depende solo de analyzeStockWithMarketCondition; no toca el DOM.
 */

// ATR aproximado a partir de solo cierres (el historial del backtest no trae high/low):
// promedio del movimiento absoluto diario de los últimos `period` días. Sirve como medida de
// volatilidad para dimensionar la posición por riesgo y ubicar el stop.
export function atrProxyFromCloses(closes, period = 14) {
    if (!Array.isArray(closes) || closes.length < 2) return null;
    const n = Math.min(period, closes.length - 1);
    if (n <= 0) return null;
    let sum = 0;
    for (let k = closes.length - n; k < closes.length; k++) {
        sum += Math.abs(parseFloat(closes[k]) - parseFloat(closes[k - 1]));
    }
    return sum / n;
}

// Intervalo de confianza de Wilson para una proporción (ej. el win rate). Da un rango honesto
// en vez de un número puntual: con pocos trades el rango es enorme, avisando que el dato es flojo.
export function wilsonInterval(p, n, z = 1.96) {
    if (!n || n <= 0) return { low: 0, high: 0 };
    const denom = 1 + (z * z) / n;
    const center = (p + (z * z) / (2 * n)) / denom;
    const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
    return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export function runBacktest(stockHistoryChronological, config = {}) {
    if (!Array.isArray(stockHistoryChronological) || stockHistoryChronological.length === 0) {
        console.error("Backtest falló: stockHistory vacio o invalido.");
        return null;
    }

    if (typeof config === 'string') {
        config = { term: config };
    }

    const {
        capital = 10000,
        positionSizePct = 1.0,
        stopLossPct = 0.08,
        takeProfitPct = 0.15,
        trailingStopPct = 0.03, // Ignored mostly as we use ATR dynamically now
        slippagePct = 0.2,
        commissionPct = 0.1,
        // --- Sizing por riesgo (nuevo) ---
        // 'risk': arriesga un % fijo del capital por operación contra un stop por ATR (realista).
        // 'allin': comportamiento viejo (invierte casi todo el capital en cada trade).
        sizingMode = 'risk',
        riskPerTradePct = 0.01,   // arriesga 1% del capital por operación
        stopAtrMult = 2,          // distancia del stop = 2 x ATR aproximado
        maxPositionPct = 0.95,    // exposición máxima por trade (sin apalancamiento)
        // --- Filtro por Zona de Entrada (nuevo) ---
        // Si está activo, además de la señal de compra exige que el precio esté en una zona sana
        // (EN_ZONA o ACEPTABLE del Plan de Entrada); descarta entradas EXTENDIDO/DEBAJO (perseguir
        // o cuchillo cayendo). Sirve para medir si la regla del Plan de Entrada agrega valor.
        useEntryZoneFilter = false,
        term = 'short',
        marketCondition = 'SIDEWAYS'
    } = config;

    // El stop-loss "duro" se interpreta como MAGNITUD y siempre se aplica como pérdida (negativo).
    // Antes la UI mandaba +0.05 y la condición floatProfit <= 0.05 disparaba una venta el primer
    // día de casi todos los trades: el backtest quedaba sin operaciones reales (bug).
    const stopLossThreshold = -Math.abs(stopLossPct);

    // 1. TIME-BASED SPLIT (Anti Data Leakage)
    // Reserve 20% for pure Out-Of-Sample validation testing
    const splitIndex = Math.floor(stockHistoryChronological.length * 0.80);
    const testData = stockHistoryChronological.slice(splitIndex);

    if (testData.length < 10) {
        return { error: "Poco data out-of-sample para test" };
    }
    console.log(`[Backtest] Evaluando ${testData.length} dias OUT-OF-SAMPLE (Blind Test)`);

    let currentCapital = capital;
    let position = null;

    let trades = [];
    let grossProfit = 0;
    let grossLoss = 0;
    let peakCapital = capital;
    let maxDrawdown = 0;
    let equityCurve = [];
    let daysInMarket = 0; // para medir exposición (% del tiempo con posición abierta)
    let totalCommissions = 0; // costo acumulado de comisiones (entrada + salida)
    let totalSlippage = 0;    // costo acumulado por deslizamiento de precio
    let entriesSkippedByZone = 0; // señales de compra descartadas por el filtro de zona de entrada

    testData.forEach((dayData, index) => {
        const currentPrice = parseFloat(dayData.price);
        if (isNaN(currentPrice)) return;

        let portfolioInfo = null;
        if (position) {
            if (currentPrice > position.highestPrice) {
                position.highestPrice = currentPrice;
            }
            portfolioInfo = {
                entryPrice: position.entryPrice,
                highestPrice: position.highestPrice
            };
        }

        const analysis = analyzeStockWithMarketCondition(dayData, term, marketCondition, portfolioInfo);

        let signal = analysis.señal_final || analysis.signal;
        if (term === 'short') signal = analysis.corto_plazo.signal;
        else if (term === 'long') signal = analysis.largo_plazo.signal;

        if (!position) {
            // Evaluando Entrada
            let allowEntry = signal.includes("COMPRA") || signal.includes("PRE-COMPRA");

            // Filtro por Zona de Entrada: exige que el precio esté en zona sana, no extendido.
            if (allowEntry && useEntryZoneFilter) {
                const ez = analysis.entryZone;
                const okZone = !!(ez && (ez.status === 'EN_ZONA' || ez.status === 'ACEPTABLE'));
                if (!okZone) {
                    allowEntry = false;
                    entriesSkippedByZone++;
                }
            }

            if (allowEntry) {
                // --- DIMENSIONAMIENTO DE LA POSICIÓN ---
                let stopDist = null;
                let investAmount;
                if (sizingMode === 'risk') {
                    // Arriesgamos riskPerTradePct del capital; el tamaño sale de la distancia al stop.
                    const closes = (dayData.history && dayData.history.prices) ? dayData.history.prices : null;
                    const atrProxy = atrProxyFromCloses(closes, 14);
                    stopDist = atrProxy ? atrProxy * stopAtrMult : currentPrice * 0.05; // fallback 5%
                    const riskCapital = currentCapital * riskPerTradePct; // $ máximo a perder si toca el stop
                    const notionalByRisk = stopDist > 0 ? (riskCapital / stopDist) * currentPrice : 0;
                    investAmount = Math.min(notionalByRisk, currentCapital * maxPositionPct);
                } else {
                    investAmount = currentCapital * positionSizePct;
                }

                if (investAmount > 0) {
                    const priceWithSlippage = currentPrice * (1 + (slippagePct / 100));
                    const commission = investAmount * (commissionPct / 100);
                    totalCommissions += commission;

                    const finalInvestAmount = investAmount - commission;
                    const qty = finalInvestAmount / priceWithSlippage;
                    totalSlippage += qty * (priceWithSlippage - currentPrice);

                    position = {
                        entryDate: dayData.date,
                        entryPrice: priceWithSlippage,
                        qty: qty,
                        highestPrice: priceWithSlippage,
                        investedAmount: investAmount,
                        stopPrice: stopDist ? (priceWithSlippage - stopDist) : null
                    };
                    currentCapital -= investAmount;
                }
            }
        } else {
            // Evaluando Salida
            let exitReason = null;
            const floatProfitPct = (currentPrice - position.entryPrice) / position.entryPrice;

            // Hard Stops (Safety net)
            if (position.stopPrice != null && currentPrice <= position.stopPrice) {
                exitReason = "STOP_ATR"; // stop por riesgo (distancia en ATR desde la entrada)
            } else if (floatProfitPct <= stopLossThreshold) {
                exitReason = "STOP_LOSS";
            } else if (floatProfitPct >= takeProfitPct) {
                exitReason = "TAKE_PROFIT";
            } else if (analysis.actionFlag) { // Flag dinamico ATR del motor de analisis
                exitReason = analysis.actionFlag;
            } else if (signal.includes("VENTA")) {
                exitReason = "SIGNAL_SELL";
            } else if (trailingStopPct && floatProfitPct > 0) {
                const drawdownFromPeak = (position.highestPrice - currentPrice) / position.highestPrice;
                if (drawdownFromPeak >= trailingStopPct) {
                    exitReason = "TRAILING_STOP";
                }
            }

            if (exitReason) {
                const priceWithSlippage = currentPrice * (1 - (slippagePct / 100));
                const grossVal = position.qty * priceWithSlippage;
                const commission = grossVal * (commissionPct / 100);
                totalCommissions += commission;
                totalSlippage += position.qty * (currentPrice - priceWithSlippage);
                const netVal = grossVal - commission;

                currentCapital += netVal;

                const tradeProfit = netVal - position.investedAmount;
                if (tradeProfit > 0) grossProfit += tradeProfit;
                else grossLoss += Math.abs(tradeProfit);

                trades.push({
                    entryDate: position.entryDate,
                    exitDate: dayData.date,
                    profit: tradeProfit,
                    profitPct: tradeProfit / position.investedAmount,
                    reason: exitReason
                });

                position = null;
            }
        }

        if (position) daysInMarket++;

        const currentEquity = currentCapital + (position ? (currentPrice * position.qty) : 0);
        equityCurve.push({ date: dayData.date, value: currentEquity });

        if (currentEquity > peakCapital) {
            peakCapital = currentEquity;
        } else {
            const drawdown = (peakCapital - currentEquity) / peakCapital;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        }
    });

    // Close open position at end
    if (position) {
        const lastDay = testData[testData.length - 1];
        const lastPrice = parseFloat(lastDay.price);
        const priceWithSlippage = lastPrice * (1 - (slippagePct / 100));
        const grossVal = position.qty * priceWithSlippage;
        const commission = grossVal * (commissionPct / 100);
        totalCommissions += commission;
        totalSlippage += position.qty * (lastPrice - priceWithSlippage);
        const netVal = grossVal - commission;

        currentCapital += netVal;
        const tradeProfit = netVal - position.investedAmount;
        if (tradeProfit > 0) grossProfit += tradeProfit;
        else grossLoss += Math.abs(tradeProfit);

        trades.push({
            entryDate: position.entryDate,
            exitDate: lastDay.date,
            profit: tradeProfit,
            profitPct: tradeProfit / position.investedAmount,
            reason: "END_OF_TEST"
        });
    }

    const winningTrades = trades.filter(t => t.profit > 0).length;
    const winRate = trades.length > 0 ? (winningTrades / trades.length) : 0;
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : 0);

    // Honestidad estadística: intervalo de confianza del win rate y una etiqueta de fiabilidad
    // según cuántos trades hubo. Pocos trades => rango enorme => el resultado no es concluyente.
    const winRateCI = wilsonInterval(winRate, trades.length);
    const sampleReliability = trades.length >= 30 ? 'alta' : (trades.length >= 10 ? 'media' : 'baja');
    const totalReturn = (currentCapital - capital) / capital;
    const exposurePct = testData.length > 0 ? (daysInMarket / testData.length) : 0;

    // --- BENCHMARK: COMPRAR Y MANTENER (mismo activo, misma ventana, mismos costos) ---
    // Responde la pregunta clave: ¿la estrategia de timing supera a simplemente sostener la acción?
    const firstPrice = parseFloat(testData[0].price);
    const lastPrice = parseFloat(testData[testData.length - 1].price);
    let buyHold = null;
    if (!isNaN(firstPrice) && firstPrice > 0 && !isNaN(lastPrice)) {
        const bhEntry = firstPrice * (1 + slippagePct / 100);
        const bhQty = (capital * (1 - commissionPct / 100)) / bhEntry;
        // Curva de capital y drawdown de buy & hold (marcado a mercado)
        let bhPeak = capital, bhMaxDD = 0;
        const bhEquityCurve = testData.map(d => {
            const p = parseFloat(d.price);
            const val = isNaN(p) ? capital : bhQty * p;
            if (val > bhPeak) bhPeak = val;
            else { const dd = (bhPeak - val) / bhPeak; if (dd > bhMaxDD) bhMaxDD = dd; }
            return { date: d.date, value: val };
        });
        const bhExit = lastPrice * (1 - slippagePct / 100);
        const bhFinal = bhQty * bhExit * (1 - commissionPct / 100);
        buyHold = {
            totalReturn: (bhFinal - capital) / capital,
            finalCapital: bhFinal,
            maxDrawdown: bhMaxDD,
            equityCurve: bhEquityCurve
        };
    }

    // --- BENCHMARK EXTERNO OPCIONAL (ej. SPY / S&P500), alineado a la ventana de test ---
    let benchmark = null;
    if (config.benchmark && Array.isArray(config.benchmark.prices) && config.benchmark.prices.length > 1) {
        const startDate = testData[0].date, endDate = testData[testData.length - 1].date;
        const bp = config.benchmark.prices.filter(p => p.date >= startDate && p.date <= endDate && p.price != null);
        if (bp.length > 1) {
            const bStart = parseFloat(bp[0].price), bEnd = parseFloat(bp[bp.length - 1].price);
            if (bStart > 0) {
                benchmark = { label: config.benchmark.label || 'Benchmark', totalReturn: (bEnd - bStart) / bStart };
            }
        }
    }

    // Alpha = exceso de la estrategia sobre comprar y mantener el mismo activo
    const alpha = buyHold ? (totalReturn - buyHold.totalReturn) : null;
    // Alpha vs mercado (si hay benchmark externo)
    const alphaVsBenchmark = benchmark ? (totalReturn - benchmark.totalReturn) : null;

    const totalCosts = totalCommissions + totalSlippage;
    const result = {
        initialCapital: capital,
        finalCapital: currentCapital,
        totalReturn: totalReturn,
        winRate: winRate,
        winRateCI: winRateCI,
        sampleReliability: sampleReliability,
        maxDrawdown: maxDrawdown,
        profitFactor: profitFactor === Infinity ? "Infinity" : profitFactor.toFixed(2),
        exposurePct: exposurePct,
        trades: trades,
        equityCurve: equityCurve,
        buyHold: buyHold,
        benchmark: benchmark,
        alpha: alpha,
        alphaVsBenchmark: alphaVsBenchmark,
        // --- Costos y sizing (nuevo) ---
        sizingMode: sizingMode,
        totalCommissions: totalCommissions,
        totalSlippage: totalSlippage,
        totalCosts: totalCosts,
        costDragPct: capital > 0 ? totalCosts / capital : 0,
        // --- Filtro por zona de entrada (nuevo) ---
        useEntryZoneFilter: useEntryZoneFilter,
        entriesSkippedByZone: entriesSkippedByZone
    };

    return result;
}
