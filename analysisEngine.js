// --- Logic para Memoria de Señales ---
const signalMemory = {};

// --- MÓDULO: AI CONFIDENCE ENGINE ---
function analyzeAIPrediction(aiData) {
    if (!aiData) return { bias: "NEUTRAL", strength: 0, usable: false, probability: 0.5 };
    
    // Con la calibración de temperatura en mlModel.js, la prob está suave entre 0 y 1
    const prob = aiData.probability || 0.5;
    
    let bias = "NEUTRAL";
    let usable = false;
    
    if (aiData.confidence >= 55) {
        usable = true;
        if (prob > 0.6) {
            bias = "BULLISH";
        } else if (prob < 0.4) {
            bias = "BEARISH";
        } else {
            usable = false;
        }
    }
    
    return { bias, strength: aiData.confidence / 100, probability: prob, usable };
}

// --- Logic for Recommendations ---

// --- 1. MARKET REGIME ENGINE ---
export function getMarketCondition(vix) {
    if (vix < 20) return 'BULL';
    if (vix > 30) return 'BEAR';
    return 'LATERAL';
}

// --- 2. TIMEFRAME & STRATEGY ENGINE ---
function analyzeTimeframe(data, isLongTerm, regime, strategyMode, portfolioInfo) {
    let factors = { trend: 0, momentum: 0, reversal: 0, macro: 0, risk: 0 };
    let reasons = [];
    let setupDetected = null;

    const addReason = (text, type, weight) => reasons.push({ text, type, weight });

    const price = parseFloat(data.price) || 0;
    const rsi = typeof data.rsi !== 'undefined' ? parseFloat(data.rsi) : 50;
    const macdHist = data.macd && typeof data.macd.histogram !== 'undefined' ? parseFloat(data.macd.histogram) : 0;
    
    const ema20 = parseFloat(data.ema20) || 0;
    const sma50 = parseFloat(data.sma50) || 0;
    const sma200 = parseFloat(data.sma200) || 0;
    const support = parseFloat(data.support) || null;
    const resistance = parseFloat(data.resistance) || null;
    
    // Nuevas variables (Faltantes Críticos abordados)
    const vol = parseFloat(data.volume) || 0;
    const avgVol = parseFloat(data.avgVolume) || 1;
    const rvol = vol / avgVol;
    const atr = parseFloat(data.atr) || (price * 0.02); // Fallback a 2% si falla backend
    
    // History prices for Momentum
    let prices = [];
    if (data.history && data.history.prices && data.history.prices.length >= 5) {
        prices = data.history.prices;
    }
    const p1 = prices.length >= 2 ? parseFloat(prices[prices.length - 2]) : price;
    const p5 = prices.length >= 6 ? parseFloat(prices[prices.length - 6]) : price;
    const recentPct = p1 > 0 ? (price - p1) / p1 : 0;
    const olderPct = p5 > 0 ? (p1 - p5) / p5 : 0;

    // A. STRATEGY ENGINE
    let trendScore = 0;
    let reversalScore = 0;
    let momentumScore = 0;
    let isTrendUp = false;

    // --- TREND LOGIC ---
    if (isLongTerm) {
        if (sma200) {
            if (price > sma200 + atr) {
                trendScore += 5; isTrendUp = true; addReason("Estructura Alcista Confirmada (> SMA200 + 1 ATR).", "positive", 100);
            } else if (price > sma200) {
                trendScore += 3; isTrendUp = true; addReason("Estructura Positiva (> SMA200).", "positive", 90);
            } else {
                trendScore -= 5; addReason("Estructura Bajista (< SMA200).", "negative", 100);
                factors.risk -= 3;
            }
        }
        if (sma50 && sma200 && sma50 > sma200) { 
            trendScore += 2; addReason("Alineación Media Móvil LP (Golden Cross).", "positive", 80); 
        }
        if (recentPct > olderPct && price > p5) { trendScore += 1; }
    } else {
        if (ema20 && price > ema20) {
            trendScore += 4; isTrendUp = true; addReason("Momentum Positivo (> EMA20).", "positive", 90);
        } else if (ema20) {
            trendScore -= 4; addReason("Momentum Quebrado (< EMA20).", "negative", 90);
        }
        if (ema20 && sma50 && ema20 > sma50) {
            trendScore += 2; addReason("Alineación de Corto Alcista.", "positive", 80);
        }
        
        // Pullback detectado en CP validando con ATR
        if (isTrendUp && ema20 && Math.abs(price - ema20) < (atr * 0.5) && recentPct > 0) {
            setupDetected = "PULLBACK_EMA20";
            trendScore += 3;
            addReason("Pullback sano a EMA20 detectado.", "positive", 100);
        }
    }

    // --- BREAKOUT & RVOL LOGIC (Nuevo) ---
    // Si rompe la EMA20 / SMA50 o Resistencia, revisamos Volumen relativo.
    if (!isLongTerm && resistance && price > resistance && p1 <= resistance) {
        if (rvol > 1.5) {
            momentumScore += 5;
            setupDetected = "BREAKOUT_CONFIRMADO";
            addReason(`Breakout válido con Alto Volumen (RVOL: ${rvol.toFixed(1)}x).`, "positive", 110);
        } else {
            // Fakeout detection
            factors.risk -= 5;
            addReason(`Riesgo de Falso Quiebre: Rompió sin volumen (RVOL: ${rvol.toFixed(1)}x).`, "negative", 110);
        }
    }

    // --- REVERSAL LOGIC (Ajustado con ATR) ---
    // Usamos extensión extrema medida en ATR respecto al SMA50
    const extEma50 = sma50 ? (price - sma50) / atr : 0; 
    let isStoppingFall = (!isTrendUp && recentPct > olderPct && olderPct < -0.015);
    
    if (rsi < 30 || extEma50 < -3) {
        reversalScore += 5;
        addReason(isLongTerm ? "Extremo de Sobrevenda LP o Desviación" : "RSI Sobrevendido / Extensión Bajista Profunda.", "positive", 90);
        if (isStoppingFall) {
            setupDetected = isLongTerm ? "DEEP_VALUE_BOTTOM" : "QUICK_REVERSAL_BOUNCE";
            reversalScore += 4;
            addReason("Setup: Frenado de caída en zona extrema.", "positive", 100);
        }
    } else if (rsi > 70 || extEma50 > 3) {
        reversalScore -= 5;
        factors.risk -= 4;
        addReason(isLongTerm ? "Sobrecompra Estructural." : "Extensión Alcista peligrosa (>3 ATRs). Riesgo de Pullback.", "negative", 90);
    } else if (rsi < 40) {
        reversalScore += 2;
    }

    if (support && price < support + atr * 0.5 && price > support - atr * 0.5) {
        reversalScore += 3;
        addReason("Precio testeando área de soporte.", "positive", 80);
    }
    if (resistance && price > resistance - atr * 0.5 && price < resistance + atr * 0.5) {
        reversalScore -= 3;
        factors.risk -= 2;
        addReason("Precio testeando área de resistencia técnica.", "negative", 80);
    }

    // --- MOMENTUM LOGIC ---
    if (macdHist > 0) {
        momentumScore += isLongTerm ? 2 : 4;
    } else if (macdHist < 0) {
        momentumScore -= isLongTerm ? 2 : 4;
    }
    
    if (recentPct > 0 && rvol > 1.2) {
        momentumScore += 3; addReason(`Impulso alcista con participación (RVOL ${rvol.toFixed(1)}).`, "positive", 60);
    } else if (recentPct < 0 && rvol > 1.2) {
        momentumScore -= 4; addReason(`Distribución bajista (Caída con volumen).`, "negative", 80);
    }

    // --- MACRO LOGIC ---
    if (regime === 'BULL') {
        factors.macro = 4;
    } else if (regime === 'BEAR') {
        factors.macro = -4;
        factors.risk -= 3;
    }

    // Adjust by Strategy Mode User Setting
    if (strategyMode === 'trend') {
        trendScore *= 1.5; reversalScore *= 0.5;
    } else if (strategyMode === 'reversal') {
        trendScore *= 0.5; reversalScore *= 1.5;
    }

    factors.trend = trendScore;
    factors.reversal = reversalScore;
    factors.momentum = momentumScore;
    factors.risk = Math.min(0, factors.risk); // Risk is only negative or 0
    
    // Fundamental (Solamente aplica en el largo plazo)
    let fundamentalScore = 0;
    if (isLongTerm) {
        const pe = parseFloat(data.peRatio);
        if (!isNaN(pe) && pe > 0 && pe < 15) { fundamentalScore += 2; }
        if (data.epsGrowth !== 'N/A' && parseFloat(data.epsGrowth) > 5) { fundamentalScore += 2; }
        if (data.roe !== 'N/A' && parseFloat(data.roe) > 15) { fundamentalScore += 1; }
        factors.fundamental = Math.max(0, Math.min(5, fundamentalScore)) * 2;
    } else {
        factors.fundamental = 0;
    }

    // --- DYNAMIC REGIME WEIGHTING (Nuevo) ---
    // Cambiamos los pesos estructurales según el entorno del mercado
    let w;
    if (isLongTerm) {
        if (regime === 'BULL') w = { trend: 0.40, mom: 0.10, rev: 0.05, macro: 0.25, risk: 0.10, fund: 0.10 };
        else if (regime === 'BEAR') w = { trend: 0.15, mom: 0.05, rev: 0.25, macro: 0.25, risk: 0.20, fund: 0.10 };
        else w = { trend: 0.30, mom: 0.15, rev: 0.10, macro: 0.25, risk: 0.10, fund: 0.10 };
    } else {
        if (regime === 'BULL') w = { trend: 0.35, mom: 0.35, rev: 0.10, risk: 0.15, macro: 0.05, fund: 0 };
        else if (regime === 'BEAR') w = { trend: 0.10, mom: 0.10, rev: 0.40, risk: 0.35, macro: 0.05, fund: 0 };
        else w = { trend: 0.25, mom: 0.30, rev: 0.30, risk: 0.10, macro: 0.05, fund: 0 };
    }

    // Score Crudo
    const rawScoreSum = (factors.trend * w.trend) + (factors.momentum * w.mom) + (factors.reversal * w.rev) + 
                        (factors.macro * w.macro) + (factors.risk * w.risk) + (factors.fundamental * w.fund);

    // Score Normalizado anti-saturación (0 a 1 prob proxy)
    // Con divisor 5, un rawScoreSum de +7 da un techProb de ~0.94 (muy alto)
    // Un rawScoreSum de 0 da 0.5 (Neutral)
    const techProb = (Math.tanh(rawScoreSum / 5) + 1) / 2;

    reasons.sort((a, b) => b.weight - a.weight);

    // Mapear probabilidad a String clásico y Score flotante redondeado
    const localScore = (techProb * 20) - 10;
    let localSignal = "NEUTRAL / NO OPERAR";
    if (localScore >= 6.5) localSignal = "COMPRA FUERTE";
    else if (localScore >= 3.5) localSignal = "COMPRA";
    else if (localScore >= 1.5) localSignal = "PRE-COMPRA";
    else if (localScore >= -1.5) localSignal = "OBSERVAR";
    else if (localScore > -4.5) localSignal = "DEBIL / ALERTA";
    else localSignal = "VENTA";

    return { 
        techProb: techProb, 
        signal: localSignal,
        score: Number(localScore.toFixed(1)),
        factors, 
        reasons, 
        setupDetected 
    };
}

export function analyzeStockWithMarketCondition(data, termIgnored, marketCondition = 'SIDEWAYS', portfolioInfo = null) {
    const strategyMode = window.strategyMode || 'hybrid';
    
    const cp = analyzeTimeframe(data, false, marketCondition, strategyMode, portfolioInfo);
    const lp = analyzeTimeframe(data, true, marketCondition, strategyMode, portfolioInfo);
    
    // Conflicto Clave (CP alcista vs LP bajista, etc)
    let isConflict = false;
    let conflictMsg = null;
    const cpBull = cp.techProb > 0.6;
    const cpBear = cp.techProb < 0.4;
    const lpBull = lp.techProb > 0.6;
    const lpBear = lp.techProb < 0.4;
    
    if (cpBull && lpBear) {
        isConflict = true;
        conflictMsg = "Corto plazo alcista, largo plazo bajista (Riesgo).";
    } else if (cpBear && lpBull) {
        isConflict = true;
        conflictMsg = "Largo plazo alcista, corto plazo bajista (Oportunidad Oculta).";
    }
    
    // Fusión Ponderada CP/LP (60/40) para Prior Base
    const priorProb = (cp.techProb * 0.6) + (lp.techProb * 0.4);
    
    // --- INTEGRACIÓN BAYESIANA IA CONFIDENCE ENGINE ---
    const aiData = (window.aiPredictionCache && window.aiPredictionCache[data.symbol]) ? window.aiPredictionCache[data.symbol] : null;
    const aiContext = analyzeAIPrediction(aiData);
    
    let posteriorProb = priorProb;
    
    if (aiContext.usable) {
        // Transformar prior de Prob a Odds
        // Evitamos división por 0 saturando con eps
        const priorOdds = Math.max(1e-5, priorProb) / Math.max(1e-5, 1 - priorProb);
        
        // AI Probability
        const aiProb = aiContext.probability;
        const aiLikelihood = Math.max(1e-5, aiProb) / Math.max(1e-5, 1 - aiProb);
        
        // Bayes Simplificado: Posterior Odds = Prior Odds * Likelihood
        const posteriorOdds = priorOdds * aiLikelihood;
        
        // Regreso a Probability
        posteriorProb = posteriorOdds / (1 + posteriorOdds);
    }
    
    // Transformación final para UI (score de -10 a 10)
    let finalScore = (posteriorProb * 20) - 10;
    
    // Manejo de Portafolio (Trailing Stop dinámico con ATR)
    let actionFlag = null;
    let trailingReason = null;
    const atr = parseFloat(data.atr) || (data.price * 0.02);
    
    if (portfolioInfo && data.price) {
        const currentReturn = (data.price - portfolioInfo.entryPrice) / portfolioInfo.entryPrice;
        // Drawdown vs Peak ajustado por ATR en lugar de un % estático
        const distToPeak = portfolioInfo.highestPrice - data.price;
        
        if (currentReturn < -0.05) { 
            actionFlag = "STOP_LOSS"; 
            finalScore = -10; 
            trailingReason = { text: "Stop Loss de portafolio alcanzado.", type: "negative", weight: 200 };
        } else if (distToPeak > atr * 2 && currentReturn > 0.05) { 
            // Cierra posición si cayói más de 2 ATRs desde la cima y estamos en buenas ganancias
            actionFlag = "TAKE_PROFIT"; 
            finalScore = -10; 
            trailingReason = { text: "Trailing Stop asegurando ganancia (> 2 ATR caída).", type: "negative", weight: 200 };
        }
    }

    finalScore = Math.max(-10, Math.min(10, finalScore));

    let signal = "NEUTRAL / NO OPERAR";
    if (finalScore >= 6.5) signal = "COMPRA FUERTE";
    else if (finalScore >= 3.5) signal = "COMPRA";
    else if (finalScore >= 1.5) signal = "PRE-COMPRA";
    else if (finalScore >= -1.5) signal = "OBSERVAR";
    else if (finalScore > -4.5) signal = "DEBIL / ALERTA";
    else signal = "VENTA";

    const isTechBuy = signal.includes("COMPRA");
    const isTechSell = signal.includes("VENTA") || signal.includes("DEBIL");
    let confirmationLevel = "SIN CONFIRMACIÓN IA";

    if (aiContext.usable) {
        if (isTechBuy && aiContext.bias === "BULLISH") {
            confirmationLevel = "ALTA CONFIANZA";
        } else if (isTechBuy && aiContext.bias === "BEARISH") {
            confirmationLevel = "CONFLICTO";
            isConflict = true;
            conflictMsg = (conflictMsg ? conflictMsg + " | " : "") + "IA detecta patrón Bajista en setup de Compra.";
        } else if (isTechSell && aiContext.bias === "BEARISH") {
            confirmationLevel = "ALTA CONFIANZA";
        } else if (isTechSell && aiContext.bias === "BULLISH") {
            confirmationLevel = "CONFLICTO";
            isConflict = true;
            conflictMsg = (conflictMsg ? conflictMsg + " | " : "") + "IA detecta patrón Alcista en setup de Venta.";
        } else {
            confirmationLevel = "NEUTRAL";
        }
    }

    const stateKey = `${data.symbol}_master`;
    signalMemory[stateKey] = { signal, score: finalScore };

    let combinedReasons = [];
    if (trailingReason) combinedReasons.push(trailingReason);
    if (isConflict) combinedReasons.push({ text: `CONFLICTO: ${conflictMsg}`, type: "neutral", weight: 150 });
    
    combinedReasons = combinedReasons.concat(cp.reasons.slice(0,2)).concat(lp.reasons.slice(0,2));
    const finalSetup = cp.setupDetected || lp.setupDetected;
    
    // Mapeamos el score redondeado por seguridad
    cp.score = Number(cp.score.toFixed(1));
    lp.score = Number(lp.score.toFixed(1));

    return { 
        corto_plazo: cp,
        largo_plazo: lp,
        señal_final: signal, 
        signal: signal,      
        score: Number(finalScore.toFixed(1)), 
        confianza: posteriorProb * 100, // Direct Probability as confidence
        contexto_mercado: marketCondition,
        conflicto: isConflict ? conflictMsg : null,
        factors: cp.factors,
        reasons: combinedReasons,
        setupDetected: finalSetup,
        actionFlag,
        ai: aiContext,
        confirmationLevel
    };
}
