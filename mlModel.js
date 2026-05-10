// Módulo de Inteligencia Artificial (TensorFlow.js)
// Motor Predictivo Avanzado: Ensemble 1D CNN + Validación Walk-Forward OOS

function buildCNNModel(windowSize, numFeatures) {
    if (!window.tf) return null;
    const model = window.tf.sequential();
    const kInit = () => window.tf.initializers.glorotUniform();
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

function calibrateProb(rawProb) {
    const T = 1.35; 
    const pSafe = Math.max(1e-7, Math.min(1 - 1e-7, rawProb));
    const logit = Math.log(pSafe / (1 - pSafe));
    return 1 / (1 + Math.exp(-logit / T));
}

// Retorna prom y std dev
function calcEnsembleStats(arr) {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    let variance = 0;
    if (arr.length > 1) {
        variance = arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (arr.length - 1);
    }
    return { mean, dev: Math.sqrt(variance) };
}

// =========================================
// HELPER: Entrena y evalua un fold del WF
// (función separada para evitar problemas de scope async)
// =========================================
async function trainAndEvalFold(x_fold, y_fold, X_features, testStartIdx, testEndIdx, windowSize, numFeatures, horizon, wfTrades, prices) {
    const tX = window.tf.tensor3d(x_fold, [x_fold.length, windowSize, numFeatures]);
    const tY = window.tf.tensor1d(y_fold);
    const wfModel = buildCNNModel(windowSize, numFeatures);
    
    if (!wfModel) {
        tX.dispose();
        tY.dispose();
        return;
    }

    await wfModel.fit(tX, tY, { epochs: 10, verbose: 0 });

    // Prediccion OOS (Out-of-Sample)
    let activeTrade = null;
    for (let t = testStartIdx; t < testEndIdx; t++) {
        if (activeTrade && (t - activeTrade.entryIndex >= horizon)) {
            activeTrade.exitPrice = prices[t];
            activeTrade.profitPct = (activeTrade.exitPrice - activeTrade.entryPrice) / activeTrade.entryPrice;
            wfTrades.push(activeTrade);
            activeTrade = null;
        }

        const featIdx = t - windowSize;
        if (!activeTrade && X_features[featIdx]) {
            const inputTensor = window.tf.tensor3d([X_features[featIdx]], [1, windowSize, numFeatures]);
            const pred = wfModel.predict(inputTensor);
            const prob = calibrateProb(Array.from(await pred.data())[0]);
            pred.dispose();
            inputTensor.dispose();

            if (prob >= 0.6) {
                activeTrade = { entryIndex: t, entryPrice: prices[t] };
            }
        }
    }
    if (activeTrade) {
        activeTrade.exitPrice = prices[testEndIdx - 1];
        activeTrade.profitPct = (activeTrade.exitPrice - activeTrade.entryPrice) / activeTrade.entryPrice;
        wfTrades.push(activeTrade);
    }

    tX.dispose();
    tY.dispose();
    wfModel.dispose();
}

// =========================================
// FUNCIÓN PRINCIPAL EXPORTADA
// =========================================
export async function runAIPrediction(stockData) {
    if (!window.tf) return { error: "TensorFlow.js no está disponible." };
    
    let prices = [];
    if (stockData.history && stockData.history.prices && Array.isArray(stockData.history.prices)) {
        prices = stockData.history.prices.map(p => parseFloat(p));
    }
    
    const windowSize = 20; 
    const horizon = 5;     
    const targetThreshold = 0.02; // +2% en 5 dias
    const minDaysRequired = windowSize + horizon + 60;
    
    if (prices.length < minDaysRequired) {
        return { error: `Datos insuficientes. El motor Ensemble+WF requiere al menos ${minDaysRequired} días.` };
    }
    
    // ==========================================
    // 1. Feature Engineering
    // ==========================================
    const numFeatures = 2;
    const logReturns = [0];
    const rollingVol = [0];
    const volWindow = 5;

    for (let i = 1; i < prices.length; i++) {
        logReturns.push(Math.log(prices[i] / prices[i - 1]));
        if (i < volWindow) {
            rollingVol.push(Math.abs(logReturns[i]));
        } else {
            const slice = logReturns.slice(i - volWindow + 1, i + 1);
            const mean = slice.reduce((a, b) => a + b, 0) / volWindow;
            const vol = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / volWindow);
            rollingVol.push(vol);
        }
    }

    const X_features = [];
    for (let i = windowSize; i < prices.length; i++) {
        const featMap = [];
        for (let j = 0; j < windowSize; j++) {
            const idx = i - windowSize + 1 + j;
            featMap.push([logReturns[idx], rollingVol[idx]]);
        }
        X_features.push(featMap);
    }

    // ==========================================
    // 2. INTERNAL MINI WALK-FORWARD BACKTEST
    // ==========================================
    const wfFolds = 3;
    const testSize = 20; 
    const wfTrades = [];
    
    let loopPos = prices.length - (wfFolds * testSize);
    
    for (let f = 0; f < wfFolds; f++) {
        await new Promise(r => setTimeout(r, 5)); // No colgar UI
        const testStartIdx = loopPos;
        const testEndIdx = testStartIdx + testSize;
        
        const x_fold = [];
        const y_fold = [];
        for (let t = windowSize; t < testStartIdx - horizon; t++) {
            const featIdx = t - windowSize; // X_features[0] = feature para precio[windowSize]
            if (!X_features[featIdx]) continue;
            x_fold.push(X_features[featIdx]);
            const pCurrent = prices[t];
            const pFuture = prices[t + horizon];
            y_fold.push(Math.log(pFuture / pCurrent) > targetThreshold ? 1 : 0);
        }
        
        if (x_fold.length > 0) {
            await trainAndEvalFold(x_fold, y_fold, X_features, testStartIdx, testEndIdx, windowSize, numFeatures, horizon, wfTrades, prices);
        }
        loopPos += testSize;
    }

    // ==========================================
    // Calcular Métricas OOS
    // ==========================================
    const winningTrades = wfTrades.filter(t => t.profitPct > 0).length;
    const wfWinRate = wfTrades.length > 0 ? winningTrades / wfTrades.length : 0;
    const wfAvgReturn = wfTrades.length > 0 ? (wfTrades.reduce((a, b) => a + b.profitPct, 0) / wfTrades.length) : 0;
    
    let wfVar = 0;
    if (wfTrades.length > 1) {
        wfVar = wfTrades.reduce((a, t) => a + Math.pow(t.profitPct - wfAvgReturn, 2), 0) / (wfTrades.length - 1);
    }
    const wfSharpe = (wfVar !== 0 && !isNaN(Math.sqrt(wfVar))) ? (wfAvgReturn / Math.sqrt(wfVar)) * Math.sqrt(50) : 0;

    // ==========================================
    // 3. ENSEMBLE ACTUAL (Para Inferencia de Hoy)
    // ==========================================
    const fullX = [];
    const fullY = [];
    for (let t = windowSize; t < prices.length - horizon; t++) {
        const featIdx = t - windowSize;
        if (!X_features[featIdx]) continue;
        fullX.push(X_features[featIdx]);
        const pC = prices[t];
        const pF = prices[t + horizon];
        fullY.push(Math.log(pF / pC) > targetThreshold ? 1 : 0);
    }
    
    let probHistory = [];
    const ensModelsCount = 3;
    const tXFull = window.tf.tensor3d(fullX, [fullX.length, windowSize, numFeatures]);
    const tYFull = window.tf.tensor1d(fullY);

    for (let m = 0; m < ensModelsCount; m++) {
        await new Promise(r => setTimeout(r, 5));
        const model = buildCNNModel(windowSize, numFeatures);
        if (!model) continue;
        await model.fit(tXFull, tYFull, { epochs: 15, verbose: 0 });
        
        const recentInput = X_features[X_features.length - 1]; // Último vector de features disponible
        if (!recentInput || recentInput.length !== windowSize) continue;
        const inputTensor = window.tf.tensor3d([recentInput], [1, windowSize, numFeatures]);
        const predictionTensor = model.predict(inputTensor);
        const rawProb = Array.from(await predictionTensor.data())[0];
        
        probHistory.push(calibrateProb(rawProb));
        
        inputTensor.dispose();
        predictionTensor.dispose();
        model.dispose();
    }
    tXFull.dispose();
    tYFull.dispose();

    const { mean: finalProb, dev: uncertainty } = calcEnsembleStats(probHistory);
    const confidence = Math.min(100, Math.abs(finalProb - 0.5) * 200);

    // 4. GENERACIÓN DE TEXTO
    const recentVol = rollingVol.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const recentRet = logReturns.slice(-5).reduce((a, b) => a + b, 0);
    let thought = "";
    
    if (finalProb > 0.6) {
        thought = `🔍 ENSEMBLE [3 Redes]: Predicción Alcista.\nIncertidumbre (Varianza Modelos): ${(uncertainty * 100).toFixed(1)}%\n\nEl ensamble detectó ${recentRet > 0 ? 'continuación institucional' : 'rebote de piso'} c/ volatilidad del ${(recentVol * 100).toFixed(2)}%.\nWalk-Forward OOS WinRate: ${(wfWinRate * 100).toFixed(1)}% (Avg Ret: ${(wfAvgReturn * 100).toFixed(2)}%)`;
    } else if (finalProb < 0.4) {
        thought = `🔍 ENSEMBLE [3 Redes]: Predicción Bajista.\nIncertidumbre (Varianza Modelos): ${(uncertainty * 100).toFixed(1)}%\n\nRiesgo de ${recentRet < 0 ? 'distribución bajista continua' : 'fallo de cúpula'} bajo régimen de vol. ${(recentVol * 100).toFixed(2)}%.\nWalk-Forward OOS WinRate: ${(wfWinRate * 100).toFixed(1)}%`;
    } else {
        thought = `🔍 ENSEMBLE [3 Redes]: Incierto / Random.\nIncertidumbre (Varianza Modelos): ${(uncertainty * 100).toFixed(1)}%\n\nLas redes difieren. Estructura ambigua, mejor abstenerse.\nWF WinRate en esta zona: ${(wfWinRate * 100).toFixed(1)}%`;
    }

    return { 
        probability: finalProb, 
        confidence: confidence, 
        uncertainty: uncertainty,
        daysTrained: prices.length,
        thought: thought,
        backtest: {
            winRate: wfWinRate,
            avgReturn: wfAvgReturn,
            sharpe: isNaN(wfSharpe) ? 0 : wfSharpe
        }
    };
}
