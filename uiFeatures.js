import { runAIPrediction } from './mlModel.js';

// Inicializar caché de predicciones
window.aiPredictionCache = window.aiPredictionCache || {};

export async function handlePredictAI(symbol, globalStocksData, callbackRefreshUI) {
    const stockData = globalStocksData.find(s => s.symbol === symbol);
    if (!stockData) return;
    
    const btn = document.getElementById(`btn-ai-${symbol}`);
    const originalText = btn.innerHTML;

    if (window.aiPredictionCache[symbol]) {
        callbackRefreshUI();
        return;
    }
    
    btn.innerHTML = '⚙️ Pensando...';
    btn.disabled = true;
    
    try {
        // 🔥 ENSEMBLE (3 corridas)
        const runs = [];

        for (let i = 0; i < 3; i++) {
            const res = await runAIPrediction(stockData);
            if (res.error) throw new Error(res.error);
            runs.push(res);
        }

        // 🔹 Promedios
        const avgProb = runs.reduce((a,b)=>a+b.probability,0) / runs.length;
        const avgConf = runs.reduce((a,b)=>a+b.confidence,0) / runs.length;

        // 🔹 Incertidumbre (desvío estándar)
        const variance = runs.reduce((a,b)=>a + Math.pow(b.probability - avgProb, 2), 0) / runs.length;
        const uncertainty = Math.sqrt(variance);

        // 🔹 Resultado final
        const result = {
            ...runs[0],
            probability: avgProb,
            confidence: avgConf,
            uncertainty
        };

        // Guardar en cache
        window.aiPredictionCache[symbol] = result;

        // 🔥 Alert mejorado
        const popText = `🤖 IA PREDICT (${symbol})
----------------------------------
${result.thought || 'Análisis basado en patrones históricos'}
----------------------------------
📊 Probabilidad: ${(result.probability*100).toFixed(1)}%
🎯 Confianza: ${result.confidence.toFixed(1)}/100
⚠️ Incertidumbre: ${(result.uncertainty*100).toFixed(1)}%

🧠 Interpretación:
${interpretAI(result)}
`;

        alert(popText);
        
        callbackRefreshUI();

    } catch (e) {
        console.error("AI Error:", e);
        alert("Hubo un error calculando con IA: " + e.message);
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
}