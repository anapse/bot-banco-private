/* ============================================================================
 * FLUJO APK — orquestador
 * ----------------------------------------------------------------------------
 * Ejecuta el flujo reconstruido del binario de la APK:
 *
 *   LOGIN → TOKEN → SALDO → CLIENTE → INTERVENCION_INIT → EXRI → MERCADO
 *   → REGLAS → REGLAS_COMPRA → ACTIVIDADES → ESTADOS → OFICINAS
 *   → (COMPRAR) → (CONFIRMAR)
 *
 * Modos:
 *   --diagnostic-apk   solo lectura: recorre el flujo y reporta dónde falla
 *   --dry-run-apk      recorre TODO hasta justo antes de comprar
 *
 * NO se ejecuta ninguna compra real salvo que se pida explicitamente con
 * --live-apk Y el diagnostico haya pasado las etapas previas.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const CLIENT = require('./client');
const AUTH = require('./auth');
const INV = require('./intervention');
const OPS = require('./operations');
const LOG = require('./logging');

const ROOT = path.join(__dirname, '..', '..');
const L = '='.repeat(66);

function cfg() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); }
  catch (_) { return {}; }
}

function linea(fase, estado, extra = '') {
  const punto = '.'.repeat(Math.max(2, 22 - String(fase).length));
  console.log(`  [APK] ${String(fase).padEnd(20)} ${punto} ${estado}${extra ? '  ' + extra : ''}`);
}

function resumen(res) {
  const o = {};
  for (const r of res) o[r.fase] = r;
  return o;
}

// ---------------------------------------------------------------------------
// DIAGNOSTICO: recorre el flujo en modo lectura y reporta el punto de fallo
// ---------------------------------------------------------------------------
async function diagnostic() {
  console.log('\n' + L);
  console.log('           FLUJO APK — DIAGNOSTICO');
  console.log(L);
  const c = cfg();
  const ak = CLIENT.appKey();
  console.log(`  HOST        : ${CLIENT.HOST}`);
  console.log(`  app-key     : ${ak ? `presente («OCULTO:${ak.length}»)` : '⚠️  NO CONFIGURADA'}`);
  console.log(`  monto       : ${c.montoMaxUSD} USD`);
  console.log(`  destino     : ${c.destinoFondos}`);
  console.log(`  actividad   : ${c.codigoActividadEconomica}`);
  console.log(L + '\n');

  const res = [];
  const add = (fase, estado, det = null) => { res.push({ fase, estado, det }); };

  // 1. LOGIN
  const s = await AUTH.asegurarSesion();
  if (!s.ok) {
    linea('LOGIN', 'ERROR', s.error || '');
    add('LOGIN', 'ERROR', s);
    reportarFallo('LOGIN', s);
    return res;
  }
  linea('LOGIN', 'OK');
  add('LOGIN', 'OK');
  linea('TOKEN', 'OK', CLIENT.S.accessToken ? '(sesión activa)' : '');

  // 2. SALDO
  const rSal = await CLIENT.pedir('/bdvx-consulta-cuenta-v2/v1/cuenta/saldo-v2', {
    fase: 'SALDO', metodo: 'GET',
  });
  linea('SALDO', rSal.ok ? 'OK' : `ERROR (HTTP ${rSal.http})`);
  add('SALDO', rSal.ok ? 'OK' : 'ERROR', rSal);
  if (!rSal.ok) reportarFallo('SALDO', rSal);

  // 3. CLIENTE
  const rCli = await CLIENT.pedir('/bdvx-detalles-cliente/cliente/', {
    fase: 'CLIENTE', metodo: 'GET',
  });
  linea('CLIENTE', rCli.ok ? 'OK' : `ERROR (HTTP ${rCli.http})`);
  add('CLIENTE', rCli.ok ? 'OK' : 'ERROR', rCli);

  // 4. INTERVENCION INIT
  const rIni = await INV.init();
  linea('INTERVENCION', rInit(rIni));
  add('INTERVENCION', rIni.ok ? 'OK' : 'ERROR', rIni);
  if (!rIni.ok) reportarFallo('INTERVENCION_INIT', rIni);

  // 5. EXRI
  const exri = await INV.reglasEXRI();
  linea('EXRI', exri.ok ? `OK (code=${exri.code}, estado=${exri.estado})` : `ERROR (HTTP ${exri.http})`);
  add('EXRI', exri.ok ? 'OK' : 'ERROR', exri);
  if (!exri.ok) reportarFallo('EXRI', exri);

  // 6. MERCADO
  const m = await INV.mercado();
  linea('MERCADO', m.ok ? `OK (ventaUSD=${m.ventaUSDTexto || '-'})` : `ERROR (HTTP ${m.http})`);
  add('MERCADO', m.ok ? 'OK' : 'ERROR', m);
  if (!m.ok) reportarFallo('MERCADO', m);

  // 7..11 consultas de operaciones
  for (const [fase, fn] of [
    ['REGLAS COMPRA', OPS.reglasCompra],
    ['ACTIVIDADES', OPS.actividades],
    ['ESTADOS', OPS.estados],
    ['OFICINAS', OPS.oficinas],
  ]) {
    const r = await fn();
    linea(fase, r.ok ? `OK (${r.n} items)` : `ERROR (HTTP ${r.http})`);
    add(fase, r.ok ? 'OK' : 'ERROR', r);
    if (!r.ok) reportarFallo(fase, r);
  }

  // 12-13 no se ejecutan en diagnostico
  linea('COMPRA', 'NO EJECUTADA');
  linea('CONFIRMACION', 'NO EJECUTADA');
  add('COMPRA', 'NO EJECUTADA');
  add('CONFIRMACION', 'NO EJECUTADA');

  // ---- resumen
  console.log('\n' + L);
  const oks = res.filter((r) => r.estado === 'OK').length;
  const errs = res.filter((r) => r.estado === 'ERROR').length;
  console.log(`  ETAPAS OK: ${oks}   ERROR: ${errs}`);
  if (errs === 0) console.log('  ✅ El flujo APK responde correctamente.');
  else console.log('  ⚠️  Hay etapas con fallo — ver logs/apk-errors-*.log');
  console.log(L + '\n');
  return res;
}

function rInit(r) { return r.ok ? 'OK' : `ERROR (HTTP ${r.http})`; }

function reportarFallo(fase, r) {
  const ak = CLIENT.appKey();
  LOG.fallo({
    fase, endpoint: r.endpoint || r.url || fase,
    metodo: r.metodo || null, http: r.http,
    code: r.code ?? null, respuesta: r.json ?? r.texto,
    error: r.error, headers: r.headersEnviados || CLIENT.headersActuales(),
  });
  console.log('\n  ' + '─'.repeat(62));
  console.log('  FALLO:');
  console.log(`     fase        : ${fase}`);
  console.log(`     endpoint    : ${r.endpoint || '(ver log)'}`);
  console.log(`     HTTP        : ${r.http ?? '-'}`);
  console.log(`     code        : ${r.code ?? '-'}`);
  console.log(`     respuesta   : ${JSON.stringify(r.json ?? r.texto ?? null).slice(0, 160)}`);
  console.log(`     app-key     : ${ak ? 'presente' : '⚠️  FALTANTE — el gateway de bdvdigital la exige (404 sin ella)'}`);
  console.log(`     Authorization: ${CLIENT.sesionValida() ? 'presente' : 'FALTANTE'}`);
  console.log('  ' + '─'.repeat(62) + '\n');
}

// ---------------------------------------------------------------------------
// DRY RUN: recorre TODO hasta justo antes de comprar y muestra el payload
// ---------------------------------------------------------------------------
async function dryRun() {
  console.log('\n' + L);
  console.log('        FLUJO APK — DRY RUN (no se ejecuta compra)');
  console.log(L + '\n');

  const res = await diagnostic();
  const por = resumen(res);
  const errs = res.filter((r) => r.estado === 'ERROR');

  if (errs.length) {
    console.log('  ⛔ El flujo NO esta completo: hay etapas con error.');
    console.log('     No se prepara el payload porque faltan datos del banco.');
    console.log(L + '\n');
    return { ok: false, etapas: res };
  }

  // ---- payload (con las claves reales del binario)
  const c = cfg();
  const exri = (por['EXRI'] || {}).det || {};
  const payload = OPS.construirPayload({
    cuentaOrigenBs: c.cuentaDebito,
    cuentaDestinoDivisa: c.cuentaDestino,
    monto: c.montoMaxUSD,
    tasa: exri.tasa || 0,
    codigoRegla: exri.regla || null,
    codigoActividadEconomica: c.codigoActividadEconomica,
    descOcupacion: c.descOcupacion || '',
    destinoFondos: c.destinoFondos,
  });

  console.log(L);
  console.log('  PAYLOAD PREPARADO (endpoint: ' + '/bdvx-operaciones-cambiarias/v1/operaciones/comprar' + ')');
  console.log(L);
  console.log('  ' + JSON.stringify(LOG.sanitize(payload), null, 2).replace(/\n/g, '\n  '));
  console.log(L);

  LOG.etapa({
    fase: 'DRY_RUN', endpoint: '/bdvx-operaciones-cambiarias/v1/operaciones/comprar',
    metodo: 'POST', http: null, estado: 'NO_EJECUTADA',
    solicitud: payload, notas: 'dry-run: no se envio',
  });

  console.log('\n' + L);
  console.log('  DRY RUN');
  console.log('  No se ejecutó ninguna operación.');
  console.log(L + '\n');
  return { ok: true, etapas: res, payload };
}

module.exports = { diagnostic, dryRun, reportarFallo, linea };

// --------------------------------- CLI -------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  (async () => {
    if (args.includes('--dry-run-apk')) {
      const r = await dryRun();
      process.exit(r.ok ? 0 : 2);
    } else if (args.includes('--diagnostic-apk')) {
      const r = await diagnostic();
      process.exit(r.some((x) => x.estado === 'ERROR') ? 2 : 0);
    } else {
      console.log('Uso: node src/apkFlow/index.js [--diagnostic-apk | --dry-run-apk]');
    }
  })().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
