// Tests de utilidades puras (utils.js): detección de divergencia alcista de RSI.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { detectBullishRsiDivergence, hasOversoldBullishDivergence, escapeHtml } = await import('../utils.js');

test('escapeHtml: neutraliza caracteres peligrosos y maneja null', () => {
    assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(escapeHtml('a & b "c" \'d\''), 'a &amp; b &quot;c&quot; &#39;d&#39;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml('texto normal'), 'texto normal');
});

// Construye 20 días donde el precio hace un mínimo igual o menor pero el RSI sube (divergencia).
function divergentHistory() {
    const prices = [];
    const rsi = [];
    for (let i = 0; i < 20; i++) { prices.push(100 - i); rsi.push(40 - i); } // baja fuerte, RSI bajo
    // Último día: precio igual de bajo que el mínimo previo, pero RSI más alto -> divergencia.
    prices[19] = prices[18]; // mismo mínimo
    rsi[19] = 25;            // RSI recupera (más alto que el del mínimo previo, que era muy bajo)
    return { prices, rsi };
}

test('detectBullishRsiDivergence: precio en mínimo pero RSI más alto => true', () => {
    assert.equal(detectBullishRsiDivergence({ history: divergentHistory() }), true);
});

test('detectBullishRsiDivergence: sin historial suficiente => false', () => {
    assert.equal(detectBullishRsiDivergence({ history: { prices: [1, 2], rsi: [10, 20] } }), false);
    assert.equal(detectBullishRsiDivergence({}), false);
});

test('hasOversoldBullishDivergence: exige RSI actual en sobreventa (<30)', () => {
    const h = divergentHistory();
    // rsi actual 25 (<30) y hay divergencia -> true
    assert.equal(hasOversoldBullishDivergence({ rsi: 25, history: h }), true);
    // mismo escenario pero rsi actual 45 (no sobreventa) -> false
    assert.equal(hasOversoldBullishDivergence({ rsi: 45, history: h }), false);
});
