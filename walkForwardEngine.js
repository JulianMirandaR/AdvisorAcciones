import { analyzeStockWithMarketCondition, getMarketCondition } from './analysisEngine.js';

/**
 * WALK-FORWARD BACKTESTING ENGINE
 * Ejecuta validación real Out-Of-Sample sobre series de tiempo con IA (TensorFlow).
 */

// 1. UTILIDADES DE RED NEURONAL (Reusables y aisladas)
function buildCNNModel(windowSize, numFeatures) {
    const model = window.tf.sequential();
    const kInit = () => window.tf.initializers.glorotUniform({ seed: 42 });
    const bInit = () => window.tf.initializers.zeros();

    model.add(window.tf.layers.conv1d({
        filters: 16, kernelSize: 3, activation: 'relu',
        inputShape: [windowSize, numFeatures],
        kernelInitializer: kInit(), biasInitializer: bInit(),
        kernelRegularizer: window.tf.regularizers.l2({ l2: 0.001 }) 
    }));
    model.add(window.tf.layers.maxPooling1d({ poolSize: 2 }));
    model.add(window.tf.layers.flatten());
    model.add(window.tf.layers.dropout({ rate: 0.3 }));
    model.add(window.tf.layers.dense({ 
        units: 16, activation: 'relu', 
        kernelInitializer: kInit(), biasInitializer: bInit(),
        kernelRegularizer: window.tf.regularizers.l2({ l2: 0.001 }) 
    }));
    model.add(window.tf.layers.dense({ 
        units: 1, activation: 'sigmoid',
        kernelInitializer: kInit(), biasInitializer: bInit()
    }));
    
    model.compile({ optimizer: window.tf.train.adam(0.005), loss: 'binaryCrossentropy' });
    return model;
}

// Temperature Scaling Proxy calibrador
function calibrateProb(rawProb) {
    const T = 1.35;
    const pSafe = Math.max(1e-7, Math.min(1 - 1e-7, rawProb));
    const logit = Math.log(pSafe / (1 - pSafe));
    return 1 / (1 + Math.exp(-logit / T));
}

// 2. FUNCIÓN PRINCIPAL DE WALK-FORWARD
export async function runWalkForwardBacktest(stockHistoryChronological, config = {}) {
    if (!window.tf) return { error: "TensorFlow.js no está disponible." };

    const {
        trainSize = 120,    // Días usados para entrenar (Ventana retrospectiva de datos)
        testSize = 20,      // Días iterados Out-Of-Sample
        stepSize = 20,      // Avance de reentrenamiento. Igual a testSize significa sin superposición
        threshold = 0.65,    // Umbral estricto para confirmar Buy Signal
        horizon = 5,        // Salida a horizonte fijo (5 días)
        windowMode = 'rolling', // 'rolling' (100 días móviles) vs 'expanding' (desde 0 a N)
        capital = 10000     // Capital base
    } = config;

    const windowSize = 20; // Ventana de observación IA
    if (stockHistoryChronological.length < trainSize + testSize + windowSize) {
        return { error: "Datos insuficientes para realizar un Fold de Walk-Forward." };
    }

    // --- PRE-PROCESAMIENTO GLOBAL SIN LEAKAGE ---
    const prices = stockHistoryChronological.map(d => parseFloat(d.price));
    const logReturns = [0];
    const rollingVol = [0];
    const volWindow = 5;

    for (let i = 1; i < prices.length; i++) {
        logReturns.push(Math.log(prices[i] / prices[i-1]));
        if (i < volWindow) {
            rollingVol.push(0);
        } else {
            const wSlice = logReturns.slice(i - volWindow + 1, i + 1);
            const mean = wSlice.reduce((a,b)=>a+b,0) / volWindow;
            const variance = wSlice.reduce((a,b)=>a+Math.pow(b-mean,2),0) / volWindow;
            rollingVol.push(Math.sqrt(variance));
        }
    }

    // Constructor de Matrices Temporales [t - windowSize ... t]
    // Validaremos targets luego para no filtrar futuro al batch de entrenamiento.
    const X_features = [];
    for (let i = 0; i < prices.length; i++) {
        const featMap = [];
        if (i < windowSize - 1) {
            X_features.push(null); // No hay features válidos aquí
            continue;
        }
        for (let j = 0; j < windowSize; j++) {
            const idx = i - windowSize + 1 + j;
            featMap.push([logReturns[idx], rollingVol[idx]]);
        }
        X_features.push(featMap);
    }

    const numFeatures = 2;
    const targetThreshold = 0.02; // Retorno +2% en <horizon> días

    let currentEquity = capital;
    let peakEquity = capital;
    let maxDrawdown = 0;
    
    let activeTrade = null;
    let trades = [];
    let equityCurve = [];
    let stepLog = [];

    // --- BUCLE MAESTRO: A través del tiempo ---
    let loopPos = trainSize;
    let fold = 1;

    console.log(`[Walk-Forward] Iniciando con capital $${capital} | Mode: ${windowMode}`);

    while (loopPos + testSize < prices.length) {
        const trainStartIdx = windowMode === 'rolling' ? loopPos - trainSize : 0;
        const testStartIdx = loopPos;
        const testEndIdx = loopPos + testSize;

        // Liberar un poco al navegador (evita colgar el main thread)
        await new Promise(r => setTimeout(r, 10));

        // 1. Extraer DataSet de Entrenamientos Válido (Evitando el Leak del Horizonte!)
        const X_train = [];
        const Y_train = [];
        for (let t = trainStartIdx + windowSize; t < testStartIdx - horizon; t++) {
            if (!X_features[t-1]) continue;
            
            X_train.push(X_features[t-1]);
            
            // Target futuro de la fila (No hay Leak porque estamos en in-sample history restando horizonte)
            const pFut = prices[t + horizon];
            const pCur = prices[t];
            const realRet = Math.log(pFut / pCur);
            Y_train.push(realRet > targetThreshold ? 1 : 0);
        }

        if (X_train.length > 0) {
            const tensorX = window.tf.tensor3d(X_train, [X_train.length, windowSize, numFeatures]);
            const tensorY = window.tf.tensor1d(Y_train);
            
            const localModel = buildCNNModel(windowSize, numFeatures);
            
            // Re-entrena el modelo eficientemente
            await localModel.fit(tensorX, tensorY, { epochs: 30, verbose: 0 }); // Limita overfit frenando a 30

            // 2. TESTING EN OOS (Data Futura a nivel del split)
            for (let t = testStartIdx; t < testEndIdx; t++) {
                // Tracking Equidad diaria (Mark-To-Market)
                const currentPrice = prices[t];
                
                if (activeTrade) {
                    const daysHeld = t - activeTrade.entryIndex;
                    const floatProfit = (currentPrice - activeTrade.entryPrice) / activeTrade.entryPrice;
                    const valFloat = activeTrade.qty * currentPrice;
                    
                    const dailyTotal = currentEquity + valFloat;
                    equityCurve.push({ date: stockHistoryChronological[t].date, value: dailyTotal });
                    peakEquity = Math.max(peakEquity, dailyTotal);
                    maxDrawdown = Math.max(maxDrawdown, (peakEquity - dailyTotal) / peakEquity);

                    // SALIDA FIJA A HORIZONTE
                    if (daysHeld >= horizon) {
                        currentEquity += valFloat;
                        activeTrade.exitDate = stockHistoryChronological[t].date;
                        activeTrade.exitPrice = currentPrice;
                        activeTrade.profitPct = floatProfit;
                        activeTrade.profitVal = valFloat - activeTrade.invSize;
                        trades.push(activeTrade);
                        activeTrade = null;
                    }
                } else {
                    equityCurve.push({ date: stockHistoryChronological[t].date, value: currentEquity });
                    peakEquity = Math.max(peakEquity, currentEquity);
                    maxDrawdown = Math.max(maxDrawdown, (peakEquity - currentEquity) / peakEquity);
                }

                // Generar Señal Operativa (Sí & Sólo si no hay trade vivo)
                if (!activeTrade && X_features[t-1]) {
                    // Predicción IA
                    const inputTensor = window.tf.tensor3d([X_features[t-1]], [1, windowSize, numFeatures]);
                    const predictionTensor = localModel.predict(inputTensor);
                    const rawProb = Array.from(await predictionTensor.data())[0];
                    const aiProb = calibrateProb(rawProb);
                    
                    // Cleanup temporal tensors de Inferencia
                    inputTensor.dispose();
                    predictionTensor.dispose();

                    // Scoring Cuantitativo (Motor Probabilistico Técnico sin Forward-look)
                    const dayDataObj = stockHistoryChronological[t];
                    const marketRegime = getMarketCondition(dayDataObj.vix || 25);
                    const techEngine = analyzeStockWithMarketCondition(dayDataObj, 'short', marketRegime, null);
                    
                    // La Probabilidad Base la exponíamos al inicio
                    const techProb = techEngine.corto_plazo.techProb || 0.5;

                    // Métrica Probabilística Total (Tech 70% | IA 30% como validación asimétrica)
                    const fusedProb = (techProb * 0.7) + (aiProb * 0.3);

                    if (fusedProb >= threshold) {
                        // Entrada
                        const betSize = currentEquity * 0.99; // Invierte casi todo
                        const qty = betSize / currentPrice;
                        currentEquity -= betSize;
                        
                        activeTrade = {
                            entryDate: dayDataObj.date,
                            entryIndex: t,
                            entryPrice: currentPrice,
                            invSize: betSize,
                            qty: qty,
                            fusedSignal: fusedProb
                        };
                    }
                }
            }
            
            // Liberar tensores masivos del Fold iterador actual
            tensorX.dispose();
            tensorY.dispose();
            localModel.dispose(); // IMPORTANTE (Previene colgar GPU out of memory)
        }

        stepLog.push(`Fold ${fold}: Test [${stockHistoryChronological[testStartIdx].date} a ${stockHistoryChronological[testEndIdx-1].date}] Finalizado.`);
        loopPos += stepSize;
        fold++;
    }

    // Clausura de la última posición si sigue viva
    if (activeTrade) {
        const lastP = prices[prices.length - 1];
        const valFloat = activeTrade.qty * lastP;
        currentEquity += valFloat;
        activeTrade.exitDate = stockHistoryChronological[stockHistoryChronological.length-1].date;
        activeTrade.exitPrice = lastP;
        activeTrade.profitVal = valFloat - activeTrade.invSize;
        activeTrade.profitPct = (lastP - activeTrade.entryPrice) / activeTrade.entryPrice;
        trades.push(activeTrade);
    }

    console.log("[Walk-Forward] Simulación concluida. Procesando Métricas Reales.");

    // MÉTIRCAS ESTRICTAS
    const winningTrades = trades.filter(t => t.profitVal > 0);
    const winRate = trades.length > 0 ? winningTrades.length / trades.length : 0;
    
    let sumReturns = 0;
    trades.forEach(t => sumReturns += t.profitPct);
    const avgReturn = trades.length > 0 ? sumReturns / trades.length : 0;
    
    // Sharpe Ratio simple (Sharpe = AvgReturn / StdDev_Returns)
    let variance = 0;
    if (trades.length > 1) {
        variance = trades.reduce((a, t) => a + Math.pow(t.profitPct - avgReturn, 2), 0) / (trades.length - 1);
    }
    const stdDevRoot = Math.sqrt(variance);
    // Sharpe Anualizado proxy x raiz de approx trades_por_año (asumiendo hold 5 días -> ~50 trades/año)
    const sharpe = stdDevRoot !== 0 ? (avgReturn / stdDevRoot) * Math.sqrt(50) : 0;
    const totalReturn = (currentEquity - capital) / capital;

    return {
        initialCapital: capital,
        finalCapital: currentEquity,
        totalReturn: totalReturn,
        winRate: winRate,
        avgReturn: avgReturn,
        sharpeRatio: isNaN(sharpe) ? 0 : sharpe,
        maxDrawdown: maxDrawdown,
        totalTrades: trades.length,
        trades: trades,
        equityCurve: equityCurve,
        meta: {
            folds: fold - 1,
            windowMode,
            stepLog
        }
    };
}
