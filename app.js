// --- Analysis Logic ---
// (Note: `stocks` array and `generateStockData` removed as requested)

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
            score -= 2;
            addReason(`Precio bajo ${maLabel} (Tendencia Corto Plazo Bajista)`, "negative", 10);
        }
    } else {
        // Largo plazo: SMA 200
        if (parseFloat(data.price) > parseFloat(data.sma200)) {
            score += 3;
            addReason("Precio sobre SMA 200 (Tendencia Largo Plazo Alcista)", "positive", 10);
        } else {
            score -= 3;
            addReason("Precio bajo SMA 200 (Tendencia Largo Plazo Bajista)", "negative", 10);
        }
    }

    // 2. RSI (Media Importancia)
    if (data.rsi < 30) {
        score += 2;
        addReason(`RSI en ${data.rsi} (Sobreventa - Posible Rebote)`, "positive", 8);
    } else if (data.rsi > 70) {
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
            score -= 1;
            addReason("Volumen alto confirmando bajada", "negative", 5);
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
    } else {
        addReason(`Lejos de zona de soporte importante`, "negative", 2);
    }

    // 7. Fundamental
    if (data.peRatio && data.peRatio !== 'N/A' && parseFloat(data.peRatio) < 20) {
        score += 1;
        addReason(`Fundamental: PER bajo (${data.peRatio})`, "positive", 4);
    } else {
        if (data.peRatio !== 'N/A') {
            addReason(`Fundamental: PER alto o promedio`, "negative", 2);
        }
    }

    // Evaluación Final
    if (score >= 4) signal = "COMPRA FUERTE";
    else if (score >= 2) signal = "COMPRAR";
    else if (score <= -4) signal = "VENTA FUERTE";
    else if (score <= -2) signal = "VENDER";
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
const realDataService = typeof RealDataService !== 'undefined' ? new RealDataService() : null;

// Global container state
let globalStocksData = []; // To keep track for re-sorting

function renderMarketStatus() {
    // Estado neutral por defecto o basado en fecha
    const today = new Date().toLocaleDateString();

    let usageInfo = "";
    if (realDataService) {
        const usage = realDataService.getDailyUsage();
        const limit = 25; // Límite gratuito aproximado
        const color = usage >= limit ? 'var(--accent-red)' : 'var(--accent-green)';
        usageInfo = `<br><span style="font-size: 0.8rem; color: ${color};">Peticiones API Hoy: <strong>${usage}</strong> / ${limit}</span>`;
    }

    marketStatus.innerHTML = `
        <span class="status-indicator status-up"></span>
        <div>
            Datos del Mercado para: ${today} (Actualizados diariamente)
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
    };

    const handleProgress = (msg) => {
        if (progressEl) progressEl.textContent = msg;
        console.log("Progress:", msg);
    };

    if (realDataService) {
        await realDataService.loadStocks(handleStockUpdate, handleProgress);
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

    // Process analysis
    const analyzedStocks = globalStocksData.map(data => {
        const analysis = analyzeStock(data, currentTerm);
        return { data, analysis };
    });

    // Sort by Score (Best opportunities first)
    analyzedStocks.sort((a, b) => b.analysis.score - a.analysis.score);

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

    card.innerHTML = `
        <div class="card-header">
            <div>
                <div class="stock-symbol">${data.symbol}</div>
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

// Init
renderMarketStatus();
initDashboard();

// Helper to keep track of chart instances and destroy them to avoid "Canvas is already in use" errors
const chartInstances = {};

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
