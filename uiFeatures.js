import { auth } from './realData.js';

// Inicializar caches de predicciones por separado
window.aiPredictionCacheOpenAI = window.aiPredictionCacheOpenAI || {};

export async function handlePredictOpenAI(symbol, globalStocksData, callbackRefreshUI) {
    const stockData = globalStocksData.find(s => s.symbol === symbol);
    if (!stockData) return;
    
    const btn = document.getElementById(`btn-ai-open-${symbol}`);
    let originalText = '🧠 Análisis';
    if(btn) {
        originalText = btn.innerHTML;
        if (window.aiPredictionCacheOpenAI[symbol]) {
            callbackRefreshUI();
            return;
        }
        btn.innerHTML = '⚙️ Analizando...';
        btn.disabled = true;
    }

    try {
        const headers = {
            'Content-Type': 'application/json'
        };
        if (auth.currentUser) {
            headers['x-uid'] = auth.currentUser.uid;
        }

        const response = await fetch(`${window.API_BASE_URL}/analyze`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ symbol, stockData })
        });

        if (!response.ok) {
            throw new Error(`Error en el servidor de IA (${response.status}). Verifica que el backend en Railway esté activo.`);
        }

        const result = await response.json();

        // Adaptar al formato esperado por el frontend
        window.aiPredictionCacheOpenAI[symbol] = {
            probability: result.probability,
            confidence: result.confidence,
            usable: true,
            bias: result.bias,
            thought: result.thought
        };

        const popText = `🤖 OPEN AI PREDICT (${symbol})
----------------------------------
${result.thought || 'Análisis basado en el contexto de mercado'}
----------------------------------
📊 Probabilidad Alcista: ${(result.probability*100).toFixed(1)}%
🎯 Confianza: ${result.confidence}/100
Sesgo: ${result.bias}
`;

        alert(popText);
        callbackRefreshUI();

    } catch (e) {
        console.error("OpenAI Error:", e);
        alert("Hubo un error calculando con OpenAI: " + e.message);
    } finally {
        if (btn) {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }
}

// 🔥 Interpretación automática (MUY útil)
function interpretAI(result) {
    if (result.uncertainty > 0.15) {
        return "Señal poco confiable (alta variabilidad entre predicciones).";
    }
    if (result.probability > 0.6 && result.uncertainty < 0.08) {
        return "Señal fuerte y consistente.";
    }
    if (result.probability < 0.4 && result.uncertainty < 0.08) {
        return "Sesgo bajista consistente.";
    }
    return "Señal moderada, requiere confirmación técnica.";
}


// ================== NEWS ==================

export function handleOpenNewsModal(symbol, globalStocksData) {
    const stock = globalStocksData.find(s => s.symbol === symbol);
    if (!stock) return;
    
    document.getElementById('newsTitle').innerText = `📰 Noticias: ${stock.name || symbol}`;
    const container = document.getElementById('newsContainer');
    
    let htmlContent = '';
    const sentiment = stock.newsSentiment || 0;
    
    if (stock.newsList && stock.newsList.length > 0) {
        htmlContent = stock.newsList.map((n, i) => {
            let borderColor = 'var(--border-color)';
            let badgeHtml = '';
            
            // New sentiment logic using individual article's sentiment
            if (n.sentiment === 'POSITIVO' || n.score > 0) {
                borderColor = 'var(--accent-green)';
                badgeHtml = `<span style="background: rgba(39, 174, 96, 0.2); color: var(--accent-green); padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; margin-left: 8px;">BENEFICIA</span>`;
            } else if (n.sentiment === 'NEGATIVO' || n.score < 0) {
                borderColor = 'var(--accent-red)';
                badgeHtml = `<span style="background: rgba(231, 76, 60, 0.2); color: var(--accent-red); padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; margin-left: 8px;">PERJUDICA</span>`;
            } else {
                // Neutral formatting
                badgeHtml = `<span style="background: rgba(149, 165, 166, 0.2); color: var(--text-secondary); padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; margin-left: 8px;">NEUTRO</span>`;
            }
            
            return `
            <div style="background: var(--hover-bg); padding: 1rem; border-radius: 6px; border-left: 4px solid ${borderColor}; margin-bottom: 0.5rem; display: flex; flex-direction: column; gap: 0.5rem;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-size: 0.8rem; color: var(--text-secondary);">${n.date} - ${n.publisher}</div>
                    ${badgeHtml}
                </div>
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
}

// --- AUTO-BOT HEADLESS ANALYSIS ---
window.pendingAnalysesOpenAI = new Set();

window.requestAIAnalysisHeadless = async function(symbol) {
    if (window.pendingAnalysesOpenAI.has(symbol)) {
        console.log(`⏳ Análisis de ChatGPT para ${symbol} ya está en curso.`);
        return;
    }
    if (window.aiPredictionCacheOpenAI && window.aiPredictionCacheOpenAI[symbol]) return;

    // No analizar acciones que el bot ChatGPT ya tiene en cartera
    if (window.autoPortfolioChatGPT && window.autoPortfolioChatGPT.find(p => p.symbol === symbol)) {
        console.log(`ℹ️ Bot ChatGPT: ${symbol} ya está en cartera, omitiendo análisis.`);
        return;
    }
    
    const stocks = window.globalStocksData || [];
    const stockData = stocks.find(s => s.symbol === symbol);
    if (!stockData) {
        console.error(`❌ No se encontró data para ${symbol} en globalStocksData.`);
        return;
    }
    
    window.pendingAnalysesOpenAI.add(symbol);
    console.log(`🤖 Bot ChatGPT: Solicitando análisis autónomo para ${symbol}...`);

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (auth.currentUser) {
            headers['x-uid'] = auth.currentUser.uid;
        }

        const response = await fetch(`${window.API_BASE_URL}/analyze`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ symbol, stockData })
        });

        if (!response.ok) {
            console.error(`❌ Error en API Railway para ${symbol}: ${response.status}`);
            return;
        }

        const result = await response.json();
        if (!window.aiPredictionCacheOpenAI) window.aiPredictionCacheOpenAI = {};
        
        window.aiPredictionCacheOpenAI[symbol] = {
            probability: result.probability,
            confidence: result.confidence,
            usable: true,
            bias: result.bias,
            thought: result.thought
        };
        
        console.log(`✅ Bot ChatGPT: Análisis autónomo completado para ${symbol}. Prob: ${result.probability}`);
        if (typeof window.checkNotifications === 'function') window.checkNotifications(true);
        if (typeof window.refreshUI === 'function') window.refreshUI();
    } catch (e) {
        console.error("Headless OpenAI Error:", e);
    } finally {
        window.pendingAnalysesOpenAI.delete(symbol);
    }
};