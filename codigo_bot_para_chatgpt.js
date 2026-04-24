/* 
Este archivo contiene un extracto de la lógica del bot de auto-trading 
actualmente implementada en app.js. Puedes enviarle esto a ChatGPT para 
que te dé sugerencias de refactorización, optimización de entradas/salidas, 
y mejoras en la gestión de riesgos (Stop Loss, Take Profit, Trailing Stop).
*/

// --- 1. Variables de Estado Global del Bot ---
// (Definidas al inicio de app.js)
window.autoTradingEnabled = JSON.parse(localStorage.getItem('advisor_auto_trade') || 'false');
window.simCapital = JSON.parse(localStorage.getItem('advisor_sim_capital') || '10000'); 
window.autoPortfolio = JSON.parse(localStorage.getItem('advisor_auto_portfolio') || '[]');
window.autoClosedTrades = JSON.parse(localStorage.getItem('advisor_auto_closed_trades') || '[]');

// --- 2. Controles de Interfaz del Bot ---
window.toggleAutoTrading = () => {
    window.autoTradingEnabled = !window.autoTradingEnabled;
    localStorage.setItem('advisor_auto_trade', JSON.stringify(window.autoTradingEnabled));
    window.updateAutoTradeUI(); // Actualiza el botón en la interfaz visual
    
    if (window.autoTradingEnabled) {
        window.addNotification("🤖 Bot de Auto-Trading ACTIVADO. Invertirá automáticamente en señales de Compra Fuerte, Alta Confianza o Setups Estratégicos.", "info");
        // Verifica si hay señales pendientes al momento de encenderlo
        if (globalStocksData.length > 0) {
            checkNotifications();
            refreshUI();
        }
    } else {
        window.addNotification("🤖 Bot de Auto-Trading DESACTIVADO. Operaciones pausadas.", "info");
    }
};

window.removeFromAutoPortfolio = (index) => {
    const pos = window.autoPortfolio[index];
    const stockData = globalStocksData.find(s => s.symbol === pos.symbol);
    if (stockData) {
        const currentPrice = parseFloat(stockData.price);
        const profit = (currentPrice - pos.price) * pos.qty;
        const profitPct = ((currentPrice - pos.price) / pos.price) * 100;
        
        // Registrar la operación exitosa o fallida en el historial
        window.autoClosedTrades.push({
            symbol: pos.symbol,
            entryPrice: pos.price,
            exitPrice: currentPrice,
            qty: pos.qty,
            profit: profit,
            profitPct: profitPct,
            date: new Date().toISOString()
        });
        localStorage.setItem('advisor_auto_closed_trades', JSON.stringify(window.autoClosedTrades));
    }

    // Remover la acción del portfolio activo
    window.autoPortfolio.splice(index, 1);
    localStorage.setItem('advisor_auto_portfolio', JSON.stringify(window.autoPortfolio));
    if (currentTerm === 'bot_portfolio') renderPortfolio(true);
};

// --- 3. Lógica de Trading Automático ---
// (Albergada dentro de la función checkNotifications() en app.js)

// Esta iteración corre por cada acción analizada en background...
globalStocksData.forEach(stock => {
    // ... [código omitido: aquí se llama a analyzeStockWithMarketCondition(...) para generar "sig" (Señal) y "analysis"] ...
    
    const autoPos = window.autoPortfolio.find(p => p.symbol === stock.symbol);
    const portfolioPos = portfolio.find(p => p.symbol === stock.symbol); // Portfolio manual
    
    // A. LÓGICA DE VENTA: Evaluamos ventas para el Bot si ya posee la acción abierta
    if (autoPos) {
        // Venta por Señal Técnica o Debilidad (Se giró la tendencia)
        if ((sig.includes('VENTA') || sig.includes('DEBIL')) && prevSignal && (!prevSignal.includes('VENTA') && !prevSignal.includes('DEBIL'))) {
            if (window.autoTradingEnabled) {
                window.addNotification(`🤖 Auto-Trade: VENDIENDO ${stock.symbol} por señal de ${sig}`, 'sell', stock.symbol);
                const idx = window.autoPortfolio.findIndex(p => p.symbol === stock.symbol);
                if (idx !== -1) window.removeFromAutoPortfolio(idx);
            }
        }
        // Venta por Stop Loss
        if (analysis.actionFlag === 'STOP_LOSS' && prevSignal !== 'STOP_LOSS') {
            if (window.autoTradingEnabled) {
                window.addNotification(`🤖 Auto-Trade: STOP LOSS Ejecutado en ${stock.symbol}`, 'sell', stock.symbol);
                const idx = window.autoPortfolio.findIndex(p => p.symbol === stock.symbol);
                if (idx !== -1) window.removeFromAutoPortfolio(idx);
            }
        }
        // Venta por Take Profit (Toma de Ganancias)
        if (analysis.actionFlag === 'TAKE_PROFIT' && prevSignal !== 'TAKE_PROFIT') {
            if (window.autoTradingEnabled) {
                window.addNotification(`🤖 Auto-Trade: TAKE PROFIT Ejecutado en ${stock.symbol}`, 'sell', stock.symbol);
                const idx = window.autoPortfolio.findIndex(p => p.symbol === stock.symbol);
                if (idx !== -1) window.removeFromAutoPortfolio(idx);
            }
        }
    }

    // B. LÓGICA DE COMPRA: Si la IA/Bot no tiene la acción, busca oportunidades fuertes de entrada
    if (!portfolioPos && !autoPos) {
        // Condiciones pre-establecidas para abrir posiciones
        const isFuerte = sig === 'COMPRA FUERTE';
        const isIA = analysis.confirmationLevel === 'ALTA CONFIANZA';
        const isSetup = !!analysis.setupDetected;     // Patrones como Doble Piso, Exhaustion, etc.
        const isCompraBasica = sig.includes('COMPRA');

        // Solo operamos si el bot está ON y se cumple un escenario muy sólido
        if (window.autoTradingEnabled && (isFuerte || isIA || (isSetup && isCompraBasica))) {
            const tradeAmount = 1000; // El bot invierte un monto fijo de $1000 por señal
            const qty = tradeAmount / stock.price;
            
            // Determinar la motivación principal de la operación
            let reasonStr = 'Técnico Fuerte';
            if (isIA) reasonStr = 'Confirmado IA';
            else if (isSetup && !isFuerte) reasonStr = `Setup: ${analysis.setupDetected}`;
            
            window.addNotification(`🤖 Auto-Trade: COMPRANDO ${qty.toFixed(2)} reps de ${stock.symbol} por $${tradeAmount} (${reasonStr})`, 'buy', stock.symbol);
            
            window.autoPortfolio.push({
                symbol: stock.symbol,
                price: parseFloat(stock.price),          // Precio Promedio de Compra (PPC)
                highestPrice: parseFloat(stock.price),   // Trackeo para calcular el Trailing Stop Loss
                qty: qty
            });
            hasBotChanges = true;
        }
    }
});
