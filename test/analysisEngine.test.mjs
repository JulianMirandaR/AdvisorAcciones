// Tests del motor de análisis (scoring, régimen de mercado y plan de entrada).
// Corren en Node: el motor lee window.* dentro de sus funciones, así que shimeamos window.
// Ejecutar: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { strategyMode: 'hybrid', dataAgeDays: 0 };

const { getMarketCondition, computeEntryZone, computePositionHint, analyzeStockWithMarketCondition } = await import('../analysisEngine.js');

// --- Helpers ---
function risingHistory(n = 40, start = 80, step = 0.8) {
    const prices = [];
    for (let i = 0; i < n; i++) prices.push(parseFloat((start + i * step).toFixed(2)));
    return prices;
}
function fallingHistory(n = 40, start = 120, step = -0.8) {
    const prices = [];
    for (let i = 0; i < n; i++) prices.push(parseFloat((start + i * step).toFixed(2)));
    return prices;
}

const bullish = {
    symbol: 'BULL', price: 111, ema20: 105, sma50: 100, sma200: 90,
    rsi: 56, macd: { histogram: 1.2 }, support: 100, resistance: 125,
    volume: 1500000, avgVolume: 1000000, atr: 3,
    stochastic: { k: 45, d: 35 }, peRatio: 18, epsGrowth: 12, roe: 20,
    newsSentiment: 1, history: { prices: risingHistory() }
};

const bearish = {
    symbol: 'BEAR', price: 82, ema20: 90, sma50: 100, sma200: 120,
    rsi: 34, macd: { histogram: -1.2 }, support: 75, resistance: 98,
    volume: 1500000, avgVolume: 1000000, atr: 3,
    stochastic: { k: 55, d: 65 }, peRatio: 40, epsGrowth: -5, roe: 2,
    newsSentiment: -1, history: { prices: fallingHistory() }
};

// --- getMarketCondition ---
test('getMarketCondition mapea VIX a régimen', () => {
    assert.equal(getMarketCondition(15), 'BULL');
    assert.equal(getMarketCondition(25), 'LATERAL');
    assert.equal(getMarketCondition(35), 'BEAR');
    assert.equal(getMarketCondition(20), 'LATERAL'); // borde: <20 es BULL, 20 no
    assert.equal(getMarketCondition(30), 'LATERAL'); // borde: >30 es BEAR, 30 no
});

// --- computeEntryZone ---
test('computeEntryZone: precio en la zona => EN_ZONA, stop bajo soporte, objetivo en resistencia', () => {
    const ez = computeEntryZone({ price: 100.5, ema20: 100, sma50: 96, support: 98, resistance: 112, atr: 2 });
    assert.equal(ez.status, 'EN_ZONA');
    assert.ok(ez.idealLow < ez.idealHigh);
    assert.ok(ez.stop < ez.idealLow, 'el stop debe estar por debajo de la zona');
    assert.equal(ez.target, 112); // resistencia > precio
    assert.equal(typeof ez.rr, 'number');
});

test('computeEntryZone: precio muy por encima del ancla => EXTENDIDO', () => {
    const ez = computeEntryZone({ price: 130, ema20: 118, sma50: 112, support: 110, resistance: 132, atr: 3 });
    assert.equal(ez.status, 'EXTENDIDO');
});

test('computeEntryZone: sin niveles usa fallback por ATR y no rompe', () => {
    const ez = computeEntryZone({ price: 50, atr: 2 });
    assert.ok(ez && ez.anchorLabel.includes('ATR'));
    assert.equal(ez.status, 'ACEPTABLE');
});

test('computeEntryZone: sin precio devuelve null', () => {
    assert.equal(computeEntryZone({ price: 0 }), null);
});

// --- computePositionHint ---
test('computePositionHint: setup fuerte y en zona => invertir bastante', () => {
    const ez = { status: 'EN_ZONA', rr: 2.5 };
    const h = computePositionHint(7, ez, { confirmation: 'ALTA CONFIANZA' });
    assert.equal(h.level, 'BASTANTE');
});

test('computePositionHint: señal que no habilita compra => NADA', () => {
    const h = computePositionHint(0.5, { status: 'EN_ZONA', rr: 3 }, {});
    assert.equal(h.level, 'NADA');
});

test('computePositionHint: extendido o con riesgos => invertir poco', () => {
    const extendido = computePositionHint(4, { status: 'EXTENDIDO', rr: 0.8 }, {});
    assert.equal(extendido.level, 'POCO');
    const conRiesgo = computePositionHint(7, { status: 'EN_ZONA', rr: 2.5 }, { staleData: true, conflict: true });
    assert.equal(conRiesgo.level, 'POCO');
});

// --- analyzeStockWithMarketCondition ---
test('devuelve la forma esperada y score acotado a [-10, 10]', () => {
    const r = analyzeStockWithMarketCondition(bullish, 'short', 'BULL');
    for (const k of ['signal', 'score', 'corto_plazo', 'largo_plazo', 'entryZone', 'positionHint', 'confianza', 'staleData']) {
        assert.ok(k in r, `falta la clave ${k}`);
    }
    assert.ok(r.score >= -10 && r.score <= 10);
    assert.ok(r.entryZone, 'debe incluir plan de entrada');
});

test('setup alcista en régimen BULL produce señal de compra', () => {
    window.dataAgeDays = 0;
    const r = analyzeStockWithMarketCondition(bullish, 'short', 'BULL');
    assert.ok(r.signal.includes('COMPRA'), `esperaba COMPRA, fue ${r.signal} (score ${r.score})`);
});

test('setup bajista en régimen BEAR no produce compra', () => {
    const r = analyzeStockWithMarketCondition(bearish, 'short', 'BEAR');
    assert.ok(!r.signal.includes('COMPRA'), `no debería ser compra, fue ${r.signal}`);
});

test('datos viejos (>1 día) capan la señal a OBSERVAR y marcan staleData', () => {
    window.dataAgeDays = 3;
    const r = analyzeStockWithMarketCondition(bullish, 'short', 'BULL');
    window.dataAgeDays = 0; // reset para no contaminar otros tests
    assert.equal(r.staleData, true);
    assert.ok(r.score <= 1.5, `con datos viejos el score debe capar a <=1.5, fue ${r.score}`);
    assert.ok(!r.signal.includes('COMPRA'));
});

test('balance inminente (earnings <= 7 días) limita la señal de compra', () => {
    window.dataAgeDays = 0;
    const soon = new Date();
    soon.setDate(soon.getDate() + 2);
    const withEarnings = { ...bullish, earningsDate: soon.toISOString().split('T')[0] };
    const r = analyzeStockWithMarketCondition(withEarnings, 'short', 'BULL');
    assert.equal(r.earningsRisk, 2);
    assert.ok(r.score <= 1.5, `con balance a 2 días el score debe capar, fue ${r.score}`);
});
