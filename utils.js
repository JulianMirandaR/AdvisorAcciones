// Utilidades puras (sin DOM ni estado global) extraídas de app.js para poder testearlas aisladas
// y empezar a modularizar el archivo grande. Primera tajada: detección de divergencia de RSI.

// Escapa texto para insertarlo con seguridad en innerHTML (evita inyección de HTML/XSS).
// Se usa, por ejemplo, para mostrar el texto que devuelve la IA dentro de una tarjeta.
export function escapeHtml(str) {
    if (str == null) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(str).replace(/[&<>"']/g, (c) => map[c]);
}

// --- DIVERGENCIA ALCISTA DE RSI (RSI en sobreventa + divergencia con el precio) ---
// Heurística simple, no una detección rigurosa de pivotes/fractales: compara el mínimo de precio
// más reciente contra el mínimo previo dentro de la ventana. Si el precio iguala/hace un mínimo
// nuevo pero el RSI en ese punto queda POR ENCIMA del RSI que tuvo en el mínimo previo, el impulso
// bajista se está debilitando aunque el precio siga cayendo — la divergencia clásica de reversión.
export const RSI_DIVERGENCE_LOOKBACK_DAYS = 20;
export const RSI_OVERSOLD_THRESHOLD = 30;

export function detectBullishRsiDivergence(data) {
    const hist = data.history;
    if (!hist || !Array.isArray(hist.prices) || !Array.isArray(hist.rsi)) return false;
    if (hist.prices.length < RSI_DIVERGENCE_LOOKBACK_DAYS || hist.rsi.length < RSI_DIVERGENCE_LOOKBACK_DAYS) return false;

    const prices = hist.prices.slice(-RSI_DIVERGENCE_LOOKBACK_DAYS).map(Number);
    const rsis = hist.rsi.slice(-RSI_DIVERGENCE_LOOKBACK_DAYS).map(v => (v == null ? null : Number(v)));

    const currentPrice = prices[prices.length - 1];
    const currentRsi = rsis[rsis.length - 1];
    if (isNaN(currentPrice) || currentRsi == null || isNaN(currentRsi)) return false;

    // Mínimo de precio previo dentro de la ventana, sin contar el día de hoy.
    let priorLowIdx = -1;
    let priorLowPrice = Infinity;
    for (let i = 0; i < prices.length - 1; i++) {
        if (!isNaN(prices[i]) && prices[i] < priorLowPrice) {
            priorLowPrice = prices[i];
            priorLowIdx = i;
        }
    }
    if (priorLowIdx === -1 || rsis[priorLowIdx] == null || isNaN(rsis[priorLowIdx])) return false;

    const priceHizoMinimoIgualOMenor = currentPrice <= priorLowPrice * 1.005; // 0.5% de tolerancia
    const rsiHizoMinimoMasAlto = currentRsi > rsis[priorLowIdx];

    return priceHizoMinimoIgualOMenor && rsiHizoMinimoMasAlto;
}

// Combina la divergencia con RSI en sobreventa (el par que efectivamente se usa como aviso de
// oportunidad; una divergencia sin sobreventa es mucho menos significativa).
export function hasOversoldBullishDivergence(data) {
    const rsiNow = parseFloat(data.rsi);
    if (isNaN(rsiNow) || rsiNow >= RSI_OVERSOLD_THRESHOLD) return false;
    return detectBullishRsiDivergence(data);
}
