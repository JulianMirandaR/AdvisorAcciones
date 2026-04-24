// --- Analysis Logic ---
// (Note: `stocks` array and `generateStockData` removed as requested)
import { RealDataService, auth, db } from './realData.js';
// mlModel.js is now handled by uiFeatures.js
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";
import { analyzeStockWithMarketCondition, getMarketCondition } from './analysisEngine.js';
import { handlePredictAI, handleOpenNewsModal } from './uiFeatures.js';
import { runWalkForwardBacktest } from './walkForwardEngine.js';

// Helper to keep track of chart instances (moved to top to avoid initialization errors)
const chartInstances = {};

window.strategyMode = 'hybrid'; // "trend", "reversal", "hybrid"

window.setStrategyMode = (mode) => {
    window.strategyMode = mode;
    if (typeof refreshUI === 'function') refreshUI();
};

window.aiPredictionCache = {};
window.predictAI = (symbol) => handlePredictAI(symbol, globalStocksData, refreshUI);
window.openNewsModal = (symbol) => handleOpenNewsModal(symbol, globalStocksData);
window.runWalkForwardBacktest = runWalkForwardBacktest;

// (El motor de recomendaciones se ha extraído a analysisEngine.js)
// (El motor de recomendaciones se ha extraído a analysisEngine.js)

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
let activeSort = 'general'; // general, short, long
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
window.authInitialized = false; // Flag para saber si Firebase ya resolvió el auth
window.autoTradingEnabled = JSON.parse(localStorage.getItem('advisor_auto_trade') || 'false');
window.simCapital = JSON.parse(localStorage.getItem('advisor_sim_capital') || '10000'); // Capital simulado base para auto-trading
window.autoPortfolio = JSON.parse(localStorage.getItem('advisor_auto_portfolio') || '[]');
window.autoClosedTrades = JSON.parse(localStorage.getItem('advisor_auto_closed_trades') || '[]');

window.removeFromAutoPortfolio = (index, exitReason = "Cierre manual o externo", currentMarketCondition = "Desconocido") => {
    const pos = window.autoPortfolio[index];
    const stockData = globalStocksData.find(s => s.symbol === pos.symbol);
    if (stockData) {
        const currentPrice = parseFloat(stockData.price);
        const profit = (currentPrice - pos.price) * pos.qty;
        const profitPct = ((currentPrice - pos.price) / pos.price) * 100;
        
        window.autoClosedTrades.push({
            symbol: pos.symbol,
            entryPrice: pos.price,
            exitPrice: currentPrice,
            qty: pos.qty,
            profit: profit,
            profitPct: profitPct,
            date: new Date().toISOString(),
            exitReason: exitReason,
            entryReason: pos.entryReason || "Desconocido",
            executionScore: pos.executionScore || null,
            marketCondition: currentMarketCondition
        });
        localStorage.setItem('advisor_auto_closed_trades', JSON.stringify(window.autoClosedTrades));
    }

    window.autoPortfolio.splice(index, 1);
    localStorage.setItem('advisor_auto_portfolio', JSON.stringify(window.autoPortfolio));
    if (window.cloudSynced) window.syncDataToFirebase();
    if (currentTerm === 'bot_portfolio') renderPortfolio(true);
};

window.toggleAutoTrading = () => {
    window.autoTradingEnabled = !window.autoTradingEnabled;
    localStorage.setItem('advisor_auto_trade', JSON.stringify(window.autoTradingEnabled));
    if (window.cloudSynced) window.syncDataToFirebase();
    window.updateAutoTradeUI();
    
    if (window.autoTradingEnabled) {
        window.addNotification("🤖 Bot de Auto-Trading ACTIVADO. Invertirá automáticamente en señales de Compra Fuerte, Alta Confianza o Setups Estratégicos.", "info");
        // Trigger a check immediately to see if there are pending signals
        if (globalStocksData.length > 0) {
            checkNotifications();
            refreshUI();
        }
    } else {
        window.addNotification("🤖 Bot de Auto-Trading DESACTIVADO. Operaciones pausadas.", "info");
    }
};

window.updateAutoTradeUI = () => {
    const btn = document.getElementById('autoTradeBtn');
    if (btn) {
        if (window.autoTradingEnabled) {
            btn.style.backgroundColor = 'var(--accent-green)';
            btn.style.boxShadow = '0 0 8px var(--accent-green)';
        } else {
            btn.style.backgroundColor = 'var(--accent-red)';
            btn.style.boxShadow = '0 0 5px var(--accent-red)';
        }
    }
};

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
        localStorage.setItem('advisor_unread_notifs', '0');
    }
};

window.deleteNotification = (id, event) => {
    if (event) event.stopPropagation();
    window.notifications = window.notifications.filter(n => n.id !== id);
    localStorage.setItem('advisor_notifications', JSON.stringify(window.notifications));
    window.renderNotifications();
};

window.goToActivo = (symbol) => {
    // Si estamos en la pestaña Mi Portafolio o Historial, ir a la vista general primero (o sólo buscar en general)
    const allTab = document.querySelector('.tab-btn[data-term="all"]');
    if (allTab) allTab.click(); // Esto hace refreshUI() y cambia la vista
    
    // Configurar búsqueda
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.value = symbol;
        // Disparar evento para que se actualice
        const event = new Event('input', { bubbles: true });
        searchInput.dispatchEvent(event);
    }
    
    // Cerrar el dropdown de notificaciones
    const dropdown = document.getElementById('notifDropdown');
    if (dropdown && dropdown.classList.contains('show')) {
        window.toggleNotifications();
    }
};

window.addNotification = (message, type = 'info', symbol = null) => {
    const now = new Date();
    window.notifications.unshift({
        id: now.getTime(),
        message,
        type,
        symbol,
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
        let unread = parseInt(localStorage.getItem('advisor_unread_notifs') || '0');
        unread += 1;
        localStorage.setItem('advisor_unread_notifs', unread.toString());
        
        const badge = document.getElementById('notifBadge');
        if (badge) {
            badge.textContent = unread;
            badge.style.display = 'inline-block';
        }
    } else {
        window.renderNotifications();
    }
};

// Initial boot logic para mostrar el numerito en recargas
setTimeout(() => {
    let unread = parseInt(localStorage.getItem('advisor_unread_notifs') || '0');
    if (unread > 0) {
        const badge = document.getElementById('notifBadge');
        if (badge) {
            badge.textContent = unread;
            badge.style.display = 'inline-block';
        }
    }
}, 500);

window.renderNotifications = () => {
    const body = document.getElementById('notifBody');
    if (!body) return;
    
    if (window.notifications.length === 0) {
        body.innerHTML = '<div class="notif-empty">No tienes notificaciones aún.</div>';
        return;
    }
    
    body.innerHTML = window.notifications.map(n => `
        <div class="notif-item ${n.type}" ${n.symbol ? `onclick="window.goToActivo('${n.symbol}')"` : ''} style="display:flex; justify-content:space-between; align-items:flex-start; ${n.symbol ? 'cursor:pointer;' : ''}" title="${n.symbol ? 'Ir al activo' : ''}">
            <div style="flex: 1; padding-right: 10px;">
                ${n.message}
                <span class="notif-time">${n.time}</span>
            </div>
            <button onclick="window.deleteNotification(${n.id}, event)" style="background:transparent; border:none; color:var(--text-secondary); cursor:pointer; font-size:1.2rem; padding: 0 4px; line-height: 1;" title="Borrar notificación">&times;</button>
        </div>
    `).join('');
};

// --- AUTO TRADING BOT ENGINE ---
const BOT_SIGNALS = {
    STRONG_BUY: 'COMPRA FUERTE',
    BUY: 'COMPRA',
    SETUP: 'SETUP',
    SELL: 'VENTA',
    WEAK: 'DEBIL'
};

function calculateExecutionScore(stock, analysis) {
    let score = 0;
    const sig = analysis.signal;
    const aiData = analysis.ai;

    if (sig === BOT_SIGNALS.STRONG_BUY) score += 4;
    if (analysis.confirmationLevel === 'ALTA CONFIANZA') score += 3;
    if (analysis.setupDetected) score += 2;
    if (analysis.largo_plazo && analysis.largo_plazo.score >= 0) score += 2;
    
    // Volumen
    const vol = parseFloat(stock.volume) || 0;
    const avgVol = parseFloat(stock.avgVolume) || 1;
    if ((vol / avgVol) > 1.2) score += 1;
    
    // Alineación Timeframes
    if (analysis.corto_plazo && analysis.corto_plazo.score > 0 && 
        analysis.largo_plazo && analysis.largo_plazo.score > 0) score += 1;

    // AI Boost Predict (Solo confirmación, nunca trigger primario)
    if (aiData && aiData.usable) {
        if (aiData.probability > 0.6) score += 1;
        if ((aiData.strength * 100) > 60) score += 1;
    }

    return Math.max(0, Math.min(12, score));
}

function validateEntry(analysis) {
    // Filtro estricto Multi-Timeframe
    if (analysis.largo_plazo.score < 6 || analysis.corto_plazo.score < 5) {
        return { valid: false, reason: "CONFLICTO DE TIMEFRAME" };
    }
    return { valid: true };
}

function executeTrade(stock, analysis, executionScore, reasonStr) {
    // Control de Exposición (Máximo 5 operaciones activas)
    const MAX_POSITIONS = 5;
    if (window.autoPortfolio.length >= MAX_POSITIONS) return false;

    // Position Sizing (Asignación del 20% del capital por operación, para usar el 100% en 5 operaciones máx)
    const POSITION_SIZE_PCT = 0.20;
    const usdTradeAmount = window.simCapital * POSITION_SIZE_PCT;
    
    const isArg = stock.symbol.endsWith('.BA');
    const ccl = (globalMacroData && globalMacroData.ccl) ? parseFloat(globalMacroData.ccl) : 1200;
    
    // Si la acción se compra en pesos, adaptamos la magnitud del capital usando el tipo de cambio
    const tradeAmountNominal = isArg ? (usdTradeAmount * ccl) : usdTradeAmount;
    const qty = tradeAmountNominal / stock.price;
    
    const currStr = isArg ? 'AR$' : 'U$D';
    window.addNotification(`🤖 Auto-Trade: COMPRANDO ${qty.toFixed(2)} reps de ${stock.symbol} por ${currStr} ${tradeAmountNominal.toFixed(2)} (${reasonStr} | Score: ${executionScore})`, 'buy', stock.symbol);
    
    window.autoPortfolio.push({
        symbol: stock.symbol,
        price: parseFloat(stock.price),
        highestPrice: parseFloat(stock.price),
        qty: qty,
        takenProfit: false,
        executionScore: executionScore,
        entryReason: reasonStr,
        marketCondition: analysis.contexto_mercado
    });
    return true;
}

function manageOpenPositions(stock, analysis, prevSignal) {
    const autoPosIndex = window.autoPortfolio.findIndex(p => p.symbol === stock.symbol);
    if (autoPosIndex === -1) return false;
    
    const autoPos = window.autoPortfolio[autoPosIndex];
    let sold = false;
    let partialSale = false;
    let sellReason = '';

    const currentPrice = parseFloat(stock.price);
    
    // Tracker: Trailing Stop progresivo (5%)
    if (currentPrice > autoPos.highestPrice) {
        autoPos.highestPrice = currentPrice;
    }
    const trailingStopPct = 0.05;
    const trailingStopPrice = autoPos.highestPrice * (1 - trailingStopPct);

    // Salida por debilidad analítica general (< 4 score)
    if (analysis.score < 4) {
        sold = true;
        sellReason = `Debilidad detectada (Score general: ${analysis.score})`;
    } 
    // Salida por Trailing Stop Real (Dinámico de 5%)
    else if (currentPrice < trailingStopPrice) {
        sold = true;
        sellReason = `Trailing Stop (5%) ejecutado. Pico histórico: $${autoPos.highestPrice.toFixed(2)}`;
    } 
    // Salidas por transiciones a Venta del Core Engine
    else if ((analysis.signal.includes('VENTA') || analysis.signal.includes('DEBIL')) && prevSignal && (!prevSignal.includes('VENTA') && !prevSignal.includes('DEBIL'))) {
        sold = true;
        sellReason = `Señal técnica de ${analysis.signal}`;
    } 
    // Venta Seguridad Máxima (Hard Stop estático)
    else if (analysis.actionFlag === 'STOP_LOSS') {
        sold = true;
        sellReason = "Stop Loss de seguridad portafolio";
    } 
    // FASE 6 - Take Profit (Salida Parcial)
    else if (analysis.actionFlag === 'TAKE_PROFIT') {
        if (!autoPos.takenProfit) {
            autoPos.qty = autoPos.qty / 2; // Cierra 50%
            autoPos.takenProfit = true;
            window.addNotification(`🤖 Auto-Trade: TAKE PROFIT PARCIAL (50%) en ${stock.symbol}`, 'sell', stock.symbol);
            partialSale = true;
        }
    }

    if (sold) {
        if (window.autoTradingEnabled) {
            window.addNotification(`🤖 Auto-Trade: VENDIENDO ${stock.symbol} - ${sellReason}`, 'sell', stock.symbol);
            window.removeFromAutoPortfolio(autoPosIndex, sellReason, analysis.contexto_mercado);
        }
        return true; 
    }
    
    // Si modificamos tamaño (Take Profit) o actualizamos highestPrice, regresamos true
    // para indicar que ocurrió un cambio que necesita persistir en localStorage.
    if (partialSale || currentPrice === autoPos.highestPrice) {
        return true;
    }
    
    return false;
}
// ------------------------------

function checkNotifications() {
    const vix = globalMacroData && globalMacroData.vix ? globalMacroData.vix : 25;
    const marketCondition = getMarketCondition(vix);
    
    let hasChanges = false;
    let hasBotChanges = false;
    
    globalStocksData.forEach(stock => {
        const portfolioPos = portfolio.find(p => p.symbol === stock.symbol);
        const portfolioInfo = portfolioPos ? { entryPrice: portfolioPos.price, highestPrice: portfolioPos.highestPrice } : null;
        
        // Auto bot info
        const autoPos = window.autoPortfolio.find(p => p.symbol === stock.symbol);
        
        // Use default analysis logic
        const analysis = analyzeStockWithMarketCondition(stock, 'all', marketCondition, portfolioInfo);
        const sig = analysis.signal;
        const currentAction = analysis.actionFlag || sig;
        const prevSignal = window.lastKnownSignals[stock.symbol];
        
        // 1. Accion comprada (en portfolio) da para venta
        if (portfolioPos) {
            // Signal cambió a venta?
            if ((sig.includes('VENTA') || sig.includes('DEBIL')) && prevSignal && (!prevSignal.includes('VENTA') && !prevSignal.includes('DEBIL'))) {
                window.addNotification(`Tu posición ${stock.symbol} ahora da señal de ${sig}. ¡Revisa tu portafolio!`, 'sell', stock.symbol);
            }
            // Stop Loss o Take Profit alert
            if (analysis.actionFlag === 'STOP_LOSS' && prevSignal !== 'STOP_LOSS') {
                window.addNotification(`⚠️ ALERTA: ${stock.symbol} ha tocado tu Stop Loss. Considera cerrar posición.`, 'sell', stock.symbol);
            }
            if (analysis.actionFlag === 'TAKE_PROFIT' && prevSignal !== 'TAKE_PROFIT') {
                window.addNotification(`✅ ALERTA: ${stock.symbol} ha alcanzado objetivo de Take Profit.`, 'buy', stock.symbol);
            }
        } 
        
        if (autoPos) {
            // Delega la gestión de salidas (Ventas y Trailing Stops) a FASE 5, 6
            const stateModified = manageOpenPositions(stock, analysis, prevSignal);
            if (stateModified) hasBotChanges = true;
        }
        
        // 2. Accion (no en portfolio) da de compra confirmada
        if (!portfolioPos && !autoPos) {
            const isNewBuySignal = (sig === 'COMPRA' || sig === 'COMPRA FUERTE') && prevSignal && prevSignal !== 'COMPRA' && prevSignal !== 'COMPRA FUERTE';

            // Alerta visual para el usuario (solo notifica en transiciones)
            if (isNewBuySignal) {
                if (analysis.confirmationLevel === 'ALTA CONFIANZA') {
                    window.addNotification(`🚀 OPORTUNIDAD: ${stock.symbol} generó señal de ${sig} (Confirmada con IA).`, 'buy', stock.symbol);
                } else {
                    window.addNotification(`📈 OPORTUNIDAD: ${stock.symbol} generó señal de ${sig}.`, 'buy', stock.symbol);
                }
            }

            // Lógica del Bot Motor Cuantitativo (FASE 1 a 4)
            if (window.autoTradingEnabled) {
                const execScore = calculateExecutionScore(stock, analysis);
                
                // Condición de entrada principal: Score de ejecución válido >= 7
                if (execScore >= 7) {
                    const validation = validateEntry(analysis);
                    
                    if (validation.valid) {
                        let reasonStr = `Score: ${execScore}`;
                        if (analysis.setupDetected) reasonStr += ` | Setup: ${analysis.setupDetected}`;
                        
                        // FASE 3, 4 y 9 - Ejecución modular y control
                        const tradeExecuted = executeTrade(stock, analysis, execScore, reasonStr);
                        if (tradeExecuted) hasBotChanges = true;
                    } else {
                        // FASE 2: Conflicto TimeFrame. No notificamos para evitar spam, pero 
                        // se podría loguear si es requerido de forma invisible.
                    }
                }
            }
        }
        
        // 3. Revisar Alertas de Precio Personalizadas
        window.priceAlerts.forEach(alert => {
            if (!alert.triggered && alert.symbol === stock.symbol) {
                if ((alert.direction === 'up' && stock.price >= alert.targetPrice) ||
                    (alert.direction === 'down' && stock.price <= alert.targetPrice)) {
                    window.addNotification(`🎯 ALERTA DE PRECIO: ${stock.symbol} cruzó tu objetivo de $${alert.targetPrice.toFixed(2)} (Actual: $${stock.price})`, 'buy', stock.symbol);
                    alert.triggered = true;
                    hasChanges = true; // Forzamos guardar la alerta
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
    
    if (hasBotChanges) {
        localStorage.setItem('advisor_auto_portfolio', JSON.stringify(window.autoPortfolio));
        if (window.cloudSynced) window.syncDataToFirebase();
    }
}
// ---------------------------------

window.togglePortfolioTerm = (term) => {
    window.portfolioTerm = term;
    renderPortfolio();
};


function renderMarketStatus() {
    let now = new Date();
    if (typeof globalMacroData !== 'undefined' && globalMacroData && globalMacroData.lastUpdated) {
        now = new Date(globalMacroData.lastUpdated);
    }
    const today = now.toLocaleDateString();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    let usageInfo = `<br><span style="font-size: 0.8rem; color: var(--accent-green);">Actualización de precios automática desde la nube activa</span>`;

    marketStatus.innerHTML = `
        <span class="status-indicator status-up"></span>
        <div>
            Datos del Mercado para: ${today} a las ${time}
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
        renderMarketStatus(); // We update the timestamp here once macro data is loaded
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
    
    // --- CARGANDO SESIÓN ---
    if (!window.authInitialized) {
        container.style.display = 'flex';
        container.innerHTML = `
            <div style="text-align:center; padding: 4rem 1rem; width: 100%;">
                <div class="loader-spinner" style="margin: 0 auto 1.5rem auto;"></div>
                <h2 style="margin-bottom: 1rem;">Verificando Sesión...</h2>
                <p style="color: var(--text-secondary); margin-bottom: 2rem;">Sincronizando con la nube.</p>
            </div>
        `;
        controlsContainer.style.display = 'none';
        portfolioContainer.style.display = 'none';
        if (historialContainer) historialContainer.style.display = 'none';
        
        const heatmap = document.getElementById('marketHeatmap');
        if (heatmap) heatmap.style.display = 'none';
        heatmap.previousElementSibling.style.display = 'none'; 
        document.querySelector('.tabs').style.display = 'none';
        return;
    }

    // --- ACCESO RESTRINGIDO SI NO HAY SESIÓN ---
    if (!window.cloudSynced) {
        container.style.display = 'flex';
        container.innerHTML = `
            <div style="text-align:center; padding: 4rem 1rem; width: 100%;">
                <h2 style="margin-bottom: 1rem;">Acceso Restringido</h2>
                <p style="color: var(--text-secondary); margin-bottom: 2rem;">Por favor, inicia sesión para ver las recomendaciones del mercado y gestionar tu portafolio.</p>
                <button class="action-btn" onclick="document.getElementById('authModal').style.display='flex'">Ingresar / Crear Cuenta</button>
            </div>
        `;
        controlsContainer.style.display = 'none';
        portfolioContainer.style.display = 'none';
        if (historialContainer) historialContainer.style.display = 'none';
        
        // Ocultar mapa de calor y pestañas si están logueados
        const heatmap = document.getElementById('marketHeatmap');
        if (heatmap) heatmap.style.display = 'none';
        heatmap.previousElementSibling.style.display = 'none'; // h4 titulo del heatmap
        document.querySelector('.tabs').style.display = 'none';
        
        return;
    }

    // Asegurarse de restaurar visibilidad cuando sí hay sesión
    const heatmap = document.getElementById('marketHeatmap');
    if (heatmap) heatmap.style.display = 'flex';
    if (heatmap && heatmap.previousElementSibling) heatmap.previousElementSibling.style.display = 'block';
    if (document.querySelector('.tabs')) document.querySelector('.tabs').style.display = 'flex';

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
        
        renderPortfolio(false);
        return;
    } else if (currentTerm === 'historial') {
        container.style.display = 'none';
        controlsContainer.style.display = 'none';
        portfolioContainer.style.display = 'none';
        if (historialContainer) historialContainer.style.display = 'block';
        
        renderHistorial(false);
        return;
    } else if (currentTerm === 'bot_portfolio') {
        container.style.display = 'none';
        controlsContainer.style.display = 'none';
        portfolioContainer.style.display = 'block';
        if (historialContainer) historialContainer.style.display = 'none';
        
        renderPortfolio(true);
        return;
    } else if (currentTerm === 'bot_historial') {
        container.style.display = 'none';
        controlsContainer.style.display = 'none';
        portfolioContainer.style.display = 'none';
        if (historialContainer) historialContainer.style.display = 'block';
        
        renderHistorial(true);
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
    analyzedStocks.sort((a, b) => {
        if (activeSort === 'short') {
            return b.analysis.corto_plazo.score - a.analysis.corto_plazo.score;
        } else if (activeSort === 'long') {
            return b.analysis.largo_plazo.score - a.analysis.largo_plazo.score;
        } else {
            return b.analysis.score - a.analysis.score;
        }
    });





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
const filterBtns = document.querySelectorAll('.filters .filter-btn');
const sortBtns = document.querySelectorAll('.sorts .sort-btn');

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

sortBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        sortBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeSort = btn.dataset.sort;
        refreshUI();
    });
});

window.toggleWatchlist = (symbol, event) => {
    if (event) event.stopPropagation(); // prevent modal open if any

    const index = watchlist.indexOf(symbol);
    if (index === -1) {
        watchlist.push(symbol);
    }
    localStorage.setItem('advisor_watchlist', JSON.stringify(watchlist));
    if (window.cloudSynced) window.syncDataToFirebase();
    refreshUI();
};

window.clearPortfolio = (isBot) => {
    if(!confirm('¿Estás seguro que deseas vaciar este portafolio por completo? No podrás recuperarlo.')) return;
    if (isBot) {
        window.autoPortfolio = [];
        localStorage.setItem('advisor_auto_portfolio', JSON.stringify(window.autoPortfolio));
    } else {
        portfolio = [];
        localStorage.setItem('advisor_portfolio', JSON.stringify(portfolio));
    }
    if (window.cloudSynced) window.syncDataToFirebase();
    renderPortfolio(isBot);
};

window.clearHistory = (isBot) => {
    if(!confirm('¿Estás seguro que deseas vaciar el historial de operaciones por completo?')) return;
    if (isBot) {
        window.autoClosedTrades = [];
        localStorage.setItem('advisor_auto_closed_trades', JSON.stringify(window.autoClosedTrades));
    } else {
        closedTrades = [];
        localStorage.setItem('advisor_closed_trades', JSON.stringify(closedTrades));
    }
    if (window.cloudSynced) window.syncDataToFirebase();
    renderHistorial(isBot);
};

window.removeFromHistory = (index, isBot) => {
    if (!confirm('¿Eliminar permanentemente este registro del historial?')) return;
    if (isBot) {
        window.autoClosedTrades.splice(index, 1);
        localStorage.setItem('advisor_auto_closed_trades', JSON.stringify(window.autoClosedTrades));
    } else {
        closedTrades.splice(index, 1);
        localStorage.setItem('advisor_closed_trades', JSON.stringify(closedTrades));
    }
    if (window.cloudSynced) window.syncDataToFirebase();
    renderHistorial(isBot);
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
    if(window.cloudSynced) window.syncDataToFirebase();
    renderPortfolio();
};

let currentAddSymbol = '';

window.addToPortfolioPrompt = (symbol) => {
    const stockData = globalStocksData.find(s => s.symbol === symbol);
    if (!stockData) return;

    currentAddSymbol = symbol;
    document.getElementById('addPortfolioSymbolText').innerText = symbol;
    document.getElementById('addPortfolioPrice').value = stockData.price;
    document.getElementById('addPortfolioQty').value = 10;
    
    // Mostramos el modal custom
    document.getElementById('addPortfolioModal').style.display = 'flex';
};

window.confirmAddToPortfolio = () => {
    if (!currentAddSymbol) return;

    const priceInput = document.getElementById('addPortfolioPrice').value;
    const qtyInput = document.getElementById('addPortfolioQty').value;

    const price = parseFloat(priceInput);
    const qty = parseFloat(qtyInput);

    if (isNaN(price) || isNaN(qty) || price <= 0 || qty <= 0) {
        window.addNotification("Por favor, ingresa números válidos mayores a 0.", "error");
        return;
    }

    portfolio.push({
        symbol: currentAddSymbol,
        price: price,
        highestPrice: price,
        qty: qty
    });

    localStorage.setItem('advisor_portfolio', JSON.stringify(portfolio));
    if(window.cloudSynced) window.syncDataToFirebase();
    
    // Ocultar modal y dar feedback
    document.getElementById('addPortfolioModal').style.display = 'none';
    window.addNotification(`✅ ${currentAddSymbol} añadida a tu portafolio exitosamente.`, "success");
    renderPortfolio();
};

function renderPortfolio(isBot = false) {
    let targetPortfolio = isBot ? window.autoPortfolio : portfolio;
    portfolioContainer.innerHTML = isBot ? '<h4>Portafolio Simulado (Bot Auto-Trading)</h4>' : '<h4>Mi Portafolio V1</h4>';

    let totalValue = 0;
    let totalInvestment = 0;

    let tableHtml = `
    <div style="overflow-x: auto;">
    <table class="portfolio-table" style="width:100%; text-align:left; border-collapse: collapse; margin-top: 1rem; font-size: 0.9rem;">
        <thead>
            <tr style="border-bottom: 1px solid var(--border-color); color: var(--text-secondary);">
                <th style="padding: 0.75rem;">Activo</th>
                <th style="padding: 0.75rem;">Cant.</th>
                <th style="padding: 0.75rem;">Invertido</th>
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

    if (targetPortfolio.length === 0) {
        portfolioContainer.innerHTML += isBot ? '<p style="text-align:center; padding: 2rem; color: var(--text-secondary);">El portafolio del bot está vacío. Encendelo y espera a que la IA encuentre oportunidades.</p>' : '<p style="text-align:center; padding: 2rem; color: var(--text-secondary);">El portafolio está vacío. Añade acciones desde la lista principal clickeando en "+ Portafolio".</p>';
        return;
    }

    let hasPortfolioChanges = false;

    targetPortfolio.forEach((pos, index) => {
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

        const isArg = pos.symbol.endsWith('.BA');
        const ccl = (globalMacroData && globalMacroData.ccl) ? parseFloat(globalMacroData.ccl) : 1200;
        const curStr = isArg ? 'AR$' : 'U$D';

        // Normalizar montos al Dólar CCL o USD oficial para los totales generales
        let usdInv = inv;
        let usdCurrentVal = currentVal;
        if (isArg && ccl > 0) {
            usdInv = inv / ccl;
            usdCurrentVal = currentVal / ccl;
        }

        totalInvestment += usdInv;
        totalValue += usdCurrentVal;

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

        let botTrackingHtml = '';
        if (isBot) {
            const reason = pos.entryReason ? pos.entryReason : 'Motor Cuantitativo';
            const trailingLevel = pos.highestPrice ? (pos.highestPrice * 0.95).toFixed(2) : '--';
            botTrackingHtml = `<br><span style="font-size:0.7rem; color:var(--text-secondary); display:block; margin-top:2px;">Razón: ${reason} <br> <span style="color:var(--accent-red)">Stop: ${curStr} ${trailingLevel}</span></span>`;
        }

        const displaySymbol = isArg ? pos.symbol.replace('.BA', '') : pos.symbol;
        const flag = isArg ? ' 🇦🇷' : '';
        
        const deleteBtnHtml = isBot ? `<button onclick="removeFromAutoPortfolio(${index})" style="background:var(--accent-red); color:white; border:none; padding: 0.2rem 0.6rem; border-radius:4px; cursor:pointer;" title="Forzar Venta">Vender</button>` : `<button onclick="removeFromPortfolio(${index})" style="background:var(--accent-red); color:white; border:none; padding: 0.2rem 0.6rem; border-radius:4px; cursor:pointer;" title="Eliminar">🗑️</button>`;

        tableHtml += `
            <tr style="border-bottom: 1px solid var(--border-color); transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='rgba(255,255,255,0.02)'" onmouseout="this.style.backgroundColor='transparent'">
                <td style="padding: 0.75rem; cursor: pointer; color: var(--accent-blue);" onclick="window.goToActivo('${pos.symbol}')" title="Ver análisis de ${displaySymbol}"><b style="font-size:1.1em">${displaySymbol}${flag}</b>${botTrackingHtml}</td>
                <td style="padding: 0.75rem;">${qty.toFixed(2)}</td>
                <td style="padding: 0.75rem;">${curStr} ${inv.toFixed(2)}</td>
                <td style="padding: 0.75rem;">${curStr} ${basePrice.toFixed(2)}</td>
                <td style="padding: 0.75rem;">${curStr} ${currentPrice.toFixed(2)}</td>
                <td style="padding: 0.75rem; color: ${colorClass};">${sign}${plPct.toFixed(2)}%</td>
                <td style="padding: 0.75rem; color: ${colorClass}; font-weight: bold;">${sign}${curStr} ${pl.toFixed(2)}</td>
                <td style="padding: 0.75rem; vertical-align: middle;">${signalBadge}</td>
                <td style="padding: 0.75rem;">${deleteBtnHtml}</td>
            </tr>
        `;
    });

    tableHtml += `</tbody></table></div>`;

    if (hasPortfolioChanges) {
        if (isBot) {
            localStorage.setItem('advisor_auto_portfolio', JSON.stringify(targetPortfolio));
            if(window.cloudSynced) window.syncDataToFirebase();
        } else {
            localStorage.setItem('advisor_portfolio', JSON.stringify(targetPortfolio));
            if(window.cloudSynced) window.syncDataToFirebase();
        }
    }

    // Summary
    const totalPl = totalValue - totalInvestment;
    const totalPlPct = totalInvestment > 0 ? (totalPl / totalInvestment) * 100 : 0;
    const summaryColor = totalPl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
    const summarySign = totalPl >= 0 ? '+' : '';

    const summaryHtml = `        <div style="display:flex; justify-content: space-around; background: var(--card-bg); padding: 1.5rem; border-radius: 8px; margin-bottom: 1.5rem; border: 1px solid var(--border-color); flex-wrap: wrap; gap: 1rem; text-align: center;">
            <div style="flex: 1;"><span style="color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase;">Inversión Total (USD)</span><br><b style="font-size: 1.25rem;">U$D ${totalInvestment.toFixed(2)}</b></div>
            <div style="flex: 1;"><span style="color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase;">Valor Actual (USD)</span><br><b style="font-size: 1.25rem;">U$D ${totalValue.toFixed(2)}</b></div>
            <div style="flex: 1;"><span style="color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase;">Rendimiento Total (USD)</span><br><b style="color:${summaryColor}; font-size: 1.25rem;">${summarySign}U$D ${totalPl.toFixed(2)} (${summarySign}${totalPlPct.toFixed(2)}%)</b></div>
        </div>
        
        <!-- FASE 5: PIE CHART -->
        <div style="display: flex; flex-wrap: wrap; justify-content: center; gap: 2rem; margin-bottom: 1rem; padding: 1rem; background: var(--card-bg); border-radius: 8px; border: 1px solid var(--border-color);">
            <div style="width: 250px; height: 250px;">
                <canvas id="portfolioPieChart"></canvas>
            </div>
        </div>
`;

    const toggleHtml = `
        <div style="margin-bottom: 1rem; display:flex; justify-content: space-between; align-items:center; flex-wrap:wrap; gap:1rem;">
            <div>
                <button onclick="window.clearPortfolio(${isBot})" style="background:transparent; color:var(--text-secondary); border:1px solid var(--border-color); padding: 0.3rem 0.8rem; border-radius:4px; cursor:pointer; font-size:0.8rem; transition:0.2s;" onmouseover="this.style.color='var(--accent-red)'; this.style.borderColor='var(--accent-red)';" onmouseout="this.style.color='var(--text-secondary)'; this.style.borderColor='var(--border-color)';">🗑️ Vaciar Portafolio</button>
            </div>
            <div>
                <span style="font-size: 0.85rem; color: var(--text-secondary); margin-right: 0.5rem;">Señal de Recomendación:</span>
                <button onclick="togglePortfolioTerm('short')" style="padding: 0.3rem 0.8rem; cursor: pointer; border-radius: 4px; border: 1px solid var(--border-color); background: ${window.portfolioTerm === 'short' ? 'var(--accent-blue)' : 'var(--card-bg)'}; color: ${window.portfolioTerm === 'short' ? '#fff' : 'var(--text-primary)'}; font-size: 0.8rem;">Corto Plazo</button>
                <button onclick="togglePortfolioTerm('long')" style="padding: 0.3rem 0.8rem; cursor: pointer; border-radius: 4px; border: 1px solid var(--border-color); background: ${window.portfolioTerm === 'long' ? 'var(--accent-blue)' : 'var(--card-bg)'}; color: ${window.portfolioTerm === 'long' ? '#fff' : 'var(--text-primary)'}; font-size: 0.8rem; margin-left: 0.5rem;">Largo Plazo</button>
            </div>
        </div>
    `;

    portfolioContainer.innerHTML = '<h3 style="margin-bottom: 1rem;">Analítica de Portafolio</h3>' + summaryHtml + toggleHtml + tableHtml;

    // Render Phase 5 Pie
    setTimeout(() => {
        if(window.portPieChart) window.portPieChart.destroy();
        const ctxPie = document.getElementById('portfolioPieChart');
        if(!ctxPie) return;
        
        const labels = targetPortfolio.map(p => p.symbol);
        const dataValues = targetPortfolio.map(p => {
            const st = globalStocksData.find(s => s.symbol === p.symbol);
            const currentPrice = st ? st.price : p.price;
            let val = currentPrice * p.qty;
            const isArg = p.symbol.endsWith('.BA');
            const ccl = (globalMacroData && globalMacroData.ccl) ? parseFloat(globalMacroData.ccl) : 1200;
            if (isArg && ccl > 0) val = val / ccl;
            return val;
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
window.updateAutoTradeUI();
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

    const pointsToShow = -250;
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
        if (err.code === 'auth/invalid-login-credentials' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') {
            errorEl.innerText = "Error: Credenciales inválidas. Verifica tu contraseña o elige 'Crear Cuenta' si eres nuevo.";
        } else if (err.code === 'auth/email-already-in-use') {
            errorEl.innerText = "Error: Este correo ya tiene una cuenta. Haz clic en 'Ingresar'.";
        } else {
            errorEl.innerText = "Error: " + err.message;
        }
        errorEl.style.display = 'block';
    }
};

// Monitor de estado de autenticación (Se ejecuta automáticamente cuando Firebase detecta estado)
onAuthStateChanged(auth, async (user) => {
    window.authInitialized = true;
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
                
                // --- Sincronización del Bot de Trading ---
                if (d.autoTradingEnabled !== undefined) {
                    window.autoTradingEnabled = d.autoTradingEnabled;
                    localStorage.setItem('advisor_auto_trade', JSON.stringify(window.autoTradingEnabled));
                    if(typeof window.updateAutoTradeUI === 'function') window.updateAutoTradeUI();
                }
                if (d.autoPortfolio) {
                    window.autoPortfolio = d.autoPortfolio;
                    localStorage.setItem('advisor_auto_portfolio', JSON.stringify(window.autoPortfolio));
                }
                if (d.autoClosedTrades) {
                    window.autoClosedTrades = d.autoClosedTrades;
                    localStorage.setItem('advisor_auto_closed_trades', JSON.stringify(window.autoClosedTrades));
                }
                
            }
        } catch(e) {
            console.error("Error cargando perfil nube", e);
        }
        if(typeof refreshUI === 'function') refreshUI();
    } else {
        window.cloudSynced = false;
        document.getElementById('cloudStatusText').innerText = "Iniciar Sesión";
        document.getElementById('cloudStatusText').style.color = "inherit";
        if (typeof refreshUI === 'function') refreshUI(); // Actualizar UI para ocultar panel
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
           autoTradingEnabled: window.autoTradingEnabled,
           autoPortfolio: window.autoPortfolio,
           autoClosedTrades: window.autoClosedTrades,
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

// Modal de Noticias gestionado por uiFeatures.js

// --- BONUS: Backtesting Engine Integrado ---
// Función disponible globalmente para usarse desde la consola de desarrollador
/**
 * Ejecuta una simulación de operaciones a lo largo del historial de datos.
 * @param {Array} stockHistory - Array de días (Ej: resultado de un mapeo previo que contenga { price, rsi, macd, ema20... })
 * @param {String} term - "short" (por defecto) o "long"
 */
window.runBacktest = function(stockHistoryChronological, config = {}) {
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
        stopLossPct = -0.05,
        takeProfitPct = 0.15,
        trailingStopPct = 0.03, // Ignored mostly as we use ATR dynamically now
        slippagePct = 0.2,
        commissionPct = 0.1,
        term = 'short',
        marketCondition = 'SIDEWAYS'
    } = config;

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
            if (signal.includes("COMPRA") || signal.includes("PRE-COMPRA")) {
                const investAmount = currentCapital * positionSizePct;
                const priceWithSlippage = currentPrice * (1 + (slippagePct / 100));
                const commission = investAmount * (commissionPct / 100);
                
                const finalInvestAmount = investAmount - commission;
                const qty = finalInvestAmount / priceWithSlippage;

                position = {
                    entryDate: dayData.date,
                    entryPrice: priceWithSlippage,
                    qty: qty,
                    highestPrice: priceWithSlippage,
                    investedAmount: investAmount
                };
                currentCapital -= investAmount;
            }
        } else {
            // Evaluando Salida
            let exitReason = null;
            const floatProfitPct = (currentPrice - position.entryPrice) / position.entryPrice;
            
            // Hard Stops (Safety net)
            if (floatProfitPct <= stopLossPct) {
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
    const totalReturn = (currentCapital - capital) / capital;

    const result = {
        initialCapital: capital,
        finalCapital: currentCapital,
        totalReturn: totalReturn,
        winRate: winRate,
        maxDrawdown: maxDrawdown,
        profitFactor: profitFactor === Infinity ? "Infinity" : profitFactor.toFixed(2),
        trades: trades,
        equityCurve: equityCurve
    };
    
    return result;
};


function renderHeatmap() {
    const heatmapContainer = document.getElementById('marketHeatmap');
    if (!heatmapContainer) return;

    heatmapContainer.innerHTML = '';
    // Styling the container to look like a True Treemap (100% width filled)
    heatmapContainer.style.display = 'flex';
    heatmapContainer.style.flexWrap = 'wrap';
    heatmapContainer.style.gap = '0';
    heatmapContainer.style.backgroundColor = 'transparent';
    heatmapContainer.style.padding = '0';
    heatmapContainer.style.borderRadius = '0';
    heatmapContainer.style.width = '100%';
    // Eliminado el estiramiento vertical forzado (65vh y alignContent)

    const sectorMapping = {
        'AAPL': 'Tecnología', 'MSFT': 'Tecnología', 'GOOGL': 'Tecnología', 'META': 'Tecnología', 'NVDA': 'Tecnología', 'AMD': 'Tecnología', 'INTC': 'Tecnología', 'CRM': 'Tecnología', 'PLTR': 'Tecnología', 'SHOP': 'Tecnología', 'SPOT': 'Tecnología', 'CRWD': 'Tecnología', 'SMCI': 'Tecnología', 'ORCL': 'Tecnología', 'ADBE': 'Tecnología', 'GLOB': 'Tecnología', 'MU': 'Tecnología', 'ARM': 'Tecnología', 'AVGO': 'Tecnología',
        'AMZN': 'Consumo y Retail', 'NFLX': 'Consumo y Retail', 'KO': 'Consumo y Retail', 'PEP': 'Consumo y Retail', 'WMT': 'Consumo y Retail', 'MCD': 'Consumo y Retail', 'NKE': 'Consumo y Retail', 'DIS': 'Consumo y Retail', 'BABA': 'Consumo y Retail', 'MELI': 'Consumo y Retail', 'UBER': 'Consumo y Retail', 'TSLA': 'Consumo y Retail', 'NIO': 'Consumo y Retail',
        'JPM': 'Finanzas e Índices', 'V': 'Finanzas e Índices', 'MA': 'Finanzas e Índices', 'BAC': 'Finanzas e Índices', 'XP': 'Finanzas e Índices', 'PYPL': 'Finanzas e Índices', 'SQ': 'Finanzas e Índices', 'COIN': 'Finanzas e Índices', 'UPST': 'Finanzas e Índices', 'SPY': 'Finanzas e Índices', 'BTC-USD': 'Finanzas e Índices',
        'YPFD.BA': 'Mercado AR', 'PAMP.BA': 'Mercado AR', 'CEPU.BA': 'Mercado AR', 'TGSU2.BA': 'Mercado AR', 'EDN.BA': 'Mercado AR', 'CRES.BA': 'Mercado AR', 'ALUA.BA': 'Mercado AR', 'TXAR.BA': 'Mercado AR', 'BMA.BA': 'Mercado AR', 'GGAL.BA': 'Mercado AR',
        'LLY': 'Industria y Salud', 'BA': 'Industria y Salud', 'YPF': 'Industria y Salud', 'CVX': 'Industria y Salud'
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
        sectorDiv.style.border = '1px solid var(--border-color)';
        sectorDiv.style.backgroundColor = 'var(--card-bg)';
        sectorDiv.style.minHeight = '100px'; 
        
        const sectorTitle = document.createElement('div');
        sectorTitle.textContent = sectorName;
        sectorTitle.style.fontSize = '0.75rem';
        sectorTitle.style.fontWeight = 'bold';
        sectorTitle.style.color = 'var(--text-secondary)';
        sectorTitle.style.padding = '4px 6px';
        sectorTitle.style.backgroundColor = 'rgba(255,255,255,0.02)';
        sectorTitle.style.borderBottom = '1px solid var(--border-color)';
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



function renderHistorial(isBot = false) {
    if (!historialContainer) return;
    let targetTrades = isBot ? window.autoClosedTrades : closedTrades;
    
    const clearBtn = targetTrades.length > 0 ? `<button onclick="window.clearHistory(${isBot})" style="float:right; background:transparent; color:var(--text-secondary); border:1px solid var(--border-color); padding: 0.3rem 0.8rem; border-radius:4px; cursor:pointer; font-size:0.8rem; transition:0.2s;" onmouseover="this.style.color='var(--accent-red)'; this.style.borderColor='var(--accent-red)';" onmouseout="this.style.color='var(--text-secondary)'; this.style.borderColor='var(--border-color)';">🗑️ Limpiar Historial</button>` : '';

    historialContainer.innerHTML = isBot ? `<h3 style="margin-bottom: 1rem;">Historial de Operaciones del Bot ${clearBtn}</h3>` : `<h3 style="margin-bottom: 1rem;">Historial de Operaciones Manuales ${clearBtn}</h3>`;
    
    if (targetTrades.length === 0) {
        historialContainer.innerHTML += '<p style="color:var(--text-secondary);">No hay operaciones cerradas registradas.</p>';
        return;
    }

    let wins = 0;
    let netProfit = 0;
    
    let tableHtml = `
    <div style="overflow-x: auto;">
    <table class="portfolio-table" style="width:100%; text-align:left; border-collapse: collapse; margin-top: 1rem; font-size: 0.9rem;">
        <thead>
            <tr style="border-bottom: 1px solid var(--border-color); color: var(--text-secondary);">
                <th style="padding: 0.75rem;">Fecha</th>
                <th style="padding: 0.75rem;">Activo</th>
                <th style="padding: 0.75rem;">Cant.</th>
                <th style="padding: 0.75rem;">Invertido</th>
                <th style="padding: 0.75rem;">Entrada</th>
                <th style="padding: 0.75rem;">Salida</th>
                <th style="padding: 0.75rem;">P/L ($)</th>
                <th style="padding: 0.75rem;">P/L (%)</th>
                <th style="padding: 0.75rem;"></th>
            </tr>
        </thead>
        <tbody>
    `;

    // Sort by most recent
    const sortedTrades = targetTrades.map((t, index) => ({...t, originalIndex: index})).reverse();

    sortedTrades.forEach(trade => {
        const isArg = trade.symbol.endsWith('.BA');
        const ccl = (globalMacroData && globalMacroData.ccl) ? parseFloat(globalMacroData.ccl) : 1200;
        const curStr = isArg ? 'AR$' : 'U$D';

        let usdProfit = trade.profit;
        if (isArg && ccl > 0) {
            usdProfit = trade.profit / ccl;
        }

        if (trade.profit > 0) wins++;
        netProfit += usdProfit;
        
        const dateStr = new Date(trade.date).toLocaleDateString();
        const color = trade.profit >= 0 ? "var(--accent-green)" : "var(--accent-red)";
        const sign = trade.profit >= 0 ? "+" : "";

        const qtyStr = trade.qty ? parseFloat(trade.qty).toFixed(2) : '-';
        const investedAmount = trade.qty ? (parseFloat(trade.qty) * parseFloat(trade.entryPrice)) : 0;
        const invStr = investedAmount > 0 ? `${curStr} ${investedAmount.toFixed(2)}` : '-';

        tableHtml += `
            <tr style="border-bottom: 1px solid var(--border-color);">
                <td style="padding: 0.75rem; color:var(--text-secondary);">${dateStr}</td>
                <td style="padding: 0.75rem; font-weight: bold;">${trade.symbol}</td>
                <td style="padding: 0.75rem; color:var(--text-secondary);">${qtyStr}</td>
                <td style="padding: 0.75rem;">${invStr}</td>
                <td style="padding: 0.75rem;">${curStr} ${trade.entryPrice.toFixed(2)}</td>
                <td style="padding: 0.75rem;">${curStr} ${trade.exitPrice.toFixed(2)}</td>
                <td style="padding: 0.75rem; color:${color}; font-weight:bold;">${sign}${curStr} ${trade.profit.toFixed(2)}</td>
                <td style="padding: 0.75rem; color:${color};">${sign}${trade.profitPct.toFixed(2)}%</td>
                <td style="padding: 0.75rem; text-align:right;"><button onclick="window.removeFromHistory(${trade.originalIndex}, ${isBot})" style="background:transparent; border:none; cursor:pointer; opacity:0.6; transition:0.2s;" onmouseover="this.style.opacity='1'; this.style.transform='scale(1.1)';" onmouseout="this.style.opacity='0.6'; this.style.transform='scale(1)';" title="Borrar Fila">❌</button></td>
            </tr>
        `;
    });

    tableHtml += '</tbody></table></div>';
    
    const winRate = (wins / targetTrades.length) * 100;
    const netColor = netProfit >= 0 ? "var(--accent-green)" : "var(--accent-red)";
    const netSign = netProfit >= 0 ? "+" : "";

    const statsHtml = `
        <div style="display:flex; justify-content: space-around; background: var(--card-bg); padding: 1.5rem; border-radius: 8px; margin-bottom: 1.5rem; border: 1px solid var(--border-color); flex-wrap: wrap; gap: 1rem; text-align: center;">
            <div style="flex: 1;"><span style="color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase;">Operaciones</span><br><b style="font-size: 1.25rem;">${targetTrades.length}</b></div>
            <div style="flex: 1;"><span style="color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase;">Win Rate</span><br><b style="font-size: 1.25rem;">${winRate.toFixed(1)}%</b></div>
            <div style="flex: 1;"><span style="color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase;">Beneficio Neto (USD)</span><br><b style="color:${netColor}; font-size: 1.25rem;">${netSign}U$D ${netProfit.toFixed(2)}</b></div>
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
