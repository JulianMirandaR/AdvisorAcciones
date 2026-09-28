// Tests del motor de backtest (costos, slippage y sizing por riesgo).
// Corren en Node sin navegador: shimeamos `window` (el motor de análisis lee window.strategyMode).
// Ejecutar: node --test  (o node test/backtestEngine.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';

// El motor de análisis lee window.* dentro de sus funciones; lo definimos antes de usarlo.
globalThis.window = { strategyMode: 'hybrid' };

const { runBacktest, atrProxyFromCloses, wilsonInterval } = await import('../backtestEngine.js');

// --- Helpers ---
function buildSeries({ n = 120, start = 100, drift = 0.004, wave = 0.006 } = {}) {
    const closes = [];
    let p = start;
    for (let i = 0; i < n; i++) {
        p = p * (1 + drift + Math.sin(i / 3) * wave);
        closes.push(parseFloat(p.toFixed(2)));
    }
    const hist = [];
    for (let i = 50; i < n; i++) {
        hist.push({
            symbol: 'TEST', price: closes[i],
            ema20: closes[i] * 0.97, sma50: closes[i] * 0.94, sma200: closes[i] * 0.85,
            rsi: 55, macd: { histogram: 1.2 },
            support: closes[i] * 0.9, resistance: closes[i] * 1.12,
            peRatio: 20, epsGrowth: 10, roe: 20,
            history: { prices: closes.slice(0, i + 1), macd: [] },
            date: '2026-' + String((Math.floor(i / 28) % 12) + 1).padStart(2, '0') + '-' + String((i % 28) + 1).padStart(2, '0')
        });
    }
    return hist;
}

const bullCfg = { capital: 10000, marketCondition: 'BULL', term: 'short' };

test('wilsonInterval: rango honesto que contiene la proporción y se angosta con más muestra', () => {
    assert.deepEqual(wilsonInterval(0.5, 0), { low: 0, high: 0 }); // sin muestra
    const few = wilsonInterval(0.6, 10);
    const many = wilsonInterval(0.6, 200);
    assert.ok(few.low >= 0 && few.high <= 1);
    assert.ok(few.low < 0.6 && few.high > 0.6, 'el intervalo debe contener la proporción');
    const anchoPocos = few.high - few.low;
    const anchoMuchos = many.high - many.low;
    assert.ok(anchoMuchos < anchoPocos, 'con más trades el intervalo debe ser más angosto');
});

test('runBacktest expone winRateCI y sampleReliability', () => {
    const r = runBacktest(buildSeries(), { ...bullCfg, sizingMode: 'allin' });
    assert.ok(r.winRateCI && typeof r.winRateCI.low === 'number' && typeof r.winRateCI.high === 'number');
    assert.ok(['baja', 'media', 'alta'].includes(r.sampleReliability));
});

test('atrProxyFromCloses: promedio del movimiento absoluto diario', () => {
    // Movimientos: |102-100|=2, |101-102|=1, |104-101|=3  -> media = 2
    assert.equal(atrProxyFromCloses([100, 102, 101, 104], 14), 2);
    assert.equal(atrProxyFromCloses([100], 14), null); // insuficiente
    assert.equal(atrProxyFromCloses(null, 14), null);
});

test('serie alcista dispara trades y devuelve los campos de costos/sizing', () => {
    const r = runBacktest(buildSeries(), { ...bullCfg, commissionPct: 0.5, slippagePct: 0.2, riskPerTradePct: 1, sizingMode: 'risk' });
    assert.ok(r && !r.error, 'debe devolver resultado');
    assert.ok(r.trades.length > 0, 'debe generar al menos un trade');
    assert.equal(r.sizingMode, 'risk');
    assert.equal(typeof r.totalCommissions, 'number');
    assert.equal(typeof r.totalSlippage, 'number');
    // totalCosts = comisiones + slippage (identidad contable)
    assert.ok(Math.abs(r.totalCosts - (r.totalCommissions + r.totalSlippage)) < 1e-6);
    assert.ok(r.totalCosts > 0, 'con comisión y slippage > 0, el costo total debe ser > 0');
    assert.ok(r.costDragPct > 0);
});

test('sin comisión ni slippage, el costo total es cero', () => {
    const r = runBacktest(buildSeries(), { ...bullCfg, commissionPct: 0, slippagePct: 0 });
    assert.ok(Math.abs(r.totalCosts) < 1e-9, 'costos deben ser 0');
});

test('el modo de sizing cambia el comportamiento (risk != allin)', () => {
    const rRisk = runBacktest(buildSeries(), { ...bullCfg, sizingMode: 'risk', riskPerTradePct: 0.5, commissionPct: 0.5 });
    const rAll = runBacktest(buildSeries(), { ...bullCfg, sizingMode: 'allin', commissionPct: 0.5 });
    assert.notEqual(rRisk.finalCapital.toFixed(2), rAll.finalCapital.toFixed(2), 'risk y allin no deberían dar idéntico capital final');
});

test('fix del stop-loss: en tendencia alcista la estrategia se mantiene invertida (no vende cada día)', () => {
    // Con el bug viejo (stopLossPct positivo), vendía el primer día de casi todos los trades y
    // la exposición al mercado colapsaba. Con el fix, un uptrend mantiene la posición.
    const r = runBacktest(buildSeries({ drift: 0.006, wave: 0.003 }), { ...bullCfg, sizingMode: 'allin' });
    assert.ok(r.exposurePct > 0.5, `la exposición debería ser alta en un uptrend, fue ${(r.exposurePct * 100).toFixed(0)}%`);
});

test('los retornos son netos de costos (más costo => menor capital final)', () => {
    const cheap = runBacktest(buildSeries(), { ...bullCfg, sizingMode: 'allin', commissionPct: 0.0, slippagePct: 0.0 });
    const pricey = runBacktest(buildSeries(), { ...bullCfg, sizingMode: 'allin', commissionPct: 1.0, slippagePct: 0.5 });
    assert.ok(pricey.finalCapital < cheap.finalCapital, 'con más costos el capital final debe ser menor');
});

test('filtro por zona de entrada: expone los campos y solo cuenta descartes cuando está activo', () => {
    const off = runBacktest(buildSeries(), { ...bullCfg, useEntryZoneFilter: false });
    const on = runBacktest(buildSeries(), { ...bullCfg, useEntryZoneFilter: true });
    assert.equal(off.useEntryZoneFilter, false);
    assert.equal(on.useEntryZoneFilter, true);
    assert.equal(off.entriesSkippedByZone, 0, 'sin filtro no se descarta ninguna entrada');
    assert.ok(on.entriesSkippedByZone >= 0);
});

test('filtro por zona de entrada: descarta entradas cuando el precio está extendido', () => {
    // En la serie sintética la EMA20 queda 3% debajo del precio, así que el precio siempre está
    // EXTENDIDO respecto a la zona: con el filtro activo se descartan las entradas de compra.
    const on = runBacktest(buildSeries(), { ...bullCfg, useEntryZoneFilter: true });
    assert.ok(on.entriesSkippedByZone > 0, 'debería descartar al menos una entrada extendida');
});
