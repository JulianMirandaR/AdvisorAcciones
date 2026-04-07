// --- Analysis Logic ---
// (Note: `stocks` array and `generateStockData` removed as requested)
import { RealDataService, auth, db } from './realData.js';
import { runAIPrediction } from './mlModel.js';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";

// Helper to keep track of chart instances (moved to top to avoid initialization errors)
const chartInstances = {};

// --- Logic para Memoria de Señales ---
const signalMemory = {};
let strategyMode = 'hybrid'; // "trend", "reversal", "hybrid"

window.setStrategyMode = (mode) => {
    strategyMode = mode;
    if (typeof refreshUI === 'function') refreshUI();
};

window.aiPredictionCache = {};

window.predictAI = async (symbol) => {
    const stockData = globalStocksData.find(s => s.symbol === symbol);
    if (!stockData) return;
    
    const btn = document.getElementById(`btn-ai-${symbol}`);
    const originalText = btn.innerHTML;

    if (window.aiPredictionCache[symbol]) {
        refreshUI();
        return;
    }
    
    btn.innerHTML = '⚙️ Pensando...';
    btn.disabled = true;
    
    try {
        const result = await runAIPrediction(stockData);
        if (result.error) {
            alert(result.error);
        } else {
            window.aiPredictionCache[symbol] = result;
            refreshUI(); // Refresca UI para mostrar el Badge IA y recalcular el Score
        }
    } catch (e) {
        console.error("AI Error:", e);
        alert("Hubo un error calculando con IA: " + e.message);
    } finally {
        if (btn) {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }
};

// --- MÓDULO: AI CONFIDENCE ENGINE ---
function analyzeAIPrediction(aiData) {
    if (!aiData) return { bias: "NEUTRAL", strength: 0, usable: false };
    
    let bias = "NEUTRAL";
    let strength = 0;
    let usable = false;
    
    if (aiData.confidence >= 55) {
        usable = true;
        strength = aiData.confidence / 100;
        
        const probPct = aiData.probability * 100;
        if (probPct > 60) {
            bias = "BULLISH";
        } else if (probPct < 40) {
            bias = "BEARISH";
        } else {
            bias = "NEUTRAL";
            usable = false;
        }
    }
    
    return { bias, strength, usable };
}

// --- Logic for Recommendations ---

// --- 1. MARKET REGIME ENGINE ---
function getMarketCondition(vix) {
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
    
    // Simular EMA9 con un cruce veloz respecto a EMA20 si no existe
    const ema20 = parseFloat(data.ema20) || 0;
    const sma50 = parseFloat(data.sma50) || 0;
    const sma200 = parseFloat(data.sma200) || 0;
    const support = parseFloat(data.support) || null;
    const resistance = parseFloat(data.resistance) || null;
    
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
        // Largo Plazo: basarse pesadamente en SMA200 y SMA50
        if (sma200) {
            if (price > sma200 * 1.05) {
                trendScore += 5; isTrendUp = true; addReason("Tendencia Estructural Alcista Confirmada (P > SMA200+5%).", "positive", 100);
            } else if (price > sma200) {
                trendScore += 3; isTrendUp = true; addReason("Tendencia Estructural Positiva (P > SMA200).", "positive", 90);
            } else {
                trendScore -= 5; addReason("Estructura Bajista LP (P < SMA200).", "negative", 100);
                factors.risk -= 3;
            }
        }
        if (sma50 && sma200) {
            if (sma50 > sma200) { trendScore += 2; addReason("Alineación Media Móvil LP (Golden Cross proxy).", "positive", 80); }
            else { trendScore -= 2; }
        }
        
        // Estructura de máximos (usando simple momentum array)
        if (recentPct > olderPct && price > p5) { trendScore += 1; }
    } else {
        // Corto Plazo: basarse en EMA impulsivas
        if (ema20 && price > ema20) {
            trendScore += 4; isTrendUp = true; addReason("Momentum CP Positivo (P > EMA20).", "positive", 90);
        } else if (ema20) {
            trendScore -= 4; addReason("Momentum CP Quebrado (P < EMA20).", "negative", 90);
        }
        if (ema20 && sma50 && ema20 > sma50) {
            trendScore += 2; addReason("Alineación de Corto Alcista.", "positive", 80);
        }
        
        // Pullback detectado en CP
        if (isTrendUp && ema20 && Math.abs((price - ema20) / ema20) < 0.015 && recentPct > 0) {
            setupDetected = "PULLBACK_EMA20";
            trendScore += 3;
            addReason("Pullback a EMA20 detectado. Continuación probable.", "positive", 100);
        }
    }

    // --- REVERSAL LOGIC ---
    let isStoppingFall = (!isTrendUp && recentPct > olderPct && olderPct < -0.015);
    
    if (rsi < 30) {
        reversalScore += 5;
        addReason(isLongTerm ? "Extremo de Sobrevenda LP (RSI < 30)" : "RSI Rápido Sobrevendido.", "positive", 90);
        if (isStoppingFall) {
            setupDetected = isLongTerm ? "DEEP_VALUE_BOTTOM" : "QUICK_REVERSAL_BOUNCE";
            reversalScore += 4;
            addReason("Setup: Frenado de caída con RSI crítico detectado.", "positive", 100);
        }
    } else if (rsi > 70) {
        reversalScore -= 5;
        factors.risk -= 4;
        addReason(isLongTerm ? "Sobrecompra Estructural (RSI > 70)." : "RSI Rápido Sobrecomprado. Riesgo Pullback.", "negative", 90);
    } else if (rsi < 40) {
        reversalScore += 2; // Ligero valor
    }

    if (support && Math.abs((price - support) / price) < 0.02) {
        reversalScore += 3;
        addReason("Precio testeando soporte histórico.", "positive", 80);
    }
    if (resistance && Math.abs((price - resistance) / price) < 0.02) {
        reversalScore -= 3;
        factors.risk -= 2;
        addReason("Precio golpeando resistencia técnica.", "negative", 80);
    }

    // --- MOMENTUM LOGIC ---
    if (macdHist > 0) {
        momentumScore += isLongTerm ? 2 : 4;
        addReason("MACD Histograma Alcista.", "positive", 70);
    } else if (macdHist < 0) {
        momentumScore -= isLongTerm ? 2 : 4;
    }
    
    if (recentPct > 0 && recentPct > olderPct) {
        momentumScore += 3; addReason("Aceleración de precios.", "positive", 60);
    } else if (recentPct < 0 && recentPct < olderPct) {
        momentumScore -= 3;
    }

    // --- MACRO LOGIC ---
    if (regime === 'BULL') {
        factors.macro = 4;
        addReason("Regimen BULL favorece compras.", "positive", 50);
    } else if (regime === 'BEAR') {
        factors.macro = -4;
        factors.risk -= 3;
        addReason("Regimen BEAR: Alto riesgo en compras no-reversales.", "negative", 50);
    }

    // --- NEWS LOGIC ---
    if (typeof data.newsSentiment !== 'undefined' && data.newsSentiment !== 0) {
        if (data.newsSentiment > 0) {
            momentumScore += isLongTerm ? data.newsSentiment / 2 : data.newsSentiment;
            const boostStr = data.newsSentiment >= 2 ? "Fuerte" : "Ligero";
            addReason(`Impulso ${boostStr} por Noticias Recientes Positivas.`, "positive", 65 + (data.newsSentiment * 2));
        } else {
            momentumScore += isLongTerm ? data.newsSentiment / 2 : data.newsSentiment;
            const penStr = data.newsSentiment <= -2 ? "Fuerte" : "Ligero";
            addReason(`Rechazo ${penStr} por Noticias Recientes Negativas.`, "negative", 65 + (Math.abs(data.newsSentiment) * 2));
        }
    }

    // Adjust by Strategy Mode User Setting
    if (strategyMode === 'trend') {
        trendScore *= 1.5; reversalScore *= 0.5;
    } else if (strategyMode === 'reversal') {
        trendScore *= 0.5; reversalScore *= 1.5;
    }

    // Assign final raw metrics
    factors.trend = Math.max(-10, Math.min(10, trendScore));
    factors.reversal = Math.max(-10, Math.min(10, reversalScore));
    factors.momentum = Math.max(-10, Math.min(10, momentumScore));
    factors.risk = Math.max(-10, Math.min(0, factors.risk)); // Risk is only negative or 0
    
    // FASE 4: Fundamental Score Logic
    let fundamentalScoreRaw = 0;
    if (isLongTerm) {
        const pe = parseFloat(data.peRatio);
        if (!isNaN(pe) && pe > 0 && pe < 15) { fundamentalScoreRaw += 2; addReason("PER Atractivo (< 15).", "positive", 60); }
        if (data.epsGrowth !== 'N/A' && parseFloat(data.epsGrowth) > 5) { fundamentalScoreRaw += 2; addReason("Fuerte Crecimiento EPS.", "positive", 60); }
        if (data.roe !== 'N/A' && parseFloat(data.roe) > 15) { fundamentalScoreRaw += 1; addReason("Alta Rentabilidad (ROE > 15%).", "positive", 50); }
    }
    const fundamentalScore = Math.max(0, Math.min(5, fundamentalScoreRaw)) * 2; // scale to 10
    factors.fundamental = isLongTerm ? fundamentalScore : 0;

    // 3. SCORING ENGINE (NIVEL PROFESIONAL)
    let finalScoreRaw = 0;
    if (isLongTerm) {
        // Largo Plazo (Actualizado con Fundamentales 10%): 
        // 30% Trend, 15% Mom, 10% Rev, 25% Macro, 10% Risk, 10% Fundamental
        finalScoreRaw = (factors.trend * 0.30) + (factors.momentum * 0.15) + (factors.reversal * 0.10) + (factors.macro * 0.25) + (factors.risk * 0.10) + (factors.fundamental * 0.10);
    } else {
        // Corto Plazo: 25% Trend, 30% Mom, 30% Rev, 5% Macro, 10% Risk
        finalScoreRaw = (factors.trend * 0.25) + (factors.momentum * 0.30) + (factors.reversal * 0.30) + (factors.macro * 0.05) + (factors.risk * 0.10);
    }

    // Expand slightly to fit [-10, 10] range effectively
    finalScoreRaw = finalScoreRaw * 1.5;
    let score = Math.max(-10, Math.min(10, finalScoreRaw));

    let signal = "NEUTRAL / NO OPERAR";
    if (score >= 8) signal = "COMPRA FUERTE";
    else if (score >= 6) signal = "COMPRA";
    else if (score >= 4) signal = "PRE-COMPRA";
    else if (score >= 2) signal = "OBSERVAR";
    else if (score >= -2) signal = "NEUTRAL / NO OPERAR";
    else if (score >= -4) signal = "DEBIL / ALERTA";
    else signal = "VENTA";

    reasons.sort((a, b) => b.weight - a.weight);

    return { signal, score: Number(score.toFixed(1)), factors, reasons, setupDetected };
}

// Reemplazo exacto del orquestador anterior usando la firma requerida
function analyzeStockWithMarketCondition(data, termIgnored, marketCondition = 'SIDEWAYS', portfolioInfo = null) {
    const cp = analyzeTimeframe(data, false, marketCondition, strategyMode, portfolioInfo);
    const lp = analyzeTimeframe(data, true, marketCondition, strategyMode, portfolioInfo);
    
    // Conflicto Clave
    let isConflict = false;
    let conflictMsg = null;
    const cpBull = cp.score >= 4;
    const cpBear = cp.score <= -2;
    const lpBull = lp.score >= 4;
    const lpBear = lp.score <= -2;
    
    if (cpBull && lpBear) {
        isConflict = true;
        conflictMsg = "Corto plazo alcista, largo plazo bajista (Riesgo).";
    } else if (cpBear && lpBull) {
        isConflict = true;
        conflictMsg = "Largo plazo alcista, corto plazo bajista (Oportunidad).";
    }
    
    // Scoring combinado. CP tira un 60%, LP 40%.
    let finalScore = (cp.score * 0.6) + (lp.score * 0.4);
    
    // --- INTEGRACIÓN: AI CONFIDENCE ENGINE ---
    const aiData = window.aiPredictionCache[data.symbol] || null;
    const aiContext = analyzeAIPrediction(aiData);
    
    if (aiContext.usable) {
        if (aiContext.bias === "BULLISH") {
            finalScore += 0.5 * aiContext.strength;
        } else if (aiContext.bias === "BEARISH") {
            finalScore -= 0.5 * aiContext.strength;
        }
    }
    
    // Manejo de Portafolio
    let actionFlag = null;
    let trailingReason = null;
    if (portfolioInfo && data.price) {
        const currentReturn = (data.price - portfolioInfo.entryPrice) / portfolioInfo.entryPrice;
        const trailingDrawdown = (portfolioInfo.highestPrice - data.price) / portfolioInfo.highestPrice;
        
        if (currentReturn < -0.05) { 
            actionFlag = "STOP_LOSS"; 
            finalScore -= 5; 
            trailingReason = { text: "Stop Loss de portafolio alcanzado.", type: "negative", weight: 200 };
        } else if (trailingDrawdown > 0.03 && currentReturn > 0.05) { 
            actionFlag = "TAKE_PROFIT"; 
            finalScore -= 3; 
            trailingReason = { text: "Trailing Stop asegurando ganancia.", type: "negative", weight: 200 };
        }
    }

    finalScore = Math.max(-10, Math.min(10, finalScore));

    let signal = "NEUTRAL / NO OPERAR";
    if (finalScore >= 8) signal = "COMPRA FUERTE";
    else if (finalScore >= 6) signal = "COMPRA";
    else if (finalScore >= 4) signal = "PRE-COMPRA";
    else if (finalScore >= 2) signal = "OBSERVAR";
    else if (finalScore >= -2) signal = "NEUTRAL / NO OPERAR";
    else if (finalScore >= -4) signal = "DEBIL / ALERTA";
    else signal = "VENTA";

    // --- SISTEMA DE CONFIRMACIONES IA ---
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
    
    // Mezclamos un par de razones de CP y LP para la UI
    combinedReasons = combinedReasons.concat(cp.reasons.slice(0,2)).concat(lp.reasons.slice(0,2));

    const finalSetup = cp.setupDetected || lp.setupDetected;

    return { 
        corto_plazo: cp,
        largo_plazo: lp,
        señal_final: signal, // Exact match to prompt
        signal: signal,      // Compatibility backward match
        score: Number(finalScore.toFixed(1)), // Compatibility
        confianza: Math.min(100, Math.max(0, 50 + (finalScore * 5))),
        contexto_mercado: marketCondition,
        conflicto: isConflict ? conflictMsg : null,
        factors: { 
            trend: lp.factors.trend, 
            momentum: cp.factors.momentum, 
            reversal: cp.factors.reversal 
        }, // Fallback for old UI
        reasons: combinedReasons,
        setupDetected: finalSetup,
        actionFlag,
        ai: aiContext,
        confirmationLevel
    };
}

// --- UI Rendering ---

const container = document.getElementById('recommendations-container');
const portfolioContainer = document.getElementById('portfolio-container');
const controlsContainer = document.querySelector('.controls-container');
const tabs = document.querySelectorAll('.tab-btn');
const marketStatus = document.getElementById('marketStatus');

let currentTerm = 'all'; // 'all', 'short', 'long'
const realDataService = new RealDataService();

// Global container state
// Global container state
let globalStocksData = []; // To keep track for re-sorting
let globalMacroData = null; // Macroeconomic data (Buffett Indicator)
let globalCclHistory = null; // Historical CCL Data
let activeFilter = 'all'; // all, buy, hold, sell, favorites
let searchTerm = '';
let watchlist = JSON.parse(localStorage.getItem('advisor_watchlist') || '[]');
let portfolio = JSON.parse(localStorage.getItem('advisor_portfolio') || '[]');

let closedTrades = JSON.parse(localStorage.getItem('advisor_closed_trades') || '[]');
const historialContainer = document.getElementById('historial-container');

window.portfolioTerm = 'short'; // Plazo por defecto en la pestaña Mi Portafolio

// --- SISTEMA DE NOTIFICACIONES Y ALERTAS ---
window.notifications = JSON.parse(localStorage.getItem('advisor_notifications') || '[]');
window.lastKnownSignals = JSON.parse(localStorage.getItem('advisor_last_signals') || '{}');
window.priceAlerts = JSON.parse(localStorage.getItem('advisor_price_alerts') || '[]');
window.cloudSynced = false;

window.toggleNotifications = () => {
    const dropdown = document.getElementById('notifDropdown');
    if (!dropdown) return;
    dropdown.classList.toggle('show');
    if (dropdown.classList.contains('show')) {
        window.renderNotifications();
        // Clear badge when viewing
        const badge = document.getElementById('notifBadge');
        if (badge) {
            badge.style.display = 'none';
            badge.textContent = '0';
        }
    }
};

window.addNotification = (message, type = 'info') => {
    const now = new Date();
    window.notifications.unshift({
        id: now.getTime(),
        message,
        type,
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + now.toLocaleDateString()
    });
    
    // Keep only last 20
    if (window.notifications.length > 20) {
        window.notifications = window.notifications.slice(0, 20);
    }
    
    localStorage.setItem('advisor_notifications', JSON.stringify(window.notifications));
    
    // Update badge visually if dropdown is not open
    const dropdown = document.getElementById('notifDropdown');
    if (!dropdown || !dropdown.classList.contains('show')) {
        const badge = document.getElementById('notifBadge');
        if (badge) {
            let count = parseInt(badge.textContent) || 0;
            badge.textContent = count + 1;
            badge.style.display = 'inline-block';
        }
    } else {
        window.renderNotifications();
    }
};

window.renderNotifications = () => {
    const body = document.getElementById('notifBody');
    if (!body) return;
    
    if (window.notifications.length === 0) {
        body.innerHTML = '<div class="notif-empty">No tienes notificaciones aún.</div>';
        return;
    }
    
    body.innerHTML = window.notifications.map(n => `
        <div class="notif-item ${n.type}">
            ${n.message}
            <span class="notif-time">${n.time}</span>
        </div>
    `).join('');
};

function checkNotifications() {
    const vix = globalMacroData && globalMacroData.vix ? globalMacroData.vix : 25;
    const marketCondition = getMarketCondition(vix);
    
    let hasChanges = false;
    
    globalStocksData.forEach(stock => {
        const portfolioPos = portfolio.find(p => p.symbol === stock.symbol);
        const portfolioInfo = portfolioPos ? { entryPrice: portfolioPos.price, highestPrice: portfolioPos.highestPrice } : null;
        
        // Use default analysis logic
        const analysis = analyzeStockWithMarketCondition(stock, 'all', marketCondition, portfolioInfo);
        const sig = analysis.signal;
        const currentAction = analysis.actionFlag || sig;
        const prevSignal = window.lastKnownSignals[stock.symbol];
        
        // 1. Accion comprada (en portfolio) da para venta
        if (portfolioPos) {
            // Signal cambió a venta?
            if ((sig.includes('VENTA') || sig.includes('DEBIL')) && prevSignal && (!prevSignal.includes('VENTA') && !prevSignal.includes('DEBIL'))) {
                window.addNotification(`Tu posición ${stock.symbol} ahora da señal de ${sig}. ¡Revisa tu portafolio!`, 'sell');
            }
            // Stop Loss o Take Profit alert
            if (analysis.actionFlag === 'STOP_LOSS' && prevSignal !== 'STOP_LOSS') {
                window.addNotification(`⚠️ ALERTA: ${stock.symbol} ha tocado tu Stop Loss. Considera cerrar posición.`, 'sell');
            }
            if (analysis.actionFlag === 'TAKE_PROFIT' && prevSignal !== 'TAKE_PROFIT') {
                window.addNotification(`✅ ALERTA: ${stock.symbol} ha alcanzado objetivo de Take Profit.`, 'buy');
            }
        } else {
            // 2. Accion (no en portfolio) da de compra confirmada
            if ((sig === 'COMPRA' || sig === 'COMPRA FUERTE') && prevSignal && prevSignal !== 'COMPRA' && prevSignal !== 'COMPRA FUERTE') {
                if (analysis.confirmationLevel === 'ALTA CONFIANZA') {
                    window.addNotification(`🚀 OPORTUNIDAD: ${stock.symbol} generó señal de ${sig} (Confirmada con IA).`, 'buy');
                } else {
                    window.addNotification(`📈 OPORTUNIDAD: ${stock.symbol} generó señal de ${sig}.`, 'buy');
                }
            }
        }
        
        // 3. Revisar Alertas de Precio Personalizadas
        window.priceAlerts.forEach(alert => {
            if (!alert.triggered && alert.symbol === stock.symbol) {
                if ((alert.direction === 'up' && stock.price >= alert.targetPrice) ||
                    (alert.direction === 'down' && stock.price <= alert.targetPrice)) {
                    window.addNotification(`🎯 ALERTA DE PRECIO: ${stock.symbol} cruzó tu objetivo de $${alert.targetPrice.toFixed(2)} (Actual: $${stock.price})`, 'buy');
                    alert.triggered = true;
                    hasChanges = true;
                }
            }
        });
        
        if (window.lastKnownSignals[stock.symbol] !== currentAction) {
            window.lastKnownSignals[stock.symbol] = currentAction;
            hasChanges = true;
        }
    });

    if (hasChanges) {
        localStorage.setItem('advisor_last_signals', JSON.stringify(window.lastKnownSignals));
        localStorage.setItem('advisor_price_alerts', JSON.stringify(window.priceAlerts));
        if(window.cloudSynced) window.syncDataToFirebase();
    }
}
// ---------------------------------

window.togglePortfolioTerm = (term) => {
    window.portfolioTerm = term;
    renderPortfolio();
};


function renderMarketStatus() {
    const today = new Date().toLocaleDateString();

    let usageInfo = `<br><span style="font-size: 0.8rem; color: var(--accent-green);">Actualización de precios automática desde la nube activa</span>`;

    marketStatus.innerHTML = `
        <span class="status-indicator status-up"></span>
        <div>
            Datos del Mercado para: ${today}
            ${usageInfo}
        </div>
    `;
    marketStatus.style.borderColor = 'var(--text-primary)';
}

async function initDashboard() {
    container.innerHTML = `
        <div style="text-align:center; width:100%; padding: 2rem;">
            <h3>Iniciando Análisis del Mercado...</h3>
            <div id="loading-progress" style="color: var(--accent-blue); margin-top: 1rem; font-weight:bold;">Verificando Caché...</div>
             <p style="font-size: 0.8rem; color: var(--text-secondary); margin-top:0.5rem;">
                Los datos de hoy se recuperan de memoria si existen. Si no, se descargan secuencialmente.
            </p>
        </div>
    `;

    const progressEl = document.getElementById('loading-progress');

    const handleStockUpdate = (updatedList) => {
        globalStocksData = updatedList; // Update global list reference
        checkNotifications(); // Verificar nuevas oportunidades y cambios de tendencia
        refreshUI(); // Re-render sorted list
        renderMarketStatus(); // Actualizar contador de API
        renderHeatmap(); // Update Heatmap
        renderBuffettIndicator(); // Update Buffett Indicator
    };

    const handleProgress = (msg) => {
        if (progressEl) progressEl.textContent = msg;
        console.log("Progress:", msg);
    };

    const handleMacroUpdate = (macroData) => {
        globalMacroData = macroData;
        renderBuffettIndicator();
        renderCclIndicator();
        renderNewMacroIndicators();
    };

    const handleCclHistoryUpdate = (historicalData) => {
        globalCclHistory = historicalData;
        renderCclIndicator();
    };

    if (realDataService) {
        await realDataService.loadStocks(handleStockUpdate, handleProgress);
        await realDataService.loadMacroIndicator(handleMacroUpdate);
        await realDataService.loadCclHistory(handleCclHistoryUpdate);
    } else {
        container.innerHTML = "Error: Service not found. Check realData.js";
    }
}

function refreshUI() {
    const currentScroll = window.scrollY; // Guardar posición del scroll para evitar "saltos" molestos
    
    // Si tenemos datos, limpiamos el "Loading..." inicial y renderizamos la tabla
    if (globalStocksData.length > 0) {
        container.innerHTML = '';
    }

    // FASE 2: Historial Tab support
    if (currentTerm === 'portfolio') {
        container.style.display = 'none';
        controlsContainer.style.display = 'none';
        portfolioContainer.style.display = 'block';
        if (historialContainer) historialContainer.style.display = 'none';
        

        
        renderPortfolio();
        return;
    } else if (currentTerm === 'historial') {
        container.style.display = 'none';
        controlsContainer.style.display = 'none';
        portfolioContainer.style.display = 'none';
        if (historialContainer) historialContainer.style.display = 'block';
        

        
        renderHistorial();
        return;
    } else {
        container.style.display = ''; 
        controlsContainer.style.display = ''; 
        portfolioContainer.style.display = 'none';
        if (historialContainer) historialContainer.style.display = 'none';
        

    }

    // --- Filter & Search Logic ---
    const filteredList = globalStocksData.filter(item => {
        // 1. Search Filter
        const matchesSearch = item.symbol.toLowerCase().includes(searchTerm) ||
            item.name.toLowerCase().includes(searchTerm);
        if (!matchesSearch) return false;

        // 2. Category Filter (Pre-analysis check or Post-analysis? Post is better but costly to re-analyze everything?)
        // Let's analyze first then filter, or better: analyze effectively efficiently. 
        // actually we need to analyze to know if it's "buy" or "sell".
        return true;
    });

    // Process analysis (We analyze ALL matching search to get the Signal)
    let analyzedStocks = filteredList.map(data => {
        const vix = globalMacroData && globalMacroData.vix ? globalMacroData.vix : 25;
        const analysis = analyzeStockWithMarketCondition(data, currentTerm, getMarketCondition(vix));
        return { data, analysis };
    });

    // 3. Apply Signal/Watchlist Filter
    if (activeFilter === 'favorites') {
        analyzedStocks = analyzedStocks.filter(item => watchlist.includes(item.data.symbol));
    } else if (activeFilter !== 'all') {
        analyzedStocks = analyzedStocks.filter(item => {
            const sig = item.analysis.signal.toLowerCase();
            if (activeFilter === 'buy') return sig.includes('compra');
            if (activeFilter === 'sell') return sig.includes('venta');
            if (activeFilter === 'hold') return sig.includes('mantener') || sig.includes('operar');
            return true;
        });
    }

    // Sort by Score (Best opportunities first)
    analyzedStocks.sort((a, b) => b.analysis.score - a.analysis.score);





    // Render
    analyzedStocks.forEach(item => {
        const cardHTML = createCardHTML(item);
        container.appendChild(cardHTML);
        renderChart(item.data, `chart-${item.data.symbol}`);
    });
    
    // Restaurar posición del scroll
    window.scrollTo(0, currentScroll);
}

function createCardHTML(item) {
    const { data, analysis } = item;
    const card = document.createElement('div');
    card.className = 'stock-card';
    card.id = `card-${data.symbol}`;

    let badgeClass = 'hold-badge';
    if (analysis.signal.includes('COMPRA')) badgeClass = 'buy-badge';
    if (analysis.signal.includes('VENTA') || analysis.signal.includes('VENDER')) badgeClass = 'sell-badge';

    const changeClass = parseFloat(data.change) >= 0 ? 'change-up' : 'change-down';
    const changeSign = parseFloat(data.change) >= 0 ? '+' : '';

    const reasonsHtml = analysis.reasons.map(r =>
        `<li class="signal-item ${r.type === 'positive' ? 'signal-positive' : 'signal-negative'}">${r.text}</li>`
    ).join('');

    // Fundamental snippet check
    let fundamentalHtml = '';
    if (data.peRatio && data.peRatio !== 'N/A') {
        fundamentalHtml += `
        <div class="analysis-item">
            <span class="analysis-label">PER Ratio / EPS</span>
            <span class="analysis-value">${data.peRatio} / $${data.epsGrowth && data.epsGrowth !== 'N/A' ? data.epsGrowth : '--'}</span>
        </div>`;
    }
    if (data.beta && data.beta !== 'N/A') {
        fundamentalHtml += `
        <div class="analysis-item">
            <span class="analysis-label">Beta / ROE</span>
            <span class="analysis-value">${data.beta} / ${data.roe && data.roe !== 'N/A' ? data.roe : '--'}%</span>
        </div>`;
    }

    const isFavorite = watchlist.includes(data.symbol);
    const starClass = isFavorite ? 'active' : '';

    const isArg = data.symbol.endsWith('.BA');
    const displaySymbol = isArg ? data.symbol.replace('.BA', '') : data.symbol;
    const flag = isArg ? ' <span style="font-size:0.8em">🇦🇷</span>' : '';

    // Si hay conflicto, aplicar clase CSS
    if (analysis.conflicto) {
        card.classList.add('conflict-alert');
    }

    // AI Badge
    let aiBadgeHtml = '';
    if (analysis.ai.usable) {
        const aiColor = analysis.ai.bias === "BULLISH" ? "var(--accent-green)" : (analysis.ai.bias === "BEARISH" ? "var(--accent-red)" : "var(--text-secondary)");
        const aiText = analysis.ai.bias === "BULLISH" ? "Alcista" : (analysis.ai.bias === "BEARISH" ? "Bajista" : "Neutral");
        aiBadgeHtml = `
            <div style="margin-top: 0.8rem; display:flex; gap:0.5rem; font-size: 0.75rem; flex-wrap: wrap;">
                <span style="background: rgba(255,255,255,0.05); padding: 0.2rem 0.5rem; border-radius: 4px; border: 1px solid ${aiColor}; color: ${aiColor}; font-weight: bold;">🧠 IA: ${aiText}</span>
                <span style="background: rgba(255,255,255,0.05); padding: 0.2rem 0.5rem; border-radius: 4px; color: var(--text-secondary);">Confianza: ${(analysis.ai.strength * 100).toFixed(0)}%</span>
                <span style="background: rgba(255,255,255,0.05); padding: 0.2rem 0.5rem; border-radius: 4px; color: var(--text-secondary);">Nivel: <b style="color: ${analysis.confirmationLevel === 'ALTA CONFIANZA' ? 'var(--accent-green)' : (analysis.confirmationLevel === 'CONFLICTO' ? 'var(--accent-red)' : 'var(--text-primary)')}">${analysis.confirmationLevel}</b></span>
            </div>
        `;
    }

    // Setup badge if generated
    let setupHtml = '';
    if (analysis.setupDetected) {
        setupHtml = `<div style="margin-top:0.5rem;"><span style="background: var(--accent-blue); color: #fff; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: bold; box-shadow: 0 0 8px var(--accent-blue);">🔥 SETUP DE ALTA PROBABILIDAD (${analysis.setupDetected.toUpperCase()})</span></div>`;
    }

    // Mock Earnings logic based on symbol hash
    const hashCode = s => s.split('').reduce((a,b)=>{a=((a<<5)-a)+b.charCodeAt(0);return a&a},0);
    const daysToEarnings = Math.abs(hashCode(data.symbol)) % 60;
    const earningsHtml = daysToEarnings < 15 ? `<div style="margin-top:0.5rem;"><span style="background: var(--accent-red); color: white; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: bold;">⚠️ Próximo Reporte de Ganancias en ${daysToEarnings} días</span></div>` : '';

    card.innerHTML = `
        <div class="card-header" style="margin-bottom: 0;">
            <div>
                <div class="stock-symbol">${displaySymbol}${flag} 
                    <span class="watchlist-star ${starClass}" onclick="toggleWatchlist('${data.symbol}', event)">★</span>
                </div>
                <div class="stock-name">${data.name}</div>
            </div>
            <div style="text-align: right;">
                <div class="recommendation-badge ${badgeClass}">${analysis.signal}</div>
                <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 4px;">Score: <b style="color:${analysis.score >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">${analysis.score}</b>/10</div>
            </div>
        </div>
        ${aiBadgeHtml}
        
        <div class="price-section" style="margin-top: 1rem;">
            <div class="current-price">$${data.price}</div>
            <div class="price-change ${changeClass}">${changeSign}${data.change} (${changeSign}${data.changePercent}%)</div>
            ${analysis.conflicto ? `<div style="margin-top:0.5rem;"><span style="background: var(--accent-red); color: white; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem;">⚠️ ${analysis.conflicto}</span></div>` : ''}
            <div style="margin-top: 0.5rem; display: flex; gap: 0.5rem; flex-wrap: wrap;">
                <button type="button" onclick="event.preventDefault(); addToPortfolioPrompt('${data.symbol}')" style="background:var(--card-bg); border:1px solid var(--border-color); color:var(--text-secondary); cursor:pointer; font-size: 0.8rem; padding: 0.3rem 0.6rem; border-radius: 4px; transition:0.2s;" onmouseover="this.style.background='var(--hover-bg)'" onmouseout="this.style.background='var(--card-bg)'">+ Portafolio</button>
                <button type="button" ${window.aiPredictionCache[data.symbol] ? 'disabled' : `onclick="event.preventDefault(); window.predictAI('${data.symbol}')"`} id="btn-ai-${data.symbol}" style="background:${window.aiPredictionCache[data.symbol] ? '#4b5563' : '#8b5cf6'}; border:none; color:white; cursor:${window.aiPredictionCache[data.symbol] ? 'default' : 'pointer'}; font-size: 0.8rem; padding: 0.3rem 0.6rem; border-radius: 4px; box-shadow: ${window.aiPredictionCache[data.symbol] ? 'none' : '0 0 5px rgba(139, 92, 246, 0.5)'}; transition:0.2s;" ${!window.aiPredictionCache[data.symbol] ? `onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'"` : ''}>${window.aiPredictionCache[data.symbol] ? '✅ IA Confirmada' : '🧠 IA Predict'}</button>
                <button type="button" onclick="event.preventDefault(); window.openPriceAlert('${data.symbol}', ${data.price})" style="background:var(--card-bg); border:1px solid var(--border-color); color:var(--text-primary); cursor:pointer; font-size: 0.8rem; padding: 0.3rem 0.6rem; border-radius: 4px; transition:0.2s;">🔔 Alerta</button>
                <button type="button" onclick="event.preventDefault(); window.openNewsModal('${data.symbol}')" style="background:var(--card-bg); border:1px solid var(--border-color); color:var(--text-primary); cursor:pointer; font-size: 0.8rem; padding: 0.3rem 0.6rem; border-radius: 4px; transition:0.2s;">📰 Noticias</button>
            </div>
            ${setupHtml}
            ${earningsHtml}
        </div>

        <div class="analysis-grid" style="grid-template-columns: 1fr 1fr; gap:0.5rem; margin-bottom:1rem;">
            <div style="background:var(--card-bg); padding:0.5rem; border-radius:4px; border:1px solid var(--border-color);">
                <div style="font-size:0.7rem; color:var(--text-secondary); margin-bottom:4px; font-weight:bold;">CORTO PLAZO (Swing)</div>
                <div style="font-size:0.9rem; font-weight:bold; color:${analysis.corto_plazo.score >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">${analysis.corto_plazo.signal}</div>
                <div style="font-size:0.75rem;">Score: ${analysis.corto_plazo.score}/10</div>
            </div>
            <div style="background:var(--card-bg); padding:0.5rem; border-radius:4px; border:1px solid var(--border-color);">
                <div style="font-size:0.7rem; color:var(--text-secondary); margin-bottom:4px; font-weight:bold;">LARGO PLAZO (Posición)</div>
                <div style="font-size:0.9rem; font-weight:bold; color:${analysis.largo_plazo.score >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">${analysis.largo_plazo.signal}</div>
                <div style="font-size:0.75rem;">Score: ${analysis.largo_plazo.score}/10</div>
            </div>
        </div>
        
        <div class="analysis-grid" style="grid-template-columns: repeat(3, 1fr); gap: 0.5rem; margin-bottom: 1rem;">
            <div class="analysis-item">
                <span class="analysis-label">RSI Rápido</span>
                <span class="analysis-value" style="color: ${data.rsi < 30 || data.rsi > 70 ? 'var(--accent-blue)' : 'inherit'}">${data.rsi}</span>
            </div>
            <div class="analysis-item">
                <span class="analysis-label">Tendencia LP</span>
                <span class="analysis-value">${data.price > data.sma200 ? 'Alcista' : 'Bajista'}</span>
            </div>
            <div class="analysis-item">
                <span class="analysis-label">Confianza</span>
                <span class="analysis-value">${analysis.confianza.toFixed(0)}%</span>
            </div>
            <div class="analysis-item">
                <span class="analysis-label">Noticias</span>
                <span class="analysis-value" style="color: ${data.newsSentiment > 0 ? 'var(--accent-green)' : (data.newsSentiment < 0 ? 'var(--accent-red)' : 'inherit')}">${data.newsSentimentStr || 'NEUTRO'}</span>
            </div>
            <div class="analysis-item">
                <span class="analysis-label">Régimen Macro</span>
                <span class="analysis-value">${analysis.contexto_mercado}</span>
            </div>
        </div>

        <div class="signals-section">
            <div class="section-title">Análisis de Señales</div>
            <ul class="signal-list">
                ${reasonsHtml}
            </ul>
        </div>

        <div class="chart-wrapper" ondblclick="openTradingViewModal('${data.symbol}')" style="cursor: pointer; transition: 0.2s; height: 180px; margin-top: 1rem;" onmouseover="this.style.opacity='0.9'" onmouseout="this.style.opacity='1'" title="Doble Click para Análisis Profundo">
            <div id="chart-${data.symbol}" style="width: 100%; height: 100%;"></div>
        </div>
    `;
    return card;
}

// Event Listeners
tabs.forEach(tab => {
    tab.addEventListener('click', async () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentTerm = tab.dataset.term;
        refreshUI(); // Optimized refresh (no reload needed)
    });
});

// Search & Filter Events
const searchInput = document.getElementById('searchInput');
const filterBtns = document.querySelectorAll('.filter-btn');

if (searchInput) {
    searchInput.addEventListener('input', (e) => {
        searchTerm = e.target.value.toLowerCase().trim();
        refreshUI();
    });
}

filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeFilter = btn.dataset.filter;
        refreshUI();
    });
});

window.toggleWatchlist = (symbol, event) => {
    if (event) event.stopPropagation(); // prevent modal open if any

    const index = watchlist.indexOf(symbol);
    if (index === -1) {
        watchlist.push(symbol);
    } else {
        watchlist.splice(index, 1);
    }
    localStorage.setItem('advisor_watchlist', JSON.stringify(watchlist));
    if (window.cloudSynced) window.syncDataToFirebase();
    refreshUI();
};

window.removeFromPortfolio = (index) => {
    // FASE 2: Register trade before removing
    const pos = portfolio[index];
    const stockData = globalStocksData.find(s => s.symbol === pos.symbol);
    if (stockData) {
        const currentPrice = parseFloat(stockData.price);
        const profit = (currentPrice - pos.price) * pos.qty;
        const profitPct = ((currentPrice - pos.price) / pos.price) * 100;
        
        closedTrades.push({
            symbol: pos.symbol,
            entryPrice: pos.price,
            exitPrice: currentPrice,
            qty: pos.qty,
            profit: profit,
            profitPct: profitPct,
            date: new Date().toISOString()
        });
        localStorage.setItem('advisor_closed_trades', JSON.stringify(closedTrades));
    }

    portfolio.splice(index, 1);
    localStorage.setItem('advisor_portfolio', JSON.stringify(portfolio));
    renderPortfolio();
};

window.addToPortfolioPrompt = (symbol) => {
    const stockData = globalStocksData.find(s => s.symbol === symbol);
    if (!stockData) return;

    // We use a small timeout to avoid double click issues or modal triggers if any
    setTimeout(() => {
        const price = prompt(`Añadiendo ${symbol} al Portafolio\\nPrecio de Compra: (Ej: ${stockData.price})`, stockData.price);
        if (price === null || isNaN(parseFloat(price))) return;

        const qty = prompt(`Cantidad de Acciones de ${symbol}:`, '10');
        if (qty === null || isNaN(parseFloat(qty))) return;

        portfolio.push({
            symbol: symbol,
            price: parseFloat(price),
            highestPrice: parseFloat(price),
            qty: parseFloat(qty)
        });
        localStorage.setItem('advisor_portfolio', JSON.stringify(portfolio));
        alert(`${symbol} añadida al portafolio exitosamente.`);
    }, 50);
};

function renderPortfolio() {
    portfolioContainer.innerHTML = '<h4>Mi Portafolio V1</h4>';

    let totalValue = 0;
    let totalInvestment = 0;

    let tableHtml = `
    <div style="overflow-x: auto;">
    <table class="portfolio-table" style="width:100%; text-align:left; border-collapse: collapse; margin-top: 1rem; font-size: 0.9rem;">
        <thead>
            <tr style="border-bottom: 1px solid var(--border-color); color: var(--text-secondary);">
                <th style="padding: 0.75rem;">Activo</th>
                <th style="padding: 0.75rem;">Cant.</th>
                <th style="padding: 0.75rem;">Base</th>
                <th style="padding: 0.75rem;">Actual</th>
                <th style="padding: 0.75rem;">%</th>
                <th style="padding: 0.75rem;">P/L ($)</th>
                <th style="padding: 0.75rem;">Señal</th>
                <th style="padding: 0.75rem;"></th>
            </tr>
        </thead>
        <tbody>
    `;

    if (portfolio.length === 0) {
        portfolioContainer.innerHTML += '<p style="text-align:center; padding: 2rem; color: var(--text-secondary);">El portafolio está vacío. Añade acciones desde la lista principal clickeando en "+ Portafolio".</p>';
        return;
    }

    let hasPortfolioChanges = false;

    portfolio.forEach((pos, index) => {
        const stockData = globalStocksData.find(s => s.symbol === pos.symbol);

        const currentPrice = stockData ? parseFloat(stockData.price) : pos.price; // fallback if not found
        const basePrice = parseFloat(pos.price);
        const qty = parseFloat(pos.qty);

        // Tracker de Máximo histórico para Trailing Stop
        if (!pos.highestPrice || currentPrice > pos.highestPrice) {
            pos.highestPrice = Math.max(currentPrice, basePrice);
            hasPortfolioChanges = true;
        }

        const inv = basePrice * qty;
        const currentVal = currentPrice * qty;
        const pl = currentVal - inv;
        const plPct = inv > 0 ? (pl / inv) * 100 : 0;

        totalInvestment += inv;
        totalValue += currentVal;

        const colorClass = pl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
        const sign = pl >= 0 ? '+' : '';

        // Calculate Signal
        let signalBadge = '<span style="color: var(--text-secondary); font-size: 0.8rem;">--</span>';
        if (stockData) {
            const portfolioInfo = { entryPrice: basePrice, highestPrice: pos.highestPrice };
            const vix = globalMacroData && globalMacroData.vix ? globalMacroData.vix : 25;
            const analysis = analyzeStockWithMarketCondition(stockData, window.portfolioTerm, getMarketCondition(vix), portfolioInfo);
            const sig = analysis.signal;

            let bgClass = 'hold-badge';
            if (sig.includes('COMPRA')) bgClass = 'buy-badge';
            if (sig.includes('VENTA') || sig.includes('VENDER')) bgClass = 'sell-badge';

            let actionBadgeHtml = '';
            if (analysis.actionFlag === 'TRAILING_STOP') {
                actionBadgeHtml = `<br><span class="recommendation-badge" style="background:#ef4444; color:#fff; font-size: 0.65rem; padding: 0.1rem 0.3rem; margin-top:4px;">STOP LOSS ACTIVO</span>`;
            } else if (analysis.actionFlag === 'TAKE_PROFIT') {
                actionBadgeHtml = `<br><span class="recommendation-badge" style="background:#eab308; color:#000; font-size: 0.65rem; padding: 0.1rem 0.3rem; margin-top:4px;">TAKE PROFIT</span>`;
            }

            // Re-using styles from your CSS but making it smaller
            signalBadge = `<div style="text-align:center;"><span class="recommendation-badge ${bgClass}" style="position: static; font-size: 0.7rem; padding: 0.2rem 0.4rem; white-space: nowrap;">${sig}</span>${actionBadgeHtml}</div>`;
        }

        const isArg = pos.symbol.endsWith('.BA');
        const displaySymbol = isArg ? pos.symbol.replace('.BA', '') : pos.symbol;
        const flag = isArg ? ' 🇦🇷' : '';

        tableHtml += `
            <tr style="border-bottom: 1px solid var(--border-color);">
                <td style="padding: 0.75rem; font-weight: bold;">${displaySymbol}${flag}</td>
                <td style="padding: 0.75rem;">${qty}</td>
                <td style="padding: 0.75rem;">$${basePrice.toFixed(2)}</td>
                <td style="padding: 0.75rem;">$${currentPrice.toFixed(2)}</td>
                <td style="padding: 0.75rem; color: ${colorClass};">${sign}${plPct.toFixed(2)}%</td>
                <td style="padding: 0.75rem; color: ${colorClass}; font-weight: bold;">${sign}$${pl.toFixed(2)}</td>
                <td style="padding: 0.75rem; vertical-align: middle;">${signalBadge}</td>
                <td style="padding: 0.75rem;"><button onclick="removeFromPortfolio(${index})" style="background:var(--accent-red); color:white; border:none; padding: 0.2rem 0.6rem; border-radius:4px; cursor:pointer;" title="Eliminar">🗑️</button></td>
            </tr>
        `;
    });

    tableHtml += `</tbody></table></div>`;

    if (hasPortfolioChanges) {
        localStorage.setItem('advisor_portfolio', JSON.stringify(portfolio));
        if(window.cloudSynced) window.syncDataToFirebase();
    }

    // Summary
    const totalPl = totalValue - totalInvestment;
    const totalPlPct = totalInvestment > 0 ? (totalPl / totalInvestment) * 100 : 0;
    const summaryColor = totalPl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
    const summarySign = totalPl >= 0 ? '+' : '';

    const summaryHtml = `        <div style="display:flex; justify-content: space-around; background: var(--card-bg); padding: 1.5rem; border-radius: 8px; margin-bottom: 1.5rem; border: 1px solid var(--border-color); flex-wrap: wrap; gap: 1rem; text-align: center;">
            <div style="flex: 1;"><span style="color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase;">Inversión Total</span><br><b style="font-size: 1.25rem;">$${totalInvestment.toFixed(2)}</b></div>
            <div style="flex: 1;"><span style="color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase;">Valor Actual</span><br><b style="font-size: 1.25rem;">$${totalValue.toFixed(2)}</b></div>
            <div style="flex: 1;"><span style="color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase;">Rendimiento Total</span><br><b style="color:${summaryColor}; font-size: 1.25rem;">${summarySign}$${totalPl.toFixed(2)} (${summarySign}${totalPlPct.toFixed(2)}%)</b></div>
        </div>
        
        <!-- FASE 5: PIE CHART -->
        <div style="display: flex; flex-wrap: wrap; justify-content: center; gap: 2rem; margin-bottom: 1rem; padding: 1rem; background: var(--card-bg); border-radius: 8px; border: 1px solid var(--border-color);">
            <div style="width: 250px; height: 250px;">
                <canvas id="portfolioPieChart"></canvas>
            </div>
        </div>
`;

    const toggleHtml = `
        <div style="margin-bottom: 1rem; text-align: right;">
            <span style="font-size: 0.85rem; color: var(--text-secondary); margin-right: 0.5rem;">Señal de Recomendación:</span>
            <button onclick="togglePortfolioTerm('short')" style="padding: 0.3rem 0.8rem; cursor: pointer; border-radius: 4px; border: 1px solid var(--border-color); background: ${window.portfolioTerm === 'short' ? 'var(--accent-blue)' : 'var(--card-bg)'}; color: ${window.portfolioTerm === 'short' ? '#fff' : 'var(--text-primary)'}; font-size: 0.8rem;">Corto Plazo</button>
            <button onclick="togglePortfolioTerm('long')" style="padding: 0.3rem 0.8rem; cursor: pointer; border-radius: 4px; border: 1px solid var(--border-color); background: ${window.portfolioTerm === 'long' ? 'var(--accent-blue)' : 'var(--card-bg)'}; color: ${window.portfolioTerm === 'long' ? '#fff' : 'var(--text-primary)'}; font-size: 0.8rem; margin-left: 0.5rem;">Largo Plazo</button>
        </div>
    `;

    portfolioContainer.innerHTML = '<h3 style="margin-bottom: 1rem;">Analítica de Portafolio</h3>' + summaryHtml + toggleHtml + tableHtml;

    // Render Phase 5 Pie
    setTimeout(() => {
        if(window.portPieChart) window.portPieChart.destroy();
        const ctxPie = document.getElementById('portfolioPieChart');
        if(!ctxPie) return;
        
        const labels = portfolio.map(p => p.symbol);
        const dataValues = portfolio.map(p => {
            const st = globalStocksData.find(s => s.symbol === p.symbol);
            return st ? (st.price * p.qty) : (p.price * p.qty);
        });
        
        window.portPieChart = new Chart(ctxPie, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: dataValues,
                    backgroundColor: ['#0ea5e9', '#10b981', '#f59e0b', '#8b5cf6', '#f43f5e', '#ec4899', '#14b8a6', '#f97316'],
                    borderWidth: 0,
                    hoverOffset: 10
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'right', labels: { color: '#f9fafb', font: {size: 11} } },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let label = context.label || '';
                                if (label) { label += ': '; }
                                if (context.parsed !== null) {
                                    label += new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(context.parsed);
                                }
                                return label;
                            }
                        }
                    }
                }
            }
        });
    }, 100);

}

// Init
renderMarketStatus();
initDashboard();

// Helper to keep track of chart instances and destroy them to avoid "Canvas is already in use" errors



function renderChart(data, canvasId) {
    const container = document.getElementById(canvasId);
    if (!container) return;

    // Check if LightweightCharts is loaded
    if (typeof LightweightCharts === 'undefined') {
        container.innerHTML = '<p style="color:var(--text-secondary); text-align:center; padding: 2rem;">Cargando motor gráfico profesional...</p>';
        return;
    }

    container.innerHTML = ''; // Clear prev

    const pointsToShow = (currentTerm === 'short' || currentTerm === 'all') ? -150 : -250;
    const dates = data.history.dates ? data.history.dates.slice(pointsToShow) : [];
    const prices = data.history.prices ? data.history.prices.slice(pointsToShow) : [];
    const ema20 = data.history.ema20 ? data.history.ema20.slice(pointsToShow) : [];
    
    if (prices.length === 0) return;

    // Build Candlestick mock logic
    const candleData = [];
    let prevClose = prices[0];
    for (let i = 0; i < dates.length; i++) {
        const p = parseFloat(prices[i]);
        // Derive pseudo OHLC from single line history to show candlestick utility
        const vol = p * 0.015; 
        const open = i > 0 ? parseFloat(prices[i-1]) : prevClose;
        const close = p;
        const high = Math.max(open, close) + (vol * Math.random());
        const low = Math.min(open, close) - (vol * Math.random());
        
        candleData.push({ time: dates[i], open, high, low, close });
        prevClose = close;
    }

    const chart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: container.clientHeight,
        layout: {
            background: { type: 'solid', color: 'transparent' },
            textColor: '#d1d5db',
        },
        grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
        },
        timeScale: {
            timeVisible: true,
            borderColor: 'rgba(255, 255, 255, 0.1)',
            rightOffset: 0,
            fixRightEdge: true,
        },
        rightPriceScale: {
            borderColor: 'rgba(255, 255, 255, 0.1)',
        }
    });

    const candleSeries = chart.addCandlestickSeries({
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
    });

    candleSeries.setData(candleData);

    // Add EMA if exists
    if (ema20.length > 0) {
        const emaData = [];
        for (let i = 0; i < dates.length; i++) {
            if (ema20[i]) emaData.push({ time: dates[i], value: parseFloat(ema20[i]) });
        }
        const emaSeries = chart.addLineSeries({
            color: 'rgba(59, 130, 246, 0.8)', // blue
            lineWidth: 1,
            crosshairMarkerVisible: false,
        });
        emaSeries.setData(emaData);
    }

    chart.timeScale().fitContent();
    chart.timeScale().applyOptions({ rightOffset: 0 });

    // Handling resize automatically
    new ResizeObserver(entries => {
        if (entries.length === 0 || entries[0].target !== container) return;
        const newRect = entries[0].contentRect;
        chart.applyOptions({ height: newRect.height, width: newRect.width });
    }).observe(container);
}

// --- Integraciones Globales para Interfaz ---

window.authMode = 'login'; // 'login' or 'register'

window.openAuthModal = function() {
    if (window.cloudSynced && auth.currentUser) {
        if(confirm("Ya estás logueado. ¿Quieres cerrar sesión?")) {
            signOut(auth).then(() => {
                 window.cloudSynced = false;
                 document.getElementById('cloudStatusText').innerText = "Iniciar Sesión";
                 document.getElementById('cloudStatusText').style.color = "inherit";
                 alert("Sesión cerrada.");
            }).catch(e => console.error(e));
        }
        return;
    }
    document.getElementById('authModal').style.display = 'flex';
    document.getElementById('authErrorMsg').style.display = 'none';
};

window.toggleAuthMode = function() {
    if (window.authMode === 'login') {
        window.authMode = 'register';
        document.getElementById('authModalTitle').innerText = 'Crear Cuenta';
        document.getElementById('authSubmitBtn').innerText = 'Registrarse';
        document.getElementById('authSwitchText').innerText = '¿Ya tienes cuenta?';
        document.getElementById('authSwitchLink').innerText = 'Ingresar';
    } else {
        window.authMode = 'login';
        document.getElementById('authModalTitle').innerText = 'Iniciar Sesión';
        document.getElementById('authSubmitBtn').innerText = 'Ingresar';
        document.getElementById('authSwitchText').innerText = '¿No tienes cuenta?';
        document.getElementById('authSwitchLink').innerText = 'Crear Cuenta';
    }
};

window.handleAuthSubmit = async function() {
    const email = document.getElementById('authEmail').value;
    const pass = document.getElementById('authPassword').value;
    const errorEl = document.getElementById('authErrorMsg');
    
    errorEl.style.display = 'none';
    
    try {
        if (window.authMode === 'login') {
            await signInWithEmailAndPassword(auth, email, pass);
        } else {
            await createUserWithEmailAndPassword(auth, email, pass);
        }
        document.getElementById('authModal').style.display = 'none';
    } catch(err) {
        errorEl.innerText = "Error: " + err.message;
        errorEl.style.display = 'block';
    }
};

// Monitor de estado de autenticación (Se ejecuta automáticamente cuando Firebase detecta estado)
onAuthStateChanged(auth, async (user) => {
    if (user) {
        window.cloudSynced = true;
        document.getElementById('cloudStatusText').innerText = "Conectado";
        document.getElementById('cloudStatusText').style.color = "var(--accent-green)";
        
        // Cargar datos de la nube
        try {
            const docRef = doc(db, "users", user.uid);
            const docSnap = await getDoc(docRef);
            if (docSnap.exists()) {
                const d = docSnap.data();
                if (d.portfolio) {
                    portfolio = d.portfolio;
                    localStorage.setItem('advisor_portfolio', JSON.stringify(portfolio));
                }
                if (d.watchlist) {
                    watchlist = d.watchlist;
                    localStorage.setItem('advisor_watchlist', JSON.stringify(watchlist));
                }
                if (d.priceAlerts) {
                    window.priceAlerts = d.priceAlerts;
                    localStorage.setItem('advisor_price_alerts', JSON.stringify(window.priceAlerts));
                }
                if(typeof refreshUI === 'function') refreshUI();
            }
        } catch(e) {
            console.error("Error cargando perfil nube", e);
        }
    } else {
        window.cloudSynced = false;
        document.getElementById('cloudStatusText').innerText = "Iniciar Sesión";
        document.getElementById('cloudStatusText').style.color = "inherit";
    }
});

window.syncDataToFirebase = async function() {
   if (!auth.currentUser) return;
   try {
       const docRef = doc(db, "users", auth.currentUser.uid);
       await setDoc(docRef, {
           portfolio: portfolio,
           watchlist: watchlist,
           priceAlerts: window.priceAlerts,
           updatedAt: new Date().toISOString()
       }, { merge: true });
   } catch(e) {
       console.error("Error subiendo datos", e);
   }
};

let currentAlertSymbol = '';
window.openPriceAlert = function(symbol, currentPrice) {
    currentAlertSymbol = symbol;
    document.getElementById('alertSymbolText').innerText = symbol;
    document.getElementById('alertPriceInput').value = currentPrice;
    document.getElementById('alertModal').style.display = 'flex';
};

window.savePriceAlert = function() {
    const inputPrice = parseFloat(document.getElementById('alertPriceInput').value);
    if (isNaN(inputPrice)) return;
    
    const stock = globalStocksData.find(s => s.symbol === currentAlertSymbol);
    if (!stock) return;
    
    const direction = inputPrice > stock.price ? 'up' : 'down';
    
    window.priceAlerts.push({
        id: new Date().getTime(),
        symbol: currentAlertSymbol,
        targetPrice: inputPrice,
        direction: direction,
        triggered: false,
        createdAt: new Date().toISOString()
    });
    
    localStorage.setItem('advisor_price_alerts', JSON.stringify(window.priceAlerts));
    document.getElementById('alertModal').style.display = 'none';
    alert(`Alerta guardada para ${currentAlertSymbol} al llegar a $${inputPrice}.`);
};

window.openNewsModal = function(symbol) {
    const stock = globalStocksData.find(s => s.symbol === symbol);
    if (!stock) return;
    
    document.getElementById('newsTitle').innerText = `📰 Noticias: ${stock.name || symbol}`;
    const container = document.getElementById('newsContainer');
    
    let htmlContent = '';
    const sentiment = stock.newsSentiment || 0;
    
    // Check if the backend has fetched real news for this stock (saved in db)
    if (stock.newsList && stock.newsList.length > 0) {
        htmlContent = stock.newsList.map((n, i) => {
            let borderColor = 'var(--border-color)';
            if (i === 0 && sentiment > 1) borderColor = 'var(--accent-green)';
            if (i === 0 && sentiment < -1) borderColor = 'var(--accent-red)';
            
            return `
            <div style="background: var(--hover-bg); padding: 1rem; border-radius: 6px; border-left: 4px solid ${borderColor}; margin-bottom: 0.5rem;">
                <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.5rem;">${n.date} - ${n.publisher}</div>
                <div style="font-size: 0.95rem; line-height: 1.4;">
                    <a href="${n.link}" target="_blank" style="color: var(--text-primary); text-decoration: none;">${n.title}</a>
                </div>
            </div>`;
        }).join('');
    } else {
        htmlContent = `
        <div style="text-align: center; color: var(--text-secondary); padding: 2rem;">
            Aún no hay noticias sincronizadas reales para este ticker en la base de datos.<br>
            El script de actualización (Backend) procesará y listará las noticias actuales aquí durante su próxima ejecución.
        </div>`;
    }
    
    container.innerHTML = htmlContent;
    
    document.getElementById('newsModal').style.display = 'flex';
};

// --- BONUS: Backtesting Engine Integrado ---
// Función disponible globalmente para usarse desde la consola de desarrollador
/**
 * Ejecuta una simulación de operaciones a lo largo del historial de datos.
 * @param {Array} stockHistory - Array de días (Ej: resultado de un mapeo previo que contenga { price, rsi, macd, ema20... })
 * @param {String} term - "short" (por defecto) o "long"
 */
window.runBacktest = function(stockHistory, config = {}) {
    if (!Array.isArray(stockHistory) || stockHistory.length === 0) {
        console.error("Backtest falló: stockHistory vacio o invalido.");
        return null; 
    }

    // Compatibilidad si pasan el segundo parametro como term (fallback a old API)
    if (typeof config === 'string') {
        config = { term: config };
    }

    const {
        capital = 1000,
        positionSizePct = 1.0,  // 1.0 = 100%
        stopLossPct = -5.0,     // % 
        takeProfitPct = 10.0,   // %
        trailingStopPct = null, // %
        slippagePct = 0.2,
        commissionPct = 0.1,
        term = 'short',
        marketCondition = 'SIDEWAYS'
    } = config;

    let currentCapital = capital;
    let position = null; // { entryPrice, qty, highestPrice, investedAmount }
    
    let totalTrades = 0;
    let winningTrades = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let peakCapital = capital;
    let maxDrawdown = 0;

    console.log(`[Backtest] Iniciando simulación en ${stockHistory.length} días (Estrategia: ${typeof strategyMode !== 'undefined' ? strategyMode : 'hybrid'}, Modo: ${term})`);

    stockHistory.forEach((dayData, index) => {
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
        // By default use master signal, unless testing specific term
        let signal = analysis.signal;
        if (term === 'short') signal = analysis.corto_plazo.signal;
        else if (term === 'long') signal = analysis.largo_plazo.signal;

        if (!position) {
            // Evaluando entrada
            if (signal.includes("COMPRA") || signal.includes("PRE-COMPRA")) {
                const investAmount = currentCapital * positionSizePct;
                const priceWithSlippage = currentPrice * (1 + (slippagePct / 100));
                const commission = investAmount * (commissionPct / 100);
                
                const finalInvestAmount = investAmount - commission;
                const qty = finalInvestAmount / priceWithSlippage;

                position = {
                    entryPrice: priceWithSlippage,
                    qty: qty,
                    highestPrice: priceWithSlippage,
                    investedAmount: investAmount
                };
                currentCapital -= investAmount;
                totalTrades++;
            }
        } else {
            // Evaluando salida
            let exitReason = null;
            const floatProfitPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
            
            if (floatProfitPct <= stopLossPct) {
                exitReason = "STOP_LOSS";
            } else if (floatProfitPct >= takeProfitPct) {
                exitReason = "TAKE_PROFIT";
            } else if (trailingStopPct !== null) {
                const drawdownFromPeak = ((position.highestPrice - currentPrice) / position.highestPrice) * 100;
                if (drawdownFromPeak >= trailingStopPct) {
                    exitReason = "TRAILING_STOP";
                }
            } else if (signal.includes("VENTA")) {
                exitReason = "SIGNAL_SELL";
            }

            if (exitReason) {
                const priceWithSlippage = currentPrice * (1 - (slippagePct / 100));
                const grossVal = position.qty * priceWithSlippage;
                const commission = grossVal * (commissionPct / 100);
                const netVal = grossVal - commission;

                currentCapital += netVal;

                const tradeProfit = netVal - position.investedAmount;
                if (tradeProfit > 0) {
                    winningTrades++;
                    grossProfit += tradeProfit;
                } else {
                    grossLoss += Math.abs(tradeProfit);
                }

                position = null;
            }
        }

        const currentEquity = currentCapital + (position ? (currentPrice * position.qty) : 0);
        if (currentEquity > peakCapital) {
            peakCapital = currentEquity;
        } else {
            const drawdown = ((peakCapital - currentEquity) / peakCapital) * 100;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        }
    });

    if (position) {
        const lastPrice = parseFloat(stockHistory[stockHistory.length - 1].price);
        const priceWithSlippage = lastPrice * (1 - (slippagePct / 100));
        const grossVal = position.qty * priceWithSlippage;
        const commission = grossVal * (commissionPct / 100);
        const netVal = grossVal - commission;

        currentCapital += netVal;
        const tradeProfit = netVal - position.investedAmount;
        if (tradeProfit > 0) {
            winningTrades++;
            grossProfit += tradeProfit;
        } else {
            grossLoss += Math.abs(tradeProfit);
        }
    }

    const profitTotalVal = currentCapital - capital;
    const profitPercent = (profitTotalVal / capital) * 100;
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : 0);
    // Sharpe Ratio simplificado (rendimiento / max drawdown) solo referencial
    const sharpeRatio = maxDrawdown > 0 ? (profitPercent / maxDrawdown) : 0;

    const result = {
        initialCapital: `$${capital.toFixed(2)}`,
        finalCapital: `$${currentCapital.toFixed(2)}`,
        profitTotal: `$${profitTotalVal.toFixed(2)} (${profitPercent.toFixed(2)}%)`,
        totalTrades: totalTrades,
        winRate: `${winRate.toFixed(2)}%`,
        maxDrawdown: `${maxDrawdown.toFixed(2)}%`,
        profitFactor: profitFactor === Infinity ? "Infinity" : profitFactor.toFixed(2),
        sharpeRatio: sharpeRatio.toFixed(2)
    };

    console.table(result);
    return result;
};


function renderHeatmap() {
    const heatmapContainer = document.getElementById('marketHeatmap');
    if (!heatmapContainer) return;

    heatmapContainer.innerHTML = '';
    // Styling the container to look like a True Treemap (100% width filled)
    heatmapContainer.style.display = 'flex';
    heatmapContainer.style.flexWrap = 'wrap';
    heatmapContainer.style.gap = '2px';
    heatmapContainer.style.backgroundColor = '#000';
    heatmapContainer.style.padding = '2px';
    heatmapContainer.style.borderRadius = '4px';
    heatmapContainer.style.width = '100%';
    // Eliminado el estiramiento vertical forzado (65vh y alignContent)

    const sectorMapping = {
        'AAPL': 'Tecnología', 'MSFT': 'Tecnología', 'GOOGL': 'Tecnología', 'META': 'Tecnología', 'NVDA': 'Tecnología', 'AMD': 'Tecnología', 'INTC': 'Tecnología', 'CRM': 'Tecnología', 'PLTR': 'Tecnología', 'SHOP': 'Tecnología', 'SPOT': 'Tecnología', 'CRWD': 'Tecnología', 'SMCI': 'Tecnología', 'ORCL': 'Tecnología', 'ADBE': 'Tecnología', 'GLOB': 'Tecnología', 'MU': 'Tecnología', 'ARM': 'Tecnología', 'AVGO': 'Tecnología',
        'AMZN': 'Comercio Minorista', 'NFLX': 'Servicios Consumo', 'KO': 'Consumo', 'PEP': 'Consumo', 'WMT': 'Comercio Minorista', 'MCD': 'Servicios Consumo', 'NKE': 'Consumo', 'DIS': 'Servicios Consumo', 'BABA': 'Comercio Minorista', 'MELI': 'Comercio Minorista', 'UBER': 'Transporte', 'TSLA': 'Automotriz', 'NIO': 'Automotriz',
        'JPM': 'Finanzas', 'V': 'Finanzas', 'MA': 'Finanzas', 'BAC': 'Finanzas', 'XP': 'Finanzas', 'PYPL': 'Finanzas', 'SQ': 'Finanzas', 'COIN': 'Finanzas', 'UPST': 'Finanzas',
        'YPFD.BA': 'Mercado AR', 'PAMP.BA': 'Mercado AR', 'CEPU.BA': 'Mercado AR', 'TGSU2.BA': 'Mercado AR', 'EDN.BA': 'Mercado AR', 'CRES.BA': 'Mercado AR', 'ALUA.BA': 'Mercado AR', 'TXAR.BA': 'Mercado AR', 'BMA.BA': 'Mercado AR', 'GGAL.BA': 'Mercado AR',
        'LLY': 'Salud', 'SPY': 'ETFs', 'BA': 'Industrial', 'YPF': 'Energía', 'CVX': 'Energía', 'BTC-USD': 'Criptomonedas'
    };

    // Agrupar stocks por sector
    const sectors = {};
    let totalMarketWeight = 0;

    globalStocksData.forEach(stock => {
        const sector = sectorMapping[stock.symbol] || 'Otros';
        if (!sectors[sector]) sectors[sector] = { stocks: [], weight: 0 };
        
        let weight = 1;
        // Asignamos un peso ligeramente mayor a empresas gigantes reales para destacarlas visualmente sin romper el grid, 
        // en vez de usar Precio*Volumen que da números desproporcionados como sucedió con Bitcoin.
        if (['AAPL','MSFT','NVDA','GOOGL','AMZN','META'].includes(stock.symbol)) {
            weight = 2; // Mega caps
        } else if (['TSLA','AMD','NFLX','BTC-USD','AVGO'].includes(stock.symbol)) {
            weight = 1.5; // Large caps
        } else {
            weight = 1.0; // Otros
        }

        sectors[sector].stocks.push({ ...stock, weight });
        sectors[sector].weight += weight;
        totalMarketWeight += weight;
    });

    // Ordenar sectores por peso (más grandes primero)
    const sortedSectors = Object.keys(sectors).sort((a, b) => sectors[b].weight - sectors[a].weight);

    sortedSectors.forEach(sectorName => {
        const sectorData = sectors[sectorName];
        const sectorStocks = sectorData.stocks;
        
        // Ordenar cada sector por tamaño de acción
        sectorStocks.sort((a, b) => b.weight - a.weight);

        // Porcentaje de espacio que este sector debería ocupar aproximadamente
        const sectorFlexTarget = (sectorData.weight / totalMarketWeight) * 100;
        const sectorFlexBasis = Math.max(120, sectorFlexTarget * 12); // Sin límite superior fijo

        const sectorDiv = document.createElement('div');
        // Usa weight como factor de crecimiento para distribución real en el Heatmap
        sectorDiv.style.flex = `${sectorData.weight} 1 ${sectorFlexBasis}px`; 
        sectorDiv.style.display = 'flex';
        sectorDiv.style.flexDirection = 'column';
        sectorDiv.style.border = '1px solid #111'; // Borde oscuro entre sectores
        sectorDiv.style.backgroundColor = '#000';
        sectorDiv.style.minHeight = '100px'; // Para que no colapsen
        
        const sectorTitle = document.createElement('div');
        sectorTitle.textContent = sectorName;
        sectorTitle.style.fontSize = '0.7rem';
        sectorTitle.style.color = '#ccc';
        sectorTitle.style.padding = '2px 4px';
        sectorTitle.style.backgroundColor = '#111';
        sectorTitle.style.whiteSpace = 'nowrap';
        sectorTitle.style.overflow = 'hidden';
        sectorTitle.style.textOverflow = 'ellipsis';
        
        const blocksContainer = document.createElement('div');
        blocksContainer.style.display = 'flex';
        blocksContainer.style.flexWrap = 'wrap';
        blocksContainer.style.flex = '1'; // fill remaining space inside sector
        blocksContainer.style.alignContent = 'flex-start'; // Vuelve a rellenar naturalmente de arriba hacia abajo
        blocksContainer.style.width = '100%';

        sectorStocks.forEach(stock => {
            const change = parseFloat(stock.changePercent);
            const block = document.createElement('div');
            
            // Calculamos el espacio flex: flex-grow proporcional al peso
            const stockFlexBasis = Math.max(40, (stock.weight / sectorData.weight) * 200);

            block.style.flex = `${stock.weight} 1 ${stockFlexBasis}px`;
            block.style.display = 'flex';
            block.style.flexDirection = 'column';
            block.style.justifyContent = 'center';
            block.style.alignItems = 'center';
            block.style.border = '1px solid #111'; // TradingView style dark borders
            block.style.boxSizing = 'border-box';
            block.style.minHeight = '45px'; // Vuelve la altura estandar original
            block.style.overflow = 'hidden';
            block.style.padding = '2px';

            const intensity = Math.min(Math.abs(change) / 4, 1);
            if (change >= 0) {
                // TV Green #089981
                if (change > 2) block.style.backgroundColor = '#089981';
                else if (change > 0) block.style.backgroundColor = `rgba(8, 153, 129, ${0.4 + (intensity * 0.6)})`;
                else block.style.backgroundColor = '#434651'; // Neutral
            } else {
                // TV Red #f23645
                if (change < -2) block.style.backgroundColor = '#f23645';
                else block.style.backgroundColor = `rgba(242, 54, 69, ${0.4 + (intensity * 0.6)})`;
            }

            // Para acciones grandes, mostrar texto un poco más grande
            const symbolSize = stockFlexBasis > 60 ? '0.9rem' : '0.7rem';
            const changeSize = stockFlexBasis > 60 ? '0.75rem' : '0.6rem';

            const isArg = stock.symbol.endsWith('.BA');
            const displaySymbol = isArg ? stock.symbol.replace('.BA', '') : stock.symbol;
            const flag = isArg ? ' 🇦🇷' : '';

            block.innerHTML = `
                <span style="font-weight: 700; color: #fff; line-height: 1; font-size: ${symbolSize};">${displaySymbol}${flag}</span>
                <span style="color: #fff; line-height: 1; margin-top: 2px; font-size: ${changeSize};">${change > 0 ? '+' : ''}${change.toFixed(2)}%</span>
            `;

            block.title = `${stock.name}: $${stock.price}`;
            block.style.cursor = 'pointer';
            
            // Efecto Hover sutil
            block.onmouseenter = () => { block.style.filter = 'brightness(1.2)'; };
            block.onmouseleave = () => { block.style.filter = 'brightness(1)'; };
            
            // Click -> Scroll a la tarjeta
            block.onclick = () => {
                const searchInput = document.getElementById('searchInput');
                if (searchInput) {
                    searchInput.value = stock.symbol;
                    searchTerm = stock.symbol.toLowerCase();
                    activeFilter = 'all';
                    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                    const allBtn = document.querySelector('.filter-btn[data-filter="all"]');
                    if(allBtn) allBtn.classList.add('active');
                    
                    refreshUI(); 
                    
                    setTimeout(() => {
                        const card = document.getElementById(`card-${stock.symbol}`);
                        if (card) {
                            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            card.style.transition = 'box-shadow 0.3s ease';
                            card.style.boxShadow = '0 0 20px 5px var(--accent-blue)';
                            setTimeout(() => card.style.boxShadow = '', 1500);
                        }
                    }, 100);
                }
            };

            blocksContainer.appendChild(block);
        });

        // Añadir fantasmas (spacers invisibles) para evitar que la última fila se estire desproporcionadamente
        for(let i=0; i<4; i++) {
            const spacer = document.createElement('div');
            spacer.style.flex = `1 1 40px`; 
            spacer.style.height = `0px`; 
            spacer.style.margin = `0`;
            spacer.style.padding = `0`;
            spacer.style.border = `none`;
            blocksContainer.appendChild(spacer);
        }

        sectorDiv.appendChild(sectorTitle);
        sectorDiv.appendChild(blocksContainer);
        heatmapContainer.appendChild(sectorDiv);
    });
}

// --- Integración Modal TradingView Avanzado ---
window.openTradingViewModal = (symbol) => {
    const modal = document.getElementById('stockModal');
    const modalBody = document.getElementById('modalBody');
    
    // Adaptar símbolo para el widget de TV
    let tvSymbol = symbol;
    if (symbol.endsWith('.BA')) {
        tvSymbol = 'BCBA:' + symbol.replace('.BA', '');
    } else {
        tvSymbol = 'NASDAQ:' + symbol; // Default, funcionará en la gran mayoría
    }

    modalBody.innerHTML = `
        <h2 style="margin-bottom: 1rem; color: var(--text-primary);">Análisis Técnico de ${symbol}</h2>
        <div style="height: 500px; width: 100%; border-radius: 8px; overflow: hidden; background: #000;">
            <div class="tradingview-widget-container" style="height:100%;width:100%">
              <div id="tradingview_${symbol.replace('.','')}" style="height:100%;width:100%"></div>
            </div>
        </div>
        <p style="margin-top: 1rem; font-size: 0.8rem; color: var(--text-secondary);">Gráfico interactivo proveído por TradingView. Puedes dibujar, agregar indicadores técnicos y modificar la temporalidad libremente acá arriba.</p>
    `;
    
    modal.style.display = 'block';

    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/tv.js';
    script.async = true;
    script.onload = () => {
        new window.TradingView.widget({
          "autosize": true,
          "symbol": tvSymbol,
          "interval": "D",
          "timezone": "Etc/UTC",
          "theme": "dark",
          "style": "1",
          "locale": "es",
          "enable_publishing": false,
          "backgroundColor": "#111827",
          "gridColor": "#1f2937",
          "hide_top_toolbar": false,
          "hide_legend": false,
          "save_image": false,
          "container_id": `tradingview_${symbol.replace('.','')}`,
        });
    };
    modalBody.appendChild(script);
};

// Lógica de cierre del Modal
const modal = document.getElementById('stockModal');
const closeBtn = document.querySelector('.close-modal');
if (closeBtn && modal) {
    closeBtn.onclick = function() {
        modal.style.display = "none";
        document.getElementById('modalBody').innerHTML = '';
    }
    window.onclick = function(event) {
        if (event.target == modal) {
            modal.style.display = "none";
            document.getElementById('modalBody').innerHTML = '';
        }
    }
}

function renderBuffettIndicator() {
    const container = document.getElementById('buffettContainer');
    if (!container) return;

    let buffettValue = "Cargando";
    let extraInfo = "Mide la Capitalización Total del Mercado de EE.UU. en relación con su PIB. <br><em>Valor de referencia estimado.</em>";

    if (globalMacroData && globalMacroData.buffettIndicator) {
        buffettValue = globalMacroData.buffettIndicator;
        const formattedDate = new Date(globalMacroData.lastUpdated).toLocaleDateString();
        extraInfo = `Cap. Total de Mercado ($${globalMacroData.marketCap}B) rel. a PIB de EE.UU. ($${globalMacroData.gdp}B). <br><em>Actualizado: ${formattedDate} (Fuente: FRED)</em>`;
    }

    let color = '';
    let statusText = '';

    if (buffettValue < 75) {
        statusText = 'Significativamente Infravalorado';
        color = 'var(--accent-green)';
    } else if (buffettValue < 90) {
        statusText = 'Ligeramente Infravalorado';
        color = 'var(--accent-green)';
    } else if (buffettValue < 115) {
        statusText = 'Justamente Valorado';
        color = 'var(--text-primary)';
    } else if (buffettValue < 140) {
        statusText = 'Ligeramente Sobrevalorado';
        color = 'var(--accent-red)';
    } else {
        statusText = 'Significativamente Sobrevalorado';
        color = 'var(--accent-red)';
    }

    // Calcula el porcentaje visual para la barra (min 50%, max 250%)
    let fillPercentage = ((buffettValue - 50) / (250 - 50)) * 100;
    fillPercentage = Math.max(0, Math.min(100, fillPercentage));

    container.innerHTML = `
        <div class="macro-title" style="font-size: 0.75rem;">Índice Buffett</div>
        <div class="macro-value" style="font-size: 1.1rem; color: ${color}">${buffettValue}%</div>
        <div class="macro-desc" style="font-weight: 600; font-size: 0.7rem; line-height: 1.1; color: ${color}">${statusText}</div>
    `;

    // Pasamos extraInfo a un tooltip nativo del TITLE en caso de que sea string normal
    if (extraInfo) {
        container.title = extraInfo.replace(/<[^>]*>?/gm, ''); // Removemos etiquetas HTML para el tooltip
    }
}

function renderCclIndicator() {
    const container = document.getElementById('cclContainer');
    const valueEl = document.getElementById('cclValue');
    const recEl = document.getElementById('cclRecommendation');
    if (!container || !valueEl || !recEl) return;

    if (!globalMacroData || !globalMacroData.ccl) {
        valueEl.textContent = "No Data";
        return;
    }

    const currentCcl = globalMacroData.ccl;
    valueEl.textContent = `$${currentCcl.toFixed(2)}`;

    let historyDates = [];
    let historyPrices = [];

    // We parse the history data
    if (globalCclHistory) {
        // Sort by date key
        const sortedDates = Object.keys(globalCclHistory).sort();
        historyDates = sortedDates.slice(-30); // Last 30 points max
        historyPrices = historyDates.map(d => globalCclHistory[d]);
    }

    // Add current price if today is not in history yet
    const todayStr = new Date().toISOString().split('T')[0];
    if (historyDates.length === 0 || historyDates[historyDates.length - 1] !== todayStr) {
        historyDates.push(todayStr);
        historyPrices.push(currentCcl);
    }

    let recommendationHTML = `<span style="color: var(--text-secondary)">Pocos datos históricos para recomendar.</span>`;

    // Only make recommendations if we have at least exactly 1 point of history or more? Better need average.
    // For now, let's make a rudimentary avg since we just started collecting data.
    if (historyPrices.length > 2) {
        const avgCcl = historyPrices.reduce((a, b) => a + b, 0) / historyPrices.length;

        if (currentCcl < avgCcl * 0.98) {
            // CCL is more than 2% below its recent average
            recommendationHTML = `<span style="color: var(--accent-green)">CCL BAJO (Favorece compra de CEDEARs)</span>`;
        } else if (currentCcl > avgCcl * 1.02) {
            // CCL is more than 2% above its recent average
            recommendationHTML = `<span style="color: var(--accent-red)">CCL ALTO (Riesgo en CEDEARs, favorece Locales)</span>`;
            // In a real scenario we might adjust this logic heavily
        } else {
            recommendationHTML = `<span style="color: var(--text-primary)">CCL Estable (En Promedio)</span>`;
        }
    } else {
        recommendationHTML = `<span style="color: var(--text-secondary)">Empezando a recolectar historial.</span>`;
    }

    recEl.innerHTML = recommendationHTML;

    // Render Chart
    const ctx = document.getElementById('cclChart').getContext('2d');

    if (chartInstances['cclChart']) {
        chartInstances['cclChart'].destroy();
    }

    chartInstances['cclChart'] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: historyDates.map(d => d.slice(5)), // MM-DD
            datasets: [{
                label: 'CCL',
                data: historyPrices,
                borderColor: '#0ea5e9',
                backgroundColor: 'rgba(14, 165, 233, 0.1)',
                borderWidth: 2,
                pointRadius: 2,
                fill: true,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { enabled: true }
            },
            scales: {
                x: { display: true, ticks: { font: { size: 8 } } },
                y: { display: false } // Hide Y axis to keep it clean in sidebar
            }
        }
    });

}

function renderNewMacroIndicators() {
    const vixContainer = document.getElementById('vixValue');
    const vixRec = document.getElementById('vixRecommendation');
    const us10yContainer = document.getElementById('us10yValue');
    const us10yRec = document.getElementById('us10yRecommendation');
    
    // Elementos de nuevas métricas
    const capeContainer = document.getElementById('capeValue');
    const capeRec = document.getElementById('capeRecommendation');
    const tobinContainer = document.getElementById('tobinValue');
    const tobinRec = document.getElementById('tobinRecommendation');
    const eyContainer = document.getElementById('eyValue');
    const eyRec = document.getElementById('eyRecommendation');

    if (!globalMacroData) return;

    if (globalMacroData.vix) {
        vixContainer.textContent = globalMacroData.vix.toFixed(2);
        if (globalMacroData.vix > 30) {
            vixContainer.style.color = 'var(--accent-red)';
            vixRec.innerHTML = `<span style="color: var(--accent-red)">Pánico: Alto Riesgo</span>`;
        } else if (globalMacroData.vix < 20) {
            vixContainer.style.color = 'var(--accent-green)';
            vixRec.innerHTML = `<span style="color: var(--accent-green)">Calma: Riesgo Bajo</span>`;
        } else {
            vixContainer.style.color = 'var(--text-primary)';
            vixRec.innerHTML = `<span style="color: var(--text-primary)">Normal</span>`;
        }
    }

    if (globalMacroData.us10y) {
        us10yContainer.textContent = `${globalMacroData.us10y.toFixed(2)}%`;
        if (globalMacroData.us10y > 4.5) {
            us10yContainer.style.color = 'var(--accent-red)';
            us10yRec.innerHTML = `<span style="color: var(--accent-red)">Presión (Renta Variable sufre)</span>`;
        } else if (globalMacroData.us10y < 3.5) {
            us10yContainer.style.color = 'var(--accent-green)';
            us10yRec.innerHTML = `<span style="color: var(--accent-green)">Dinamismo de Capital</span>`;
        } else {
            us10yContainer.style.color = 'var(--text-primary)';
            us10yRec.innerHTML = `<span style="color: var(--text-primary)">Estable</span>`;
        }
    }
    
    // --- Lógica para Nuevos Indicadores Estáticos / Calculados Proxy ---
    // Usamos valores del backend si existen, sino asignamos valores recientes del mercado reales hoy.
    const capeValue = globalMacroData.capeRatio || 34.6; 
    const tobinQ = globalMacroData.tobinQ || 1.68;
    
    // Earnings Yield (S&P500 proxy PE ~ 25.5 hoy)
    const sp500PE = globalMacroData.sp500PE || 25.4;
    const earningsYield = (1 / sp500PE) * 100;
    
    const currentUs10y = globalMacroData.us10y || 4.25;
    const eySpread = earningsYield - currentUs10y;

    if (capeContainer) {
        capeContainer.textContent = capeValue.toFixed(1);
        if (capeValue > 30) {
            capeContainer.style.color = 'var(--accent-red)';
            capeRec.innerHTML = `<span style="color: var(--accent-red)">Muy Sobrevalorado</span>`;
        } else if (capeValue < 20) {
            capeContainer.style.color = 'var(--accent-green)';
            capeRec.innerHTML = `<span style="color: var(--accent-green)">Valuación Atractiva</span>`;
        } else {
            capeContainer.style.color = 'var(--text-primary)';
            capeRec.innerHTML = `<span style="color: var(--text-primary)">Promedio Histórico</span>`;
        }
    }

    if (tobinContainer) {
        tobinContainer.textContent = tobinQ.toFixed(2);
        if (tobinQ > 1.5) {
            tobinContainer.style.color = 'var(--accent-red)';
            tobinRec.innerHTML = `<span style="color: var(--accent-red)">Mercado Caro (>1)</span>`;
        } else if (tobinQ < 1.0) {
            tobinContainer.style.color = 'var(--accent-green)';
            tobinRec.innerHTML = `<span style="color: var(--accent-green)">Bajo Costo Reemplazo</span>`;
        } else {
            tobinContainer.style.color = 'var(--text-primary)';
            tobinRec.innerHTML = `<span style="color: var(--text-primary)">Ligeramente Alto</span>`;
        }
    }

    if (eyContainer) {
        eyContainer.textContent = eySpread > 0 ? `+${eySpread.toFixed(2)}%` : `${eySpread.toFixed(2)}%`;
        if (eySpread < 0) {
            // Bonos pagan más que las ganancias de las empresas
            eyContainer.style.color = 'var(--accent-red)';
            eyRec.innerHTML = `<span style="color: var(--accent-red)">Riesgo: Renta Fija (Bonos) atrae capital</span>`;
        } else if (eySpread > 2) {
            eyContainer.style.color = 'var(--accent-green)';
            eyRec.innerHTML = `<span style="color: var(--accent-green)">Renta Variable (Acciones) muy atractiva</span>`;
        } else {
            eyContainer.style.color = 'var(--text-primary)';
            eyRec.innerHTML = `<span style="color: var(--text-primary)">Mercado Neutro / Competitivo</span>`;
        }
    }
}



function renderHistorial() {
    if (!historialContainer) return;
    historialContainer.innerHTML = '<h3 style="margin-bottom: 1rem;">Historial de Operaciones</h3>';
    
    if (closedTrades.length === 0) {
        historialContainer.innerHTML += '<p style="color:var(--text-secondary);">No hay operaciones cerradas registradas.</p>';
        return;
    }

    let wins = 0;
    let netProfit = 0;
    
    let tableHtml = `
    <div style="overflow-x: auto;">
    <table style="width:100%; text-align:left; border-collapse: collapse; margin-top: 1rem; font-size: 0.9rem;">
        <thead>
            <tr style="border-bottom: 1px solid var(--border-color); color: var(--text-secondary);">
                <th style="padding: 0.75rem;">Fecha</th>
                <th style="padding: 0.75rem;">Activo</th>
                <th style="padding: 0.75rem;">Entrada</th>
                <th style="padding: 0.75rem;">Salida</th>
                <th style="padding: 0.75rem;">P/L ($)</th>
                <th style="padding: 0.75rem;">P/L (%)</th>
            </tr>
        </thead>
        <tbody>
    `;

    // Sort by most recent
    const sortedTrades = [...closedTrades].reverse();

    sortedTrades.forEach(trade => {
        if (trade.profit > 0) wins++;
        netProfit += trade.profit;
        
        const dateStr = new Date(trade.date).toLocaleDateString();
        const color = trade.profit >= 0 ? "var(--accent-green)" : "var(--accent-red)";
        const sign = trade.profit >= 0 ? "+" : "";

        tableHtml += `
            <tr style="border-bottom: 1px solid var(--border-color);">
                <td style="padding: 0.75rem; color:var(--text-secondary);">${dateStr}</td>
                <td style="padding: 0.75rem; font-weight: bold;">${trade.symbol}</td>
                <td style="padding: 0.75rem;">$${trade.entryPrice.toFixed(2)}</td>
                <td style="padding: 0.75rem;">$${trade.exitPrice.toFixed(2)}</td>
                <td style="padding: 0.75rem; color:${color}; font-weight:bold;">${sign}$${trade.profit.toFixed(2)}</td>
                <td style="padding: 0.75rem; color:${color};">${sign}${trade.profitPct.toFixed(2)}%</td>
            </tr>
        `;
    });

    tableHtml += '</tbody></table></div>';
    
    const winRate = (wins / closedTrades.length) * 100;
    const netColor = netProfit >= 0 ? "var(--accent-green)" : "var(--accent-red)";
    const netSign = netProfit >= 0 ? "+" : "";

    const statsHtml = `
        <div style="display:flex; justify-content: space-around; background: var(--card-bg); padding: 1.5rem; border-radius: 8px; margin-bottom: 1.5rem; border: 1px solid var(--border-color); flex-wrap: wrap; gap: 1rem; text-align: center;">
            <div style="flex: 1;"><span style="color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase;">Operaciones</span><br><b style="font-size: 1.25rem;">${closedTrades.length}</b></div>
            <div style="flex: 1;"><span style="color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase;">Win Rate</span><br><b style="font-size: 1.25rem;">${winRate.toFixed(1)}%</b></div>
            <div style="flex: 1;"><span style="color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase;">Beneficio Neto</span><br><b style="color:${netColor}; font-size: 1.25rem;">${netSign}$${netProfit.toFixed(2)}</b></div>
        </div>
    `;

    historialContainer.innerHTML += statsHtml + tableHtml;
}


// --- FASE 1: VISUAL BACKTESTING ---
let btChartInstance = null;

window.openBacktestModal = (symbol) => {
    document.getElementById('backtestModal').style.display = 'block';
    window.currentBtSymbol = symbol;
    document.getElementById('btSymbolTitle').innerText = `Simulando Oportunidad - ${symbol}`;
    // We execute default instantly
    executeBacktestUI();
};

window.executeBacktestUI = () => {
    if (!window.currentBtSymbol) return;
    
    document.getElementById('btResults').innerHTML = 'Simulando pacientemente...';
    
    // Slight timeout for UI refresh
    setTimeout(() => {
        const symbol = window.currentBtSymbol;
        const config = {
            capital: parseFloat(document.getElementById('btCapital').value) || 10000,
            stopLossPct: parseFloat(document.getElementById('btSl').value) / 100 || 0.05,
            takeProfitPct: parseFloat(document.getElementById('btTp').value) / 100 || 0.15,
            trailingStopPct: parseFloat(document.getElementById('btTs').value) / 100 || 0.03,
            term: document.getElementById('btTerm').value
        };
        
        const stockData = globalStocksData.find(s => s.symbol === symbol);
        if (!stockData || !stockData.history || !stockData.history.prices || stockData.history.prices.length < 50) {
            document.getElementById('btResults').innerHTML = '<span style="color:var(--accent-red);">Error: No hay historial de datos para simular ('+symbol+').</span>';
            return;
        }
        
        let stockHistory = [];
        const h = stockData.history;
        for(let i = 50; i < h.prices.length; i++) {
            stockHistory.push({
                symbol: symbol,
                price: h.prices[i],
                ema20: h.ema20 ? h.ema20[i] : null,
                sma50: h.sma50 ? h.sma50[i] : null,
                sma200: h.sma200 ? h.sma200[i] : null,
                rsi: h.rsi ? h.rsi[i] : 50,
                macd: { histogram: (h.macd && h.macd[i]) ? h.macd[i].histogram : 0 },
                support: stockData.support,
                resistance: stockData.resistance,
                peRatio: stockData.peRatio,
                epsGrowth: stockData.epsGrowth,
                roe: stockData.roe,
                history: {
                    prices: h.prices.slice(0, i + 1),
                    macd: h.macd ? h.macd.slice(0, i + 1) : []
                },
                date: h.dates[i]
            });
        }

        const results = window.runBacktest(stockHistory, config);
        
        if (!results) {
            document.getElementById('btResults').innerHTML = 'Error en backtest (sin datos).';
            return;
        }

        const colorClasses = results.totalReturn >= 0 ? "var(--accent-green)" : "var(--accent-red)";
        
        document.getElementById('btResults').innerHTML = `
            <div style="flex:1; min-width: 100px; text-align:center;"><span style="color:var(--text-secondary); font-size:0.75rem;">CAPITAL FINAL</span><br><b style="font-size:1.2rem; color:${colorClasses};">$${results.finalCapital.toFixed(2)}</b></div>
            <div style="flex:1; min-width: 100px; text-align:center;"><span style="color:var(--text-secondary); font-size:0.75rem;">RETORNO</span><br><b style="font-size:1.2rem; color:${colorClasses};">${(results.totalReturn*100).toFixed(2)}%</b></div>
            <div style="flex:1; min-width: 100px; text-align:center;"><span style="color:var(--text-secondary); font-size:0.75rem;">WIN RATE</span><br><b style="font-size:1.2rem; color:var(--text-primary);">${(results.winRate*100).toFixed(1)}%</b></div>
            <div style="flex:1; min-width: 100px; text-align:center;"><span style="color:var(--text-secondary); font-size:0.75rem;">MAX DRAWDOWN</span><br><b style="font-size:1.2rem; color:var(--accent-red);">${(results.maxDrawdown*100).toFixed(1)}%</b></div>
            <div style="flex:1; min-width: 100px; text-align:center;"><span style="color:var(--text-secondary); font-size:0.75rem;">PROFIT FACTOR</span><br><b style="font-size:1.2rem; color:var(--text-primary);">${results.profitFactor}</b></div>
            <div style="flex:1; min-width: 100px; text-align:center;"><span style="color:var(--text-secondary); font-size:0.75rem;">TRADES</span><br><b style="font-size:1.2rem; color:var(--text-primary);">${results.trades.length}</b></div>
        `;

        if (btChartInstance) {
            btChartInstance.destroy();
        }

        const ctx = document.getElementById('btChart').getContext('2d');
        const labels = results.equityCurve.map(x => x.date);
        const dataEq = results.equityCurve.map(x => x.value);

        // Fetch original price history overlay
        /* stockData fetched above */
        let dataPrice = [];
        if (stockData && stockData.history) {
            const startIdx = stockData.history.dates.indexOf(labels[0]);
            if (startIdx !== -1) {
                dataPrice = stockData.history.prices.slice(startIdx);
            }
        }

        btChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Curva de Capital (Equity)',
                        data: dataEq,
                        borderColor: '#0ea5e9',
                        backgroundColor: 'rgba(14, 165, 233, 0.1)',
                        borderWidth: 2,
                        yAxisID: 'y',
                        fill: true,
                        tension: 0.1,
                        pointRadius: 0
                    },
                    {
                        label: 'Precio Activo',
                        data: dataPrice.length > 0 ? dataPrice : null,
                        borderColor: '#9ca3af',
                        borderWidth: 1,
                        yAxisID: 'y1',
                        fill: false,
                        tension: 0.1,
                        pointRadius: 0
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { labels: { color: '#f9fafb' } }
                },
                scales: {
                    x: { ticks: { color: '#9ca3af' }, grid: { color: '#1f2937' } },
                    y: { 
                        type: 'linear', display: true, position: 'left',
                        ticks: { color: '#0ea5e9' }, grid: { color: '#1f2937' }
                    },
                    y1: { 
                        type: 'linear', display: true, position: 'right',
                        ticks: { color: '#9ca3af' }, grid: { drawOnChartArea: false }
                    }
                }
            }
        });

    }, 100);
};

