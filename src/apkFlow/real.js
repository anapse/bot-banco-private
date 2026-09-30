/* ============================================================================
 * FLUJO APK REAL — monitor + compra
 * ----------------------------------------------------------------------------
 * Ejecuta el flujo de la APK y COMPRA de verdad cuando la intervencion este
 * disponible. Sin diagnosticos separados: el intento real ES la prueba.
 *
 *   LOGIN → SESION → ESTADO/REGLAS → disponible?
 *      NO  → seguir vigilando
 *      SI  → reglas/compra → actividades → estados → oficinas
 *            → construir payload → COMPRAR → confirmar si hace falta
 *
 * Todo el flujo sale del analisis de libapp.so (rutas, headers, campos).
 * app-key: solo desde configuracion (.env BDV_APP_KEY / config.json appKey).
 * NUNCA se inventa.
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
const L = '='.repeat(68);

const INTERVALO_MS = Math.max(500, parseInt(process.env.APK_INTERVAL_MS || '2000', 10));

const hora = () => new Date().toLocaleTimeString('es-VE', { hour12: false });

function cfg() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); }
  catch (_) { return {}; }
}

// ------------------------------ estado -------------------------------------
const S = {
  purchaseInProgress: false,
  purchaseConfirmed: false,
  intentos: 0,
  previo: null,
};

function log(fase, msg, extra) {
  const linea = `[${new Date().toISOString()}] [APK] [${fase}] ${msg}`;
  console.log(linea);
  LOG.etapa({ fase, endpoint: null, metodo: null, http: null, estado: msg, notas: extra ? JSON.stringify(LOG.sanitize(extra)) : null });
}

// ---------------------------------------------------------------------------
// Construye el payload EXACTAMENTE con los campos del binario
// ---------------------------------------------------------------------------
function construirCompra(c, exri, reglas) {
  // de las reglas de compra del banco se toman los codigos reales
  const r0 = (reglas && reglas.lista && reglas.lista[0]) || {};
  return {
    // --- modelo OperacionDivisas{cuentaOrigenBs, cuentaDestinoDivisa}
    cuentaOrigenBs: c.cuentaDebito,
    cuentaDestinoDivisa: c.cuentaDestino,
    // --- modelo TransaccionMenudeo{montoDivisas, monto}
    monto: Number(c.montoMaxUSD).toFixed(2),
    montoDivisas: Number(c.montoMaxUSD).toFixed(2),
    tasaCambio: Number(exri.tasa || 0).toFixed(4),
    // --- reglas / clasificacion (del binario)
    codigoRegla: r0.codigoRegla || exri.regla || null,
    codigoOperacion: r0.codigoOperacion || null,
    codigoDivisa: r0.codigoDivisa || 'USD',
    tipoServicio: r0.tipoServicio || null,
    // --- actividad y destino (nombres exactos del binario)
    codigoActividadEconomica: c.codigoActividadEconomica,
    descOcupacion: c.descOcupacion || '',
    destinoFondos: c.destinoFondos,
  };
}

// ---------------------------------------------------------------------------
// Un ciclo: consulta, y si se puede, COMPRA
// ---------------------------------------------------------------------------
async function ciclo() {
  S.intentos++;

  // 1. sesion (una sola)
  const ses = await AUTH.asegurarSesion();
  if (!ses.ok) {
    // El host de la APK exige autenticacion propia (app-key). NO es un fallo de
    // compra: se informa una vez y se sigue vigilando sin spamear errores.
    if (!S._sesionAvisada || S.intentos % 30 === 0) {
      S._sesionAvisada = true;
      console.log(`[${hora()}] ⚠️  Sin sesión en ${CLIENT.HOST} — ${ses.error || 'no autenticado'}`
        + ` (HTTP ${ses.http ?? '-'}) · el flujo APK no puede consultar hasta tener app-key`);
      LOG.portal('warn', `SESION APK no disponible: ${ses.error || ''} HTTP=${ses.http ?? '-'}`);
    }
    return { comprado: false, motivo: 'sin sesion (app-key requerida)' };
  }

  // 2. estado EXRI (disponibilidad real)
  const exri = await INV.reglasEXRI();
  const mercado = await INV.mercado();

  const resumen = `code=${exri.code} estado=${exri.estado} tasa=${exri.tasaTexto || '-'} `
    + `cupo=${exri.cupoPersNaturales ?? '-'} http=${exri.http}`;
  console.log(`\n[${new Date().toLocaleTimeString('es-VE', { hour12: false })}] intento ${S.intentos} · EXRI ${resumen}`);
  console.log(`        mercado: ${mercado.ventaUSDTexto || '-'} Bs (menudeo, NO EXRI)`);

  // cambio respecto al anterior
  if (S.previo && (S.previo.code !== exri.code || S.previo.estado !== exri.estado
      || S.previo.tasaTexto !== exri.tasaTexto)) {
    console.log('        🔔 CAMBIO: '
      + `code ${S.previo.code}→${exri.code} · estado ${S.previo.estado}→${exri.estado} · `
      + `tasa ${S.previo.tasaTexto || '-'}→${exri.tasaTexto || '-'}`);
  }
  S.previo = { code: exri.code, estado: exri.estado, tasaTexto: exri.tasaTexto };

  // 3. ¿VENTA ABIERTA? — validación ESTRICTA.
  //    NUNCA se compra si:
  //      · la consulta falló (code == null → timeout o error de red)
  //      · el estado no es 'abierta'
  //      · no hay tasa real de intervención (> 0)
  //    Esto garantiza que un timeout/null NO se interprete como apertura.
  const consultaOk = exri.ok === true && exri.code != null && !exri.error;
  const hayTasa = Number(exri.tasa) > 0;
  const abierta = exri.abierta === true;

  if (!consultaOk) {
    return { comprado: false, motivo: `consulta falló (${exri.error || 'sin datos'}) — se espera` };
  }
  if (exri.code === '01') {
    return { comprado: false, motivo: 'code 01 · Transacción no disponible — se espera' };
  }
  if (!abierta || !hayTasa) {
    return { comprado: false, motivo: `venta CERRADA (estado=${exri.estado}, code=${exri.code}, tasa=${exri.tasaTexto || 'sin tasa'}) — se espera` };
  }

  console.log(`\n  🎯 INTERVENCIÓN DISPONIBLE — ejecutando flujo de compra de la APK`);
  log('DISPONIBLE', `EXRI abierto: code=${exri.code} tasa=${exri.tasaTexto} cupo=${exri.cupoPersNaturales}`);

  // 4. consultas previas que hace la APK (en su orden)
  const c = cfg();
  const reglasC = await OPS.reglasCompra();
  console.log(`        REGLAS COMPRA : ${reglasC.ok ? `OK (${reglasC.n})` : `ERROR HTTP ${reglasC.http}`}`);
  const act = await OPS.actividades();
  console.log(`        ACTIVIDADES   : ${act.ok ? `OK (${act.n})` : `ERROR HTTP ${act.http}`}`);
  const est = await OPS.estados();
  console.log(`        ESTADOS       : ${est.ok ? `OK (${est.n})` : `ERROR HTTP ${est.http}`}`);
  const ofi = await OPS.oficinas();
  console.log(`        OFICINAS      : ${ofi.ok ? `OK (${ofi.n})` : `ERROR HTTP ${ofi.http}`}`);
  await INV.init();

  // 5. payload
  const payload = construirCompra(c, exri, reglasC);
  console.log(`\n  PAYLOAD: ${JSON.stringify(LOG.sanitize(payload))}`);
  log('PAYLOAD', 'construido desde el flujo de la APK', { payload: LOG.sanitize(payload) });

  // 6. COMPRAR (real)
  if (S.purchaseInProgress) { console.log('  (compra ya en curso — se ignora)'); return { comprado: false, motivo: 'en curso' }; }
  S.purchaseInProgress = true;

  console.log(`\n  ▶ COMPRANDO en /bdvx-operaciones-cambiarias/v1/operaciones/comprar …`);
  const r = await OPS.comprar(payload);
  S.purchaseInProgress = false;

  const clas = OPS.clasificar(r);
  console.log(`  RESPUESTA: HTTP ${r.http} · code=${r.json ? (r.json.code ?? r.json.codigo) : '-'} · ${clas}`);
  console.log(`  CUERPO: ${JSON.stringify(r.json ?? r.texto)}`);

  log('COMPRA', `HTTP ${r.http} · ${clas}`, { respuesta: r.json ?? r.texto, payload });

  // 7. confirmar si el banco devuelve identificador
  const j = r.json || {};
  const opId = j.operacionId || (j.data && (j.data.operacionId || j.data.id)) || j.id || null;
  if (clas === 'aceptada' || opId) {
    console.log(`\n  ▶ CONFIRMANDO (endpoint separado de la APK) opId=${opId} …`);
    const rc = await OPS.confirmar(payload, opId);
    console.log(`  CONFIRMACION: HTTP ${rc.http} · ${JSON.stringify(rc.json ?? rc.texto)}`);
    log('CONFIRMACION', `HTTP ${rc.http}`, { respuesta: rc.json ?? rc.texto });
  }

  // 8. resultado
  if (clas === 'aceptada') {
    S.purchaseConfirmed = true;
    console.log('\n' + L);
    console.log('               ✅ COMPRA CONFIRMADA');
    console.log(L);
    console.log(`  Intento #${S.intentos}`);
    console.log(`  Monto   : ${payload.monto} USD`);
    console.log(`  Tasa    : ${payload.tasaCambio} Bs`);
    console.log(`  Respuesta: ${JSON.stringify(r.json)}`);
    console.log(L + '\n');
    return { comprado: true, respuesta: r.json, payload };
  }

  console.log(`  ❌ NO confirmada (${clas}) — se seguirá intentando\n`);
  return { comprado: false, motivo: clas, respuesta: r.json };
}

// ---------------------------------------------------------------------------
// Bucle principal: vigila y compra
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n' + L);
  console.log('      FLUJO APK REAL — MONITOR + COMPRA');
  console.log(L);
  const c = cfg();
  const ak = CLIENT.appKey();
  console.log(`  HOST      : ${CLIENT.HOST}`);
  console.log(`  app-key   : ${ak ? `presente («OCULTO:${ak.length}»)` : '⚠️  NO CONFIGURADA (se envía sin ella)'}`);
  console.log(`  monto     : ${c.montoMaxUSD} USD`);
  console.log(`  intervalo : ${INTERVALO_MS} ms`);
  console.log(L + '\n');

  // login inicial (una sola vez)
  const s = await AUTH.asegurarSesion();
  if (!s.ok) {
    console.log(`  ⚠️  SESIÓN: no disponible (HTTP ${s.http ?? '-'}) — ${s.error || 'no autenticado'}`);
    console.log(`  Respuesta del servidor: ${JSON.stringify(s.json ?? null)}`);
    console.log('  → El host de la APK exige su propio app-key (no está en la APK).');
    console.log('  → Se seguirá vigilando sin intentar comprar.\n');
  } else {
    console.log(`  ✅ Sesión iniciada (${s.reutilizada ? 'reutilizada del .env' : 'login nuevo'})\n`);
  }

  // --- ¿ya cerró? Si el banco está cerrado, NO se intenta comprar.
  //     Se consulta y se espera; la compra sólo se dispara con venta ABIERTA.
  while (!S.purchaseConfirmed) {
    try {
      const r = await ciclo();
      // Mientras el banco esté cerrado o falte sesión NO se informa cada ciclo:
      // solo se informa cuando CAMBIA el motivo (evita spam de líneas repetidas).
      const motivo = r && r.motivo ? r.motivo : null;
      if (motivo && motivo !== S._ultimoMotivo) {
        S._ultimoMotivo = motivo;
        console.log(`        → ${motivo}`);
      }
    } catch (e) {
      console.log(`  ⚠️  error en el ciclo: ${e.message}`);
      LOG.fallo({ fase: 'CICLO', error: e.message });
    }
    await new Promise((r) => setTimeout(r, INTERVALO_MS));
  }
  console.log('  ✅ Compra confirmada — el monitor termina.');
}

module.exports = { ciclo, main, construirCompra };

if (require.main === module) {
  main().catch((e) => { console.error('ERROR FATAL:', e.message); process.exit(1); });
}
