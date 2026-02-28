// --- Analysis Logic ---
// (Note: `stocks` array and `generateStockData` removed as requested)
import { RealDataService } from './realData.js';

// Helper to keep track of chart instances (moved to top to avoid initialization errors)
const chartInstances = {};

// --- Logic for Recommendations ---

function analyzeStock(data, term) {
    let score = 0;
    let reasons = [];
    let signal = "NEUTRAL"; // COMPRAR, VENDER, NEUTRAL

    // Helper: Agregar razón con peso para ordenamiento
    const addReason = (text, type, weight) => {
        reasons.push({ text, type, weight });
    };

    // 1. Analisis de Medias Moviles (Alta Importancia)
    if (term === 'short') {
        const shortMa = data.ema20 || data.sma50;
        const maLabel = data.ema20 ? 'EMA 20' : 'SMA 50';

        if (parseFloat(data.price) > parseFloat(shortMa)) {
            score += 2;
            addReason(`Precio sobre ${maLabel} (Tendencia Corto Plazo Alcista)`, "positive", 10);
        } else {
            score -= 3; // Castigo mayor si rompe la media de corto plazo
            addReason(`Precio bajo ${maLabel} (Tendencia Corto Plazo Bajista - ALERTA)`, "negative", 10);
        }
    } else {
        // Largo plazo: SMA 200
        if (parseFloat(data.price) > parseFloat(data.sma200)) {
            score += 3;
            addReason("Precio sobre SMA 200 (Tendencia Largo Plazo Alcista)", "positive", 10);
        } else {
            score -= 4; // Castigo mayor si pierde soporte histórico
            addReason("Precio bajo SMA 200 (Tendencia Largo Plazo Bajista - PELIGRO)", "negative", 10);
        }
    }

    // 2. RSI (Media Importancia)
    if (data.rsi < 30) {
        score += 2;
        addReason(`RSI en ${data.rsi} (Sobreventa - Posible Rebote)`, "positive", 8);
    } else if (data.rsi > 65) { // Bajado de 70 a 65 para alertas más tempranas
        score -= 2;
        addReason(`RSI en ${data.rsi} (Sobrecompra - Corrección Probable)`, "negative", 8);
    } else {
        // RSI Neutro
        addReason(`RSI en ${data.rsi} (Zona Neutral - Sin señal clara)`, "negative", 2);
    }

    // 3. MACD
    if (data.macd.histogram > 0 && data.macd.line > data.macd.signal) {
        score += 1;
        addReason("MACD: Cruce Alcista", "positive", 6);
    } else {
        score -= 1;
        addReason("MACD: No hay cruce alcista o Tendencia Bajista", "negative", 6);
    }

    // 4. Volumen
    if (data.avgVolume > 0 && data.volume > data.avgVolume) {
        if (parseFloat(data.change) > 0) {
            score += 1;
            addReason("Volumen alto confirmando subida", "positive", 5);
        } else {
            score -= 2; // Más peso a caídas con volumen
            addReason("Volumen alto confirmando bajada (ALERTA)", "negative", 5);
        }
    } else {
        // Volumen bajo
        addReason("Volumen promedio o bajo (Poca confirmación)", "negative", 3);
    }

    // Patterns & Candles
    if (data.patterns && data.patterns.length > 0) {
        data.patterns.forEach(p => {
            score += 2;
            addReason(`Patrón Detectado: ${p}`, "positive", 9);
        });
    } else {
        addReason("Sin patrones chartistas claros", "negative", 1);
    }

    if (data.candles && data.candles.length > 0) {
        data.candles.forEach(c => {
            score += 1;
            addReason(`Vela Japonesa: ${c}`, "positive", 7);
        });
    } else {
        addReason("Sin patrones de velas relevantes", "negative", 1);
    }

    // 6. Soportes/Resistencias
    const distToSupport = Math.abs(parseFloat(data.price) - parseFloat(data.support));
    const priceVal = parseFloat(data.price);
    if (distToSupport / priceVal < 0.02) {
        score += 2;
        addReason(`Precio probando Soporte en ${data.support}`, "positive", 9);
    } else if (priceVal < parseFloat(data.support)) {
        score -= 3; // Ruptura de soporte
        addReason(`Rotura del Soporte en ${data.support} (Confirmación Bajista)`, "negative", 9);
    } else {
        addReason(`Lejos de zona de soporte importante`, "negative", 2);
    }

    // 7. Fundamental
    if (data.peRatio && data.peRatio !== 'N/A' && parseFloat(data.peRatio) < 20) {
        score += 1;
        addReason(`Fundamental: PER bajo (${data.peRatio})`, "positive", 4);
    } else {
        if (data.peRatio !== 'N/A' && parseFloat(data.peRatio) > 35) {
            score -= 1; // Penalización por sobrevaloración fundamental
            addReason(`Fundamental: PER muy alto (${data.peRatio})`, "negative", 4);
        } else if (data.peRatio !== 'N/A') {
            addReason(`Fundamental: PER alto o promedio`, "negative", 2);
        }
    }

    // Evaluación Final
    if (score >= 4) signal = "COMPRA FUERTE";
    else if (score >= 2) signal = "COMPRAR";
    else if (score <= -3) signal = "VENTA FUERTE"; // Ajustado para que sea más fácil de alcanzar
    else if (score <= -1) signal = "VENDER";      // Ajustado de <= -2 a <= -1
    else signal = "MANTENER";

    // Ordenar razones por importancia
    reasons.sort((a, b) => b.weight - a.weight);

    return { signal, score, reasons };
}

// --- UI Rendering ---

const container = document.getElementById('recommendations-container');
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
            <h3>Iniciando Análisis (24 Acciones)...</h3>
            <div id="loading-progress" style="color: var(--accent-blue); margin-top: 1rem; font-weight:bold;">Verificando Caché...</div>
             <p style="font-size: 0.8rem; color: var(--text-secondary); margin-top:0.5rem;">
                Los datos de hoy se recuperan de memoria si existen. Si no, se descargan secuencialmente (lento para evitar bloqueo API).
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
        // Si quisieramos mantener un loader pequeñito arriba, podriamos, pero el usuario quiere ver "juntandose"
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
            if (activeFilter === 'hold') return sig.includes('mantener');
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

    let badgeClass = 'hold-badge';
    if (analysis.signal.includes('COMPRA')) badgeClass = 'buy-badge';
    if (analysis.signal.includes('VENTA')) badgeClass = 'sell-badge';

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
            <span class="analysis-label">PER Ratio</span>
            <span class="analysis-value">${data.peRatio}</span>
        </div>`;
    }
    if (data.epsGrowth && data.epsGrowth !== 'N/A') {
        fundamentalHtml += `
        <div class="analysis-item">
            <span class="analysis-label">EPS (Ganancia)</span>
            <span class="analysis-value">$${data.epsGrowth}</span>
        </div>`;
    }

    const isFavorite = watchlist.includes(data.symbol);
    const starClass = isFavorite ? 'active' : '';

    card.innerHTML = `
        <div class="card-header">
            <div>
                <div class="stock-symbol">${data.symbol} 
                    <span class="watchlist-star ${starClass}" onclick="toggleWatchlist('${data.symbol}', event)">★</span>
                </div>
                <div class="stock-name">${data.name}</div>
            </div>
            <div class="recommendation-badge ${badgeClass}">${analysis.signal}</div>
        </div>
        
        <div class="price-section">
            <div class="current-price">$${data.price}</div>
            <div class="price-change ${changeClass}">${changeSign}${data.change} (${changeSign}${data.changePercent}%)</div>
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

// Watchlist Function globally accessible
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

    // Prepare datasets
    const datasets = [
        {
            label: 'Precio',
            data: data.history.prices,
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
            data: data.history.ema20,
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
            data: data.history.sma200,
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
            labels: data.history.dates, // X-Axis Labels (Dates)
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

function renderHeatmap() {
    const heatmapContainer = document.getElementById('marketHeatmap');
    if (!heatmapContainer) return;

    heatmapContainer.innerHTML = '';

    // Sort by magnitude of change
    const sortedByChange = [...globalStocksData].sort((a, b) => Math.abs(parseFloat(b.changePercent)) - Math.abs(parseFloat(a.changePercent)));

    sortedByChange.forEach(stock => {
        const change = parseFloat(stock.changePercent);
        const block = document.createElement('div');
        block.className = 'heatmap-block';

        // Intensity Color Logic
        const intensity = Math.min(Math.abs(change) / 3, 1); // Cap at 3% change for max color

        if (change >= 0) {
            // Green: #22c55e
            block.style.backgroundColor = `rgba(34, 197, 94, ${0.1 + (intensity * 0.9)})`;
            block.style.border = '1px solid #15803d'; // Green border
        } else {
            // Red: #ef4444
            block.style.backgroundColor = `rgba(239, 68, 68, ${0.1 + (intensity * 0.9)})`;
            block.style.border = '1px solid #b91c1c'; // Red border
        }

        block.innerHTML = `
            <span class="heatmap-symbol">${stock.symbol}</span>
            <span class="heatmap-change">${change > 0 ? '+' : ''}${change.toFixed(2)}%</span>
        `;

        block.title = `${stock.name}: $${stock.price}`;
        heatmapContainer.appendChild(block);
    });
}

function renderBuffettIndicator() {
    const container = document.getElementById('buffettContainer');
    if (!container) return;

    let buffettValue = 195.4;
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
