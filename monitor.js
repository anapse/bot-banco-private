/* ============================================================================
 * MONITOR INTERVENCIÓN CAMBIARIA — 100% CMD (sin interfaz web)
 * ----------------------------------------------------------------------------
 * Vigila el estado de las operaciones cambiarias del BDV usando EXACTAMENTE las
 * mismas llamadas que ya usa el proyecto (mismos endpoints, métodos, headers,
 * cifrado y autenticación). No inventa endpoints ni payloads.
 *
 *   EXRI      → POST /altaintervencioncambiaria/consultarReglasEXRI
 *   SUBASTA   → GET  /validar-mercado/validar-subasta
 *   MERCADO   → POST /menudeo/consulta-mercado/
 *   COMPRA    → POST /mesacambiaria/sellbuycurrencyEXCV
 *
 * Al detectar condiciones reales de operación, valida todo y ejecuta la compra
 * con la función que ya funciona. Registra todo en logs/bot-YYYY-MM-DD.log.
 *
 * Uso:  node monitor.js                 (intervalo por defecto)
 *       node monitor.js --intervalo=2000
 *       node monitor.js --una-vez        (una sola comprobación)
 * ========================================================================== */
'use strict';

// ---------- módulos del proyecto (implementaciones REALES, no copias) ----------
// Se reutiliza server.js cargado en modo "monitor": no abre el puerto ni la web.
process.env.BDV_MONITOR_ONLY = 'true';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const LOGS_DIR = path.join(ROOT, 'logs');

// ---------------------------- configuración --------------------------------
const args = process.argv.slice(2);
const argDe = (n) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : null;
};
// Intervalo entre comprobaciones (muy configurable: --intervalo=MS o variable de entorno)
const CHECK_INTERVAL_MS = Math.max(
  250,
  parseInt(argDe('intervalo') || process.env.CHECK_INTERVAL_MS || '2000', 10)
);
const UNA_VEZ = args.includes('--una-vez');
// Backoff ante errores consecutivos (no saturar el banco)
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60000;

// ---------------------------- utilidades -----------------------------------
function nowIso() { return new Date().toISOString(); }
const hora = () => new Date().toLocaleTimeString('es-VE', { hour12: false });

const RUTA_LOG = () => path.join(LOGS_DIR, `bot-${nowIso().slice(0, 10)}.log`);

// Credenciales: nunca en claro en el log
const SENSIBLE = /password|clave|secret|token|authorization|cookie|huella|app-?key/i;
function ocultar(x, clave) {
  if (x == null) return x;
  if (typeof x === 'string') {
    let s = x
      .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1«OCULTO»')
      .replace(/\beyJ[A-Za-z0-9._-]{4,}/g, '«JWT»')
      .replace(/\b(\d{16})(\d{4})\b/g, '«CUENTA-…$2»');
    return s;
  }
  if (Array.isArray(x)) return x.map((v) => ocultar(v, clave));
  if (typeof x === 'object') {
    const out = {};
    for (const k of Object.keys(x)) {
      out[k] = (SENSIBLE.test(k) && (typeof x[k] === 'string' || typeof x[k] === 'number'))
        ? `«OCULTO:${String(x[k]).length}»`
        : ocultar(x[k], k);
    }
    return out;
  }
  return x;
}

// Escribe en el log del día (mismo formato del proyecto: texto legible + JSON)
function mon(level, msg, evento) {
  const linea = `[${nowIso()}] [${level}] [MONITOR] ${msg}`;
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(RUTA_LOG(), linea + '\n');
    if (evento) {
      fs.appendFileSync(RUTA_LOG(), JSON.stringify({ ts: nowIso(), origen: 'monitor', ...ocultar(evento) }) + '\n');
    }
  } catch (_) {}
  console.log(linea);
}

// ---------------------------- estado del monitor ---------------------------
const S = {
  ciclos: 0,
  erroresConsecutivos: 0,
  intentosCompra: 0,
  purchase_in_progress: false,   // protección doble compra
  purchase_confirmed: false,     // compra confirmada → detener
  previo: null,                  // respuesta anterior (para detectar cambios)
  previoSubasta: null,
  previoMercado: null,
  ultimaCompra: null,
};

// ------------------- carga del motor real del proyecto ---------------------
// server.js expone lo necesario mediante un pequeño bloque de exportación al
// final. Si no estuviera, se avisa claramente (no se reimplementa nada).
let MOTOR = null;
function cargarMotor() {
  try {
    MOTOR = require('./motor-bdv.js');
    return true;
  } catch (e) {
    console.error(`\n  ❌ No se pudo cargar el motor del proyecto (motor-bdv.js): ${e.message}\n`);
    return false;
  }
}

// ---------------------------- presentación CMD -----------------------------
const L = '='.repeat(58);
function cabecera() {
  console.log('\n' + L);
  console.log('        MONITOR INTERVENCION CAMBIARIA');
  console.log(L);
  console.log(`  intervalo : ${CHECK_INTERVAL_MS} ms`);
  console.log(`  log       : logs/bot-${nowIso().slice(0, 10)}.log`);
  console.log(`  monto     : ${MOTOR.cfg.montoMaxUSD} USD`);
  console.log(`  destino   : ${MOTOR.cfg.destinoFondos}`);
  console.log(`  actividad : ${MOTOR.cfg.codigoActividadEconomica}`);
  console.log(L + '\n');
}

function pintarExri(r) {
  console.log(`[${hora()}] EXRI`);
  console.log(`        code       : ${r.code ?? '—'}`);
  console.log(`        estado     : ${r.estado === 'abierta' ? 'ABIERTO' : (r.estado === 'cerrada' ? 'CERRADO' : String(r.estado).toUpperCase())}`);
  console.log(`        data       : ${r.dataEsNull ? 'null' : 'objeto'}`);
  console.log(`        regla      : ${r.regla ?? '—'}`);
  if (r.tasaTexto) console.log(`        tasaRef    : ${r.tasaTexto}`);
  if (r.cupoPersNaturales != null) console.log(`        cupo       : ${r.cupoPersNaturales}`);
  if (r.porcentajeComision != null) console.log(`        comisión   : ${r.porcentajeComision}%`);
  if (r.description) console.log(`        desc       : ${String(r.description).slice(0, 70)}`);
}

function pintarSubasta(v) {
  console.log(`[${hora()}] SUBASTA`);
  console.log(`        code       : ${v.code ?? '—'}`);
  console.log(`        estado     : ${(String(v.code) === '1001') ? 'NO DISPONIBLE' : 'REVISAR'}`);
  if (v.message) console.log(`        message    : ${String(v.message).slice(0, 70)}`);
}

function pintarMercado(m) {
  console.log(`[${hora()}] MERCADO`);
  console.log(`        estado     : ${m.estadoPolitica === 'A' ? 'ACTIVO' : (m.estadoPolitica ?? '—')}`);
  console.log(`        venta USD  : ${m.ventaUSDTexto ?? '—'}   (menudeo — NO es la tasa EXRI)`);
  console.log(`        compra USD : ${m.compraUSDTexto ?? '—'}`);
}

// ----------------------- detección de cambios ------------------------------
function diff(nombre, antes, ahora, claves) {
  const cambios = [];
  for (const k of claves) {
    const a = antes ? antes[k] : undefined;
    const b = ahora ? ahora[k] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      cambios.push({ campo: `${nombre}.${k}`, antes: a ?? null, despues: b ?? null });
    }
  }
  return cambios;
}

function avisarCambios(cambios, primeraVez) {
  if (!cambios.length) return;
  // El PRIMER ciclo sólo aprende el estado (antes no había nada): no es un cambio
  // del banco, es el monitor descubriendo el estado inicial. No se avisa ni alerta.
  if (primeraVez) {
    mon('info', `estado inicial registrado: ` + cambios.map((c) => `${c.campo}=${c.despues}`).join(' | '),
      { tipo: 'estado_inicial', cambios });
    return;
  }
  console.log('\n' + '─'.repeat(58));
  for (const c of cambios) {
    console.log(`  🔔 CAMBIO  ${c.campo}: ${c.antes === null ? 'null' : c.antes}  →  ${c.despues === null ? 'null' : c.despues}`);
  }
  console.log('─'.repeat(58) + '\n');
  mon('info', `CAMBIO detectado (${cambios.length}): ` + cambios.map((c) => `${c.campo} ${c.antes}→${c.despues}`).join(' | '),
    { tipo: 'cambio', cambios });
}

// ----------------------- comprobación completa -----------------------------
async function comprobar() {
  S.ciclos++;
  const r = await MOTOR.consultarTodo();   // EXRI + SUBASTA + MERCADO (llamadas reales)

  // --- pintar en CMD
  pintarExri(r.exri);
  console.log('');
  pintarSubasta(r.subasta);
  console.log('');
  pintarMercado(r.mercado);

  // --- registrar respuesta completa (sin secretos)
  mon('info', `EXRI code=${r.exri.code} estado=${r.exri.estado} data=${r.exri.dataEsNull ? 'null' : 'objeto'} tasa=${r.exri.tasaTexto || '-'} cupo=${r.exri.cupoPersNaturales ?? '-'}`,
    { tipo: 'exri', ...r.exri });
  mon('info', `SUBASTA http=${r.subasta.httpStatus} code=${r.subasta.code}`,
    { tipo: 'subasta', ...r.subasta });
  mon('info', `MERCADO estadoPolitica=${r.mercado.estadoPolitica} ventaUSD=${r.mercado.ventaUSDTexto} compraUSD=${r.mercado.compraUSDTexto}`,
    { tipo: 'mercado', ...r.mercado });

  // --- detectar cambios contra la comprobación anterior
  // Un fallo de red (code/httpStatus null) NO es un cambio del banco: se ignora para
  // no llenar el log de falsos "cambios" cada vez que una consulta no llega.
  const caidaRed = (v) => (v && v.code == null && v.httpStatus == null);
  const cambios = [
    ...(caidaRed(r.exri) ? [] : diff('exri', S.previo, r.exri,
      ['code', 'dataEsNull', 'estado', 'tasaTexto', 'cupoPersNaturales', 'porcentajeComision', 'regla', 'description'])),
    ...(caidaRed(r.subasta) ? [] : diff('subasta', S.previoSubasta, r.subasta, ['code', 'httpStatus', 'message'])),
    ...(caidaRed(r.mercado) ? [] : diff('mercado', S.previoMercado, r.mercado, ['estadoPolitica', 'ventaUSDTexto', 'compraUSDTexto'])),
  ].filter((c) => c.antes !== c.despues);
  const primeraVez = S.previo === null;
  avisarCambios(cambios, primeraVez);

  S.previo = r.exri;
  S.previoSubasta = r.subasta;
  S.previoMercado = r.mercado;

  return { r, cambios, primeraVez };
}

// ----------------------- validación antes de comprar -----------------------
function validarParaComprar(r) {
  const motivos = [];
  const e = r.exri;

  if (!MOTOR.sesionViva()) motivos.push('sesión/token no válido');
  if (e.estado !== 'abierta') motivos.push(`EXRI no abierto (estado=${e.estado}, code=${e.code})`);
  if (!MOTOR.hayRegla()) motivos.push('sin codigoRegla del banco');
  if (!(e.tasaReferencia > 0)) motivos.push('sin tasa de intervención (tasaReferencia)');
  if (e.cupoPersNaturales == null) motivos.push('sin cupo del banco (cupoPersNaturales)');

  // saldo suficiente según los datos que ya usa el proyecto
  const saldo = MOTOR.saldoDisponible();
  const necesario = (MOTOR.cfg.montoMaxUSD || 0) * (e.tasaReferencia || 0);
  if (saldo != null && necesario > 0 && saldo < necesario) {
    motivos.push(`saldo insuficiente (${saldo} < ${necesario.toFixed(2)} Bs)`);
  }

  // payload construible
  const p = MOTOR.construirPayload(e.tasaReferencia);
  if (!p) motivos.push('no se pudo construir el payload de compra');
  if (p && (!p.cuentaOrigenBs || !p.cuentaDestino || !p.codigoRegla || !p.destinoFondos)) {
    motivos.push('payload incompleto (cuentas/regla/destino)');
  }

  return { ok: motivos.length === 0, motivos, payload: p, saldo, necesario };
}

// ----------------------- compra automática ---------------------------------
async function comprar(payload, exri) {
  if (S.purchase_in_progress) { mon('warn', 'compra ya en curso — se ignora'); return; }
  if (S.purchase_confirmed) { mon('warn', 'compra ya confirmada — no se repite'); return; }

  S.purchase_in_progress = true;
  S.intentosCompra++;

  console.log('\n' + L);
  console.log('     ENVIANDO COMPRA — sellbuycurrencyEXCV');
  console.log(L);
  mon('info', `ENVIANDO COMPRA #${S.intentosCompra} — payload: ${JSON.stringify(ocultar(payload))}`,
    { tipo: 'compra_envio', intento: S.intentosCompra, payload: ocultar(payload), tasa: exri.tasaReferencia, regla: exri.regla });

  let res;
  try {
    res = await MOTOR.ejecutarCompra(payload);
  } catch (e) {
    S.purchase_in_progress = false;
    mon('error', `compra falló al enviar: ${e.message}`, { tipo: 'compra_error', error: e.message });
    return;
  }
  S.purchase_in_progress = false;

  const estado = res.estadoBanco;
  mon('info', `RESPUESTA COMPRA: http=${res.httpStatus} code=${res.codigo} estado=${estado}`,
    { tipo: 'compra_respuesta', intento: S.intentosCompra, httpStatus: res.httpStatus,
      codigo: res.codigo, estadoBanco: estado, respuesta: res.json });

  if (estado === 'aceptada') {
    S.purchase_confirmed = true;
    S.ultimaCompra = {
      hora: nowIso(),
      monto: payload.montoDivisa,
      tasa: payload.tasaCambio,
      referencia: res.referencia || res.operacionId || '—',
      regla: payload.codigoRegla,
      destino: payload.destinoFondos,
      actividad: payload.codigoActividadEconomica,
      respuesta: res.json,
    };
    console.log('\n' + L);
    console.log('             COMPRA CONFIRMADA');
    console.log(L);
    console.log(`  Hora       : ${S.ultimaCompra.hora}`);
    console.log(`  Monto      : ${S.ultimaCompra.monto} USD`);
    console.log(`  Tasa       : ${S.ultimaCompra.tasa} Bs`);
    console.log(`  Regla      : ${S.ultimaCompra.regla}`);
    console.log(`  Destino    : ${S.ultimaCompra.destino}`);
    console.log(`  Actividad  : ${S.ultimaCompra.actividad}`);
    console.log(`  Referencia : ${S.ultimaCompra.referencia}`);
    console.log(`  Respuesta  : ${JSON.stringify(res.json)}`);
    console.log('\n  MONITOR DETENIDO');
    console.log(L + '\n');
    mon('info', 'COMPRA CONFIRMADA — monitor detenido', { tipo: 'compra_confirmada', ...S.ultimaCompra });
  } else {
    console.log(`\n  ⚠️  COMPRA RECHAZADA / NO CONFIRMADA (code=${res.codigo}, estado=${estado})`);
    console.log(`      respuesta: ${JSON.stringify(res.json)}\n`);
    mon('warn', `COMPRA RECHAZADA/NO CONFIRMADA (code=${res.codigo}) — se sigue vigilando`,
      { tipo: 'compra_rechazada', codigo: res.codigo, estadoBanco: estado, respuesta: res.json });
  }
}

// ----------------------- bucle principal -----------------------------------
async function main() {
  if (!cargarMotor()) process.exit(1);

  // sesión única (misma autenticación del proyecto)
  const okSes = await MOTOR.preparar();
  if (!okSes) {
    console.error('\n  ❌ No se pudo iniciar sesión (revisa .env y la conexión).\n');
    process.exit(1);
  }

  cabecera();

  let backoff = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (S.purchase_confirmed) {
      console.log('  ✅ Compra confirmada — el monitor termina.');
      break;
    }

    let espera = CHECK_INTERVAL_MS;
    try {
      const { r } = await comprobar();
      S.erroresConsecutivos = 0;
      backoff = 0;

      // ¿señal de posible apertura? → comprobación completa inmediata.
      // OJO: sólo cuenta si hay DATOS REALES. Un fallo de red deja code=null y
      // NO es una apertura (antes se disparaba en falso con cada timeout).
      const subastaOk = r.subasta && r.subasta.code != null;
      const senalApertura = r.exri.estado === 'abierta'
        || (subastaOk && String(r.subasta.code) !== '1001');
      if (senalApertura) {
        console.log(`[${hora()}] ⚡ Posible apertura detectada — validación completa…`);
        const v = validarParaComprar(r);
        if (v.ok) {
          await comprar(v.payload, r.exri);
        } else {
          console.log(`[${hora()}] NO COMPRAR — ${v.motivos.join('; ')}`);
          mon('info', `NO COMPRAR — ${v.motivos.join('; ')}`,
            { tipo: 'no_comprar', motivos: v.motivos, exri: r.exri });
        }
      }

      console.log(`[${hora()}] Próxima comprobación en ${Math.round(espera / 1000)} s…\n`);
    } catch (e) {
      S.erroresConsecutivos++;
      backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, Math.min(S.erroresConsecutivos, 6)));
      espera = Math.max(espera, backoff);
      console.log(`[${hora()}] ⚠️ error (${S.erroresConsecutivos} seguidos): ${e.message}`);
      console.log(`[${hora()}]    backoff → ${Math.round(espera / 1000)} s\n`);
      mon('error', `error en comprobación (#${S.erroresConsecutivos}): ${e.message}`,
        { tipo: 'error', error: e.message, backoffMs: espera });
    }

    if (UNA_VEZ) break;
    await new Promise((r) => setTimeout(r, espera));
  }
}

main().catch((e) => {
  console.error('\n  ❌ Monitor detenido por error:', e.message, '\n');
  process.exit(1);
});
