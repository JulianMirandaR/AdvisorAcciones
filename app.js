// --- Analysis Logic ---
// (Note: `stocks` array and `generateStockData` removed as requested)
import { RealDataService } from './realData.js';

// Helper to keep track of chart instances (moved to top to avoid initialization errors)
const chartInstances = {};

// --- Logic para Memoria de Señales ---
const signalMemory = {};

// --- Logic for Recommendations ---

function analyzeStock(data, term, portfolioInfo = null) {
    let score = 0;
    let reasons = [];
    let signal = "NO OPERAR"; // Inicial por defecto

    const addReason = (text, type, weight) => {
        reasons.push({ text, type, weight });
    };

    const price = parseFloat(data.price) || 0;
    const sma200 = parseFloat(data.sma200) || 0;
    const ema20 = parseFloat(data.ema20) || 0;
    const sma50 = parseFloat(data.sma50) || 0;
    const stateKey = `${data.symbol}_${term}`;

    // 0. Macro Context (VIX)
    if (globalMacroData && globalMacroData.vix) {
        if (globalMacroData.vix > 30) {
            score -= 2;
            addReason(`Macro: VIX Extremo (${globalMacroData.vix.toFixed(2)}). Riesgo de alta volatilidad.`, "negative", 8);
        } else if (globalMacroData.vix < 20) {
            addReason(`Macro: VIX Bajo (${globalMacroData.vix.toFixed(2)}). Entorno favorable.`, "positive", 3);
        }
    }

    // 1. CONFIRMACIÓN Y EXTENSIÓN DE TENDENCIA
    let isUptrend = false;
    let isDowntrend = false;
    let forbidBuy = false; // Bloquea compras
    
    // Distancia a medias para detección de extensiones / inercia
    const distFromEma = (ema20 && price > 0) ? (price - ema20) / ema20 : 0;
    
    if (distFromEma > 0.04) {
        forbidBuy = true;
        score -= 3;
        addReason(`Precio sobre-extendido (>4% sobre EMA20). Entradas prohibidas.`, "negative", 125);
    }

    if (sma200 && price < sma200) {
        forbidBuy = true;
        score -= 4;
        addReason(`Tendencia general bajista (Precio < SMA 200). Compras bloqueadas.`, "negative", 120);
    }

    if (term === 'short') {
        const shortMa = ema20 || sma50;
        const maLabel = ema20 ? 'EMA 20' : 'SMA 50';

        // Única condición válida de tendencia alcista para el corto plazo
        if (ema20 && sma50 && price > ema20 && ema20 > sma50) {
            isUptrend = true;
            score += 4;
            addReason(`Tendencia alcista confirmada (Precio > EMA20 > SMA50)`, "positive", 110);
            
            // Inercia de tendencia (Evitar que una caída de 2%-4% arruine la señal si sigue > EMA20)
            if (data.changePercent && parseFloat(data.changePercent) < -2 && distFromEma > 0) {
                addReason(`Inercia activa: Retroceso diario pero tendencia intacta.`, "neutral", 90);
                score += 1; // Compensación de mantenimiento
            }
        } else {
            // Si no se cumple
            forbidBuy = true;
            if (price < shortMa) {
                isDowntrend = true;
                score -= 3;
                addReason(`Estructura de corto plazo bajista o rota.`, "negative", 100);
            } else {
                addReason(`En consolidación o débil.`, "neutral", 50);
            }
        }
    } else {
        // Largo Plazo
        if (sma200 && price > sma200) {
            isUptrend = true;
            score += 5;
            addReason(`Tendencia sólida de largo plazo (Precio > SMA 200)`, "positive", 110);
        } else {
            isDowntrend = true;
            forbidBuy = true;
        }
    }

    // 2. BOLLINGER BANDS (No perseguir extremo)
    if (data.bollinger && term === 'short') {
        if (price > parseFloat(data.bollinger.upper)) {
            score -= 4;
            forbidBuy = true;
            addReason(`Precio fuera de Banda Bollinger Superior (Exceso FOMO).`, "negative", 115);
        } else if (price < parseFloat(data.bollinger.lower)) {
            score += 0.5;
        }
    }

    // 3. MEJORA DEL MOMENTUM (Detección de aceleración/desaceleración)
    let momentumScore = 0;
    let isPositiveMomentum = false;
    let isDecelerating = false;
    let isStoppingFall = false;

    if (data.history && data.history.prices && data.history.prices.length >= 5) {
        const p = data.history.prices;
        const p0 = price;
        const p2 = p[p.length - 3]; // Hace 2-3 días
        const p4 = p[p.length - 5]; // Hace 5 días

        const recentChange = p2 > 0 ? (p0 - p2) / p2 : 0;
        const olderChange = p4 > 0 ? (p2 - p4) / p4 : 0;

        if (p0 > p4) {
            isPositiveMomentum = true;
            if (recentChange < olderChange && recentChange >= 0) {
                isDecelerating = true;
                momentumScore = 0.5;
                addReason(`Momentum alcista perdiendo fuerza (Desaceleración)`, "neutral", 85);
            } else {
                momentumScore = 2;
                addReason(`Momentum alcista acelerando`, "positive", 85);
            }
        } else {
            if (recentChange > olderChange && olderChange < -0.01) {
                isStoppingFall = true;
                momentumScore = 0.5;  // Dejó de caer agresivamente
                addReason(`Momentum negativo frenando (Posible suelo local)`, "positive", 85);
            } else {
                momentumScore = -2;
                addReason(`Momentum bajista continuo`, "negative", 85);
                if (isDowntrend) {
                    momentumScore -= 2;
                    forbidBuy = true;
                    addReason(`Anti-Caída: Momentum negativo en tendencia bajista.`, "negative", 120);
                }
            }
        }
    }
    score += momentumScore;

    // 4. MACD
    const macdHist = data.macd && data.macd.histogram !== undefined ? parseFloat(data.macd.histogram) : 0;
    const macdLine = data.macd && data.macd.line !== undefined ? parseFloat(data.macd.line) : 0;
    const macdSig = data.macd && data.macd.signal !== undefined ? parseFloat(data.macd.signal) : 0;
    
    let isMacdCrossingOrPositive = (macdHist > -0.02 || macdLine > macdSig); 
    
    if (macdHist > 0 && macdLine > macdSig) {
        score += 2;
        addReason("MACD: Tendencia y momentum alcista confirmados", "positive", 80);
    } else if (macdHist < 0 || macdLine < macdSig) {
        score -= 1.5;
    }

    // 5. RSI AMIGABLE
    const rsi = data.rsi ? parseFloat(data.rsi) : 50;
    let isRsiEarly = (rsi >= 45 && rsi <= 60);
    let isRsiIdeal = (rsi >= 40 && rsi <= 55);

    if (rsi > 65) {
        score -= 2;
        forbidBuy = true;
        addReason(`RSI > 65. Entradas prohibidas (riesgo de techo local).`, "negative", 115);
    } else if (rsi < 30) {
        if (!isMacdCrossingOrPositive) {
            score -= 4;
            forbidBuy = true;
            addReason(`RSI sobrevendido pero MACD bajista. Posible cuchillo cayendo.`, "negative", 115);
        } else if (isUptrend || isStoppingFall) {
            score += 1;
            addReason(`RSI sobrevendido frenando caída`, "positive", 60);
        }
    } else if (isRsiIdeal) {
        score += 1;
        addReason(`RSI sano en zona verde (${rsi.toFixed(1)})`, "positive", 60);
    }

    // 6. SOPORTES Y RESISTENCIAS
    const support = data.support ? parseFloat(data.support) : null;
    const resistance = data.resistance ? parseFloat(data.resistance) : null;
    let isNearSupportOrEma = false;
    let isNearResistance = false;

    if (ema20 && price > 0 && Math.abs(price - ema20) / price < 0.025) {
        isNearSupportOrEma = true;
    }

    if (support && resistance && price > 0) {
        const distToSupport = Math.abs(price - support) / price;
        const distToResist = Math.abs(resistance - price) / price;

        if (distToSupport < 0.025) {
            isNearSupportOrEma = true;
            score += 1.5;
            addReason(`Rebote en soporte técnico testeado (${support})`, "positive", 70);
        } else if (price < support) {
            score -= 3;
            addReason(`Pérdida de soporte clave.`, "negative", 85);
        }

        if (distToResist < 0.025 || price >= resistance) {
            isNearResistance = true;
            score -= 3;
            forbidBuy = true;
            addReason(`Muy cerca de resistencia (${resistance}). NO COMPRAR.`, "negative", 120);
        }
    }

    // 7. ZONA IDEAL PROGRESIVA (CORE DEL SISTEMA)
    // Nivel 1 (Early Entry): Tendencia OK, MACD asomando, RSI temprano, Sin resistencia inminente, Momentum no bajista
    if (isUptrend && isRsiEarly && !isNearResistance && (isPositiveMomentum || isStoppingFall) && isMacdCrossingOrPositive) {
        score += 2.5;
        addReason(`CORE: Setup nivel 1 (Early Entry). Condiciones tempranas alineadas.`, "positive", 125);
        
        // Nivel 2 (Compra confirmada): Se apoya en Soporte/EMA y MACD está en verde
        if (isNearSupportOrEma && macdHist > 0) {
            score += 2;
            addReason(`CORE: Setup nivel 2. Confirmación de soporte y momentum.`, "positive", 130);
            
            // Nivel 3 (Compra Fuerte): No está perdiendo fuerza
            if (!isDecelerating && isRsiIdeal) {
                score += 2;
                addReason(`CORE: Setup nivel 3. Zona ideal perfecta.`, "positive", 135);
            }
        }
    }

    // 8. OTROS (Volumen, Patrones, Estocástico, Fundamentales con peso residual)
    const avgVolume = data.avgVolume ? parseFloat(data.avgVolume) : 0;
    const volume = data.volume ? parseFloat(data.volume) : 0;
    const change = data.change ? parseFloat(data.change) : 0;
    if (avgVolume > 0 && volume > avgVolume) {
        if (change > 0 && isUptrend) score += 0.5;
        else if (change < 0 && isDowntrend) score -= 1.5;
    }

    if (data.stochastic) {
        if (parseFloat(data.stochastic.k) < 20) score += 0.5;
        if (parseFloat(data.stochastic.k) > 80) score -= 0.5;
    }

    if (data.peRatio && data.peRatio !== 'N/A') {
        const pe = parseFloat(data.peRatio);
        if (pe > 0 && pe < 15) score += 0.5;
        else if (pe > 35) score -= 0.5;
    }
    
    if (data.roe && data.roe !== 'N/A' && parseFloat(data.roe) > 15) score += 0.5;

    let patternPoints = 0;
    if (data.patterns && data.patterns.length > 0 && isUptrend) patternPoints += 0.5;
    if (data.candles && data.candles.length > 0 && isUptrend) patternPoints += 0.5;
    score += patternPoints;

    // 8.5 PORTFOLIO RISK MANAGEMENT (Trailing Stop & Take Profit)
    let actionFlag = null;
    let isTrailingStopEnforced = false;
    let isTakeProfitEnforced = false;

    if (portfolioInfo) {
        const entryPrice = parseFloat(portfolioInfo.entryPrice);
        const highestPrice = parseFloat(portfolioInfo.highestPrice);
        
        // Trailing Stop (Stop Loss Dinámico) al 8% (configurable)
        const trailingStopPct = 0.08;
        if (highestPrice > 0 && price > 0) {
            const dropFromHigh = (highestPrice - price) / highestPrice;
            if (dropFromHigh >= trailingStopPct) {
                score -= 10; // Forzar baja extrema
                forbidBuy = true;
                isTrailingStopEnforced = true;
                actionFlag = "TRAILING_STOP";
                addReason(`Trailing Stop activado (-${(dropFromHigh * 100).toFixed(1)}% desde máximo).`, "negative", 150);
            }
        }

        // Take Profit Inteligente
        if (!isTrailingStopEnforced && price > entryPrice) {
            const isRsiOverbought = rsi > 70;
            const isMacdLosingStrength = macdHist < 0 || (macdHist > 0 && isDecelerating);
            
            if ((isRsiOverbought && isMacdLosingStrength) || isNearResistance) {
                score -= 6; 
                isTakeProfitEnforced = true;
                actionFlag = "TAKE_PROFIT";
                addReason(`Take Profit inteligente por agotamiento de momentum o techo técnico.`, "negative", 140);
            }
        }
    }

    // ACORTE DE PUNTUACIÓN POR BLOQUEOS
    if (forbidBuy && score > 4) {
        score = 4; 
        addReason("Score capado a MANTENER por bloqueos estrictos.", "neutral", 100);
    }

    // 9. NUEVOS UMBRALES DE SEÑAL
    let tentativeSignal = "NO OPERAR";
    if (score >= 9) {
        tentativeSignal = "COMPRA FUERTE";
    } else if (score >= 7) {
        tentativeSignal = "COMPRA";
    } else if (score >= 5) {
        tentativeSignal = "PRE-COMPRA";
    } else if (score >= 3) {
        tentativeSignal = "MANTENER";
    } else if (score <= -9) {
        tentativeSignal = "VENTA FUERTE";
    } else if (score <= -5) {
        tentativeSignal = "VENTA";
    }

    // 10. ESTABILIDAD DE SEÑALES (No venta inmediata e inercias)
    const prev = signalMemory[stateKey];
    if (prev) {
        const diff = Math.abs(prev.score - score);
        let changed = false;

        if (diff <= 3) {
            tentativeSignal = prev.signal; // Suavizado estándar
        } else {
            changed = true;
        }

        // Regla: No venta inmediata si venía de compra o pre-compra
        if (changed && (prev.signal.includes("COMPRA") || prev.signal.includes("PRE-COMPRA"))) {
            if (tentativeSignal.includes("VENTA")) {
                let clearBreakdown = (price < sma50 && macdHist < 0);
                if (score >= -6 && !clearBreakdown && !isTrailingStopEnforced && !isTakeProfitEnforced) {
                    tentativeSignal = "MANTENER"; // Salto amortiguado
                }
            }
        }
    }
    
    signalMemory[stateKey] = { signal: tentativeSignal, score: score };
    signal = tentativeSignal;

    reasons.sort((a, b) => b.weight - a.weight);

    return { signal, score: Number(score.toFixed(1)), reasons, actionFlag };
}

// --- UI Rendering ---

const container = document.getElementById('recommendations-container');
const portfolioContainer = document.getElementById('portfolio-container');
const controlsContainer = document.querySelector('.controls-container');
const tabs = document.querySelectorAll('.tab-btn');
const marketStatus = document.getElementById('marketStatus');

let currentTerm = 'short'; // 'short' or 'long'
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
window.portfolioTerm = 'short'; // Plazo por defecto en la pestaña Mi Portafolio

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
    // Si tenemos datos, limpiamos el "Loading..." inicial y renderizamos la tabla
    if (globalStocksData.length > 0) {
        container.innerHTML = '';
    }

    if (currentTerm === 'portfolio') {
        container.style.display = 'none';
        controlsContainer.style.display = 'none';
        portfolioContainer.style.display = 'block';
        renderPortfolio();
        return;
    } else {
        container.style.display = ''; // Restore to default CSS (grid)
        controlsContainer.style.display = ''; // Restore flex
        portfolioContainer.style.display = 'none';
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
        const analysis = analyzeStock(data, currentTerm);
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

    card.innerHTML = `
        <div class="card-header">
            <div>
                <div class="stock-symbol">${displaySymbol}${flag} 
                    <span class="watchlist-star ${starClass}" onclick="toggleWatchlist('${data.symbol}', event)">★</span>
                </div>
                <div class="stock-name">${data.name}</div>
            </div>
            <div class="recommendation-badge ${badgeClass}">${analysis.signal}</div>
        </div>
        
        <div class="price-section">
            <div class="current-price">$${data.price}</div>
            <div class="price-change ${changeClass}">${changeSign}${data.change} (${changeSign}${data.changePercent}%)</div>
            <div style="margin-top: 0.5rem; display: flex; gap: 0.5rem;">
                <button onclick="addToPortfolioPrompt('${data.symbol}')" style="background:var(--card-bg); border:1px solid var(--border-color); color:var(--text-secondary); cursor:pointer; font-size: 0.8rem; padding: 0.3rem 0.6rem; border-radius: 4px;">+ Portafolio</button>
                <button onclick="openTradingViewModal('${data.symbol}')" style="background:var(--accent-blue); border:none; color:white; cursor:pointer; font-size: 0.8rem; padding: 0.3rem 0.6rem; border-radius: 4px; box-shadow: var(--glow-shadow);">📊 Gráfico Interactivo</button>
            </div>
        </div>

        <div class="analysis-grid">
            <div class="analysis-item">
                <span class="analysis-label">RSI</span>
                <span class="analysis-value" style="color: ${data.rsi < 30 || data.rsi > 70 ? 'var(--accent-blue)' : 'inherit'}">${data.rsi}</span>
            </div>
            <div class="analysis-item">
                <span class="analysis-label">Soporte/Resist.</span>
                <span class="analysis-value">${data.support} / ${data.resistance}</span>
            </div>
            <div class="analysis-item">
                <span class="analysis-label">Media (${currentTerm === 'short' ? 'EMA20' : 'SMA200'})</span>
                <span class="analysis-value">${currentTerm === 'short' ? (data.ema20 || data.sma50) : data.sma200}</span>
            </div>
            <div class="analysis-item">
                <span class="analysis-label">MACD</span>
                <span class="analysis-value">${data.macd.histogram > 0 ? 'Alcista' : 'Bajista'}</span>
            </div>
            ${fundamentalHtml}
        </div>

        <div class="signals-section">
            <div class="section-title">Análisis de Señales</div>
            <ul class="signal-list">
                ${reasonsHtml}
            </ul>
        </div>

        <div class="chart-wrapper">
            <canvas id="chart-${data.symbol}"></canvas>
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
    refreshUI();
};

window.removeFromPortfolio = (index) => {
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
            const analysis = analyzeStock(stockData, window.portfolioTerm, portfolioInfo);
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
    }

    // Summary
    const totalPl = totalValue - totalInvestment;
    const totalPlPct = totalInvestment > 0 ? (totalPl / totalInvestment) * 100 : 0;
    const summaryColor = totalPl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
    const summarySign = totalPl >= 0 ? '+' : '';

    const summaryHtml = `
        <div style="display:flex; justify-content: space-around; background: var(--card-bg); padding: 1.5rem; border-radius: 8px; margin-bottom: 1.5rem; border: 1px solid var(--border-color); flex-wrap: wrap; gap: 1rem; text-align: center;">
            <div style="flex: 1;"><span style="color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase;">Inversión Total</span><br><b style="font-size: 1.25rem;">$${totalInvestment.toFixed(2)}</b></div>
            <div style="flex: 1;"><span style="color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase;">Valor Actual</span><br><b style="font-size: 1.25rem;">$${totalValue.toFixed(2)}</b></div>
            <div style="flex: 1;"><span style="color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase;">Rendimiento Total</span><br><b style="color:${summaryColor}; font-size: 1.25rem;">${summarySign}$${totalPl.toFixed(2)} (${summarySign}${totalPlPct.toFixed(2)}%)</b></div>
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
}

// Init
renderMarketStatus();
initDashboard();

// Helper to keep track of chart instances and destroy them to avoid "Canvas is already in use" errors



function renderChart(data, canvasId) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    const color = parseFloat(data.change) >= 0 ? '#22c55e' : '#ef4444';

    if (chartInstances[canvasId]) {
        chartInstances[canvasId].destroy();
    }

    // Determine how many days to show based on standard term
    // short = 60 days (~3 months), long = 250 days (~1 year)
    const pointsToShow = currentTerm === 'short' ? -60 : -250;

    const labels = data.history.dates ? data.history.dates.slice(pointsToShow) : [];
    const prices = data.history.prices ? data.history.prices.slice(pointsToShow) : [];

    // Prepare datasets
    const datasets = [
        {
            label: 'Precio',
            data: prices,
            borderColor: color,
            backgroundColor: color,
            borderWidth: 2,
            tension: 0.1,
            pointRadius: 0, // Points only on hover
            pointHoverRadius: 4,
            fill: false,
            order: 1
        }
    ];

    // Add Indicators if available and overlapping
    // EMA 20
    if (data.history.ema20 && data.history.ema20.length > 0) {
        // Pad with nulls if shorter (though slice(-60) usually aligns from end)
        // ChartJS automatically aligns from end if labels match? No, needs same length or x/y
        // We assumed same length in realData.js slice(-60).
        datasets.push({
            label: 'EMA 20',
            data: data.history.ema20.slice(pointsToShow),
            borderColor: '#3b82f6', // Blue
            borderWidth: 1,
            borderDash: [5, 5],
            tension: 0.4,
            pointRadius: 0,
            fill: false,
            order: 2
        });
    }

    // SMA 200 (Long Term Trend)
    if (data.history.sma200 && data.history.sma200.length > 0) {
        datasets.push({
            label: 'SMA 200',
            data: data.history.sma200.slice(pointsToShow),
            borderColor: '#a855f7', // Purple
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
            order: 3
        });
    }


    chartInstances[canvasId] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels, // X-Axis Labels (Dates)
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        color: '#9ca3af',
                        font: { size: 10 },
                        boxWidth: 10
                    }
                },
                tooltip: {
                    enabled: true,
                    backgroundColor: 'rgba(17, 24, 39, 0.9)',
                    titleColor: '#f3f4f6',
                    bodyColor: '#d1d5db',
                    borderColor: '#374151',
                    borderWidth: 1
                }
            },
            scales: {
                x: {
                    display: true,
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#6b7280',
                        font: { size: 9 },
                        maxTicksLimit: 6
                    }
                },
                y: {
                    display: true,
                    grid: {
                        color: 'rgba(255, 255, 255, 0.05)'
                    },
                    ticks: {
                        color: '#6b7280',
                        font: { size: 10 }
                    }
                }
            }
        }
    });
}

// --- BONUS: Backtesting Engine Integrado ---
// Función disponible globalmente para usarse desde la consola de desarrollador
/**
 * Ejecuta una simulación de operaciones a lo largo del historial de datos.
 * @param {Array} stockHistory - Array de días (Ej: resultado de un mapeo previo que contenga { price, rsi, macd, ema20... })
 * @param {String} term - "short" (por defecto) o "long"
 */
window.runBacktest = function(stockHistory, term = 'short') {
    if (!Array.isArray(stockHistory) || stockHistory.length === 0) {
        console.error("Backtest falló: stockHistory debe ser un arreglo con datos estructurados para analyzeStock.");
        return null; 
    }

    let capital = 1000;
    let position = null; // null si no hay compradas, { entryPrice, highestPrice, qty } si sí
    let totalTrades = 0;
    let winningTrades = 0;
    let maxDrawdown = 0;
    let peakCapital = capital;

    console.log(`[Backtest] Iniciando simulación en ${stockHistory.length} días...`);

    stockHistory.forEach((dayData, index) => {
        const currentPrice = parseFloat(dayData.price);
        if (isNaN(currentPrice)) return;

        let portfolioInfo = null;
        if (position) {
            // Actualizar Tracker de Highest Price
            if (currentPrice > position.highestPrice) {
                position.highestPrice = currentPrice;
            }
            portfolioInfo = {
                entryPrice: position.entryPrice,
                highestPrice: position.highestPrice
            };
        }

        // Llamada nativa a tu capa de análisis exacta
        const analysis = analyzeStock(dayData, term, portfolioInfo);
        const signal = analysis.signal;

        if (!position) {
            // Buscando entrar (Ignoramos si bloqueado e intentamos cuando hay setup real)
            if (signal.includes("COMPRA") || signal.includes("PRE-COMPRA")) {
                const qty = capital / currentPrice;
                position = {
                    entryPrice: currentPrice,
                    qty: qty,
                    highestPrice: currentPrice
                };
                totalTrades++;
            }
        } else {
            // Buscando salir
            if (signal.includes("VENTA") || analysis.actionFlag) { // Incluye VENTA, VENTA FUERTE y flags dinámicos TS / TP
                const profit = (currentPrice - position.entryPrice) * position.qty;
                capital = currentPrice * position.qty; // Reinvertimos / Liquidamos

                if (profit > 0) winningTrades++;
                position = null; 
            }
        }

        // Evaluar Max Drawdown
        const currentEquity = position ? (currentPrice * position.qty) : capital;
        if (currentEquity > peakCapital) {
            peakCapital = currentEquity;
        } else {
            const drawdown = ((peakCapital - currentEquity) / peakCapital) * 100;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        }
    });

    // Cerrar forzosamente cualquier posición abierta al final
    if (position) {
        const lastPrice = parseFloat(stockHistory[stockHistory.length - 1].price);
        capital = lastPrice * position.qty;
        const finalProfit = (lastPrice - position.entryPrice) * position.qty;
        if (finalProfit > 0) winningTrades++;
    }

    const profitPercent = ((capital - 1000) / 1000) * 100;
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

    const result = {
        initialCapital: '$1000.00',
        finalCapital: `$${capital.toFixed(2)}`,
        profitPercent: `${profitPercent.toFixed(2)}%`,
        totalTrades: totalTrades,
        winRate: `${winRate.toFixed(2)}%`,
        maxDrawdown: `${maxDrawdown.toFixed(2)}%`
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
        'AAPL': 'Tecnología', 'MSFT': 'Tecnología', 'GOOGL': 'Tecnología', 'META': 'Tecnología', 'NVDA': 'Tecnología', 'AMD': 'Tecnología', 'INTC': 'Tecnología', 'CRM': 'Tecnología', 'PLTR': 'Tecnología', 'SHOP': 'Tecnología', 'SPOT': 'Tecnología', 'CRWD': 'Tecnología', 'SMCI': 'Tecnología', 'ORCL': 'Tecnología', 'ADBE': 'Tecnología', 'GLOB': 'Tecnología', 'MU': 'Tecnología', 'ARM': 'Tecnología',
        'AMZN': 'Comercio Minorista', 'NFLX': 'Servicios Consumo', 'KO': 'Consumo', 'PEP': 'Consumo', 'WMT': 'Comercio Minorista', 'MCD': 'Servicios Consumo', 'NKE': 'Consumo', 'DIS': 'Servicios Consumo', 'BABA': 'Comercio Minorista', 'MELI': 'Comercio Minorista', 'UBER': 'Transporte', 'TSLA': 'Automotriz',
        'JPM': 'Finanzas', 'V': 'Finanzas', 'MA': 'Finanzas', 'BAC': 'Finanzas', 'XP': 'Finanzas', 'PYPL': 'Finanzas', 'SQ': 'Finanzas', 'COIN': 'Finanzas', 'UPST': 'Finanzas',
        'YPFD.BA': 'Mercado AR', 'PAMP.BA': 'Mercado AR', 'CEPU.BA': 'Mercado AR', 'TGSU2.BA': 'Mercado AR', 'EDN.BA': 'Mercado AR', 'CRES.BA': 'Mercado AR', 'ALUA.BA': 'Mercado AR', 'TXAR.BA': 'Mercado AR', 'BMA.BA': 'Mercado AR', 'GGAL.BA': 'Mercado AR',
        'LLY': 'Salud', 'SPY': 'ETFs', 'BA': 'Industrial', 'YPF': 'Energía', 'CVX': 'Energía'
    };

    // Agrupar stocks por sector
    const sectors = {};
    let totalMarketWeight = 0;

    globalStocksData.forEach(stock => {
        const sector = sectorMapping[stock.symbol] || 'Otros';
        if (!sectors[sector]) sectors[sector] = { stocks: [], weight: 0 };
        
        // Proxy para Capitalización: Precio * Volumen Medio. Si no hay, valor fallback.
        const price = parseFloat(stock.price) || 10;
        const vol = parseFloat(stock.avgVolume) || parseFloat(stock.volume) || 1000000;
        let weight = price * vol;
        if (isNaN(weight) || weight <= 0) weight = 5000000; // mid cap fallback
        
        // Damos un poco más de peso a AR o restamos a mega caps para que no rompan el layout visualmente
        weight = Math.sqrt(weight); 

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
        const sectorFlexBasis = Math.max(150, Math.min(600, sectorFlexTarget * 15));

        const sectorDiv = document.createElement('div');
        sectorDiv.style.flex = `1 1 ${sectorFlexBasis}px`; // Flex grow and shrink
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
            
            // Calculamos el espacio flex de esta acción dentro de su sector
            const stockFlexBasis = Math.max(40, (stock.weight / sectorData.weight) * 200);

            block.style.flex = `1 1 ${stockFlexBasis}px`;
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
        <div class="macro-title">Indicador Buffett</div>
        <div class="buffett-status" style="color: ${color}; font-size: 0.85rem; text-align: center; margin-bottom: 0.5rem; line-height: 1.2;">${statusText}</div>
        <div class="buffett-value" style="color: ${color}">${buffettValue}%</div>
        <div class="buffett-bar-bg">
            <div class="buffett-bar-fill" style="width: ${fillPercentage}%; background-color: ${color};"></div>
        </div>
        <div class="buffett-labels">
            <span>Infravalorado</span>
            <span>Justo</span>
            <span>Sobrevalorado</span>
        </div>
        <p style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 1rem; text-align: center; max-width: 80%;">
            ${extraInfo}
        </p>
    `;
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
}

