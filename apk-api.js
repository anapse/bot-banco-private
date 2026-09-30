/* ============================================================================
 * apk-api.js — API DEL APK (bdvdigital.banvenez.com)
 * ----------------------------------------------------------------------------
 * ¿POR QUÉ EXISTE ESTE MÓDULO?
 *
 * El bot operaba SOLO contra el portal (bdvenlinea) y ese canal responde
 * SIEMPRE `code=01` / `1001` / HTTP 500 sin motivo: NUNCA refleja si la
 * subasta de intervención está abierta. Por eso el bot vivía diciendo
 * "cerrado" aunque estuviera abierto.
 *
 * El APK oficial usa OTRA API: bdvdigital.banvenez.com con rutas `bdvx-*`.
 * Ese canal SÍ devuelve el estado real.
 *
 * Este módulo integra esos endpoints en el bot para que:
 *   · el modo AUTOMÁTICO pueda operar por el canal correcto
 *   · el modo MANUAL pueda consultar y comprar desde la web
 *
 * ----------------------------------------------------------------------------
 * CÓDIGOS OBSERVADOS (24-09-2026)
 * ----------------------------------------------------------------------------
 *   1000 → OK / operación disponible
 *   1002 → (observado en el flujo de intervención)
 *   1003 → "Las operaciones cambiarias estarán disponibles más tarde"
 *          En la práctica: SIN CUPO en este instante (la subasta se agota
 *          en segundos, por eso aparece casi siempre)
 *   1001 → datos de entrada inválidos
 *   4000 → servicio no disponible
 *   5000 → error inesperado
 *
 * ----------------------------------------------------------------------------
 * NOTAS DE IMPLEMENTACIÓN
 * ----------------------------------------------------------------------------
 *   · El WAF (F5) BLOQUEA las peticiones GET a varias rutas → todo va por POST.
 *   · Los endpoints bdvx-* NO validan el token (con uno basura responden
 *     igual). Aun así se envía el token si está disponible: no molesta y
 *     deja el flujo igual que el del APK.
 *   · NO se reimplementa nada del portal: este módulo es SOLO para el canal
 *     del APK y convive con el resto del bot.
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = __dirname;
const LOG = path.join(RAIZ, 'logs', 'apk-api.log');

const BASE = 'https://bdvdigital.banvenez.com';

/** Endpoints del APK (extraídos de libapp.so del APK oficial). */
const EP = {
  version:      `${BASE}/bdvx-consultas-generales/v1/detalles-version`,
  actividades:  `${BASE}/bdvx-operaciones-cambiarias/v1/operaciones/consultar/actividades`,
  reglas:       `${BASE}/bdvx-operaciones-cambiarias/v1/operaciones/consultar/reglas`,
  reglasCompra: `${BASE}/bdvx-operaciones-cambiarias/v1/operaciones/consultar/reglas/compra`,
  estados:      `${BASE}/bdvx-operaciones-cambiarias/v1/operaciones/consultar/estados`,
  oficinas:     `${BASE}/bdvx-operaciones-cambiarias/v1/operaciones/consultar/oficinas`,
  comprar:      `${BASE}/bdvx-operaciones-cambiarias/v1/operaciones/comprar`,
  confirmar:    `${BASE}/bdvx-operaciones-cambiarias/v1/operaciones/confirmar`,
};

/* ---------- Log ---------- */
function log(nivel, msg) {
  const linea = `[${new Date().toISOString()}] [${nivel}] ${msg}`;
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, linea + '\n');
  } catch (_) { /* seguir */ }
}

/* ---------- Token ---------- */
/**
 * Token para la API del APK.
 * Se acepta el token del portal: sirve para este canal.
 * @returns {string|null}
 */
function leerToken() {
  // 1) token guardado por el propio módulo
  try {
    const p = path.join(RAIZ, 'token-apk.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && j.access_token) return j.access_token;
    }
  } catch (_) { /* seguir */ }

  // 2) token de la sesión del portal
  try {
    const s = JSON.parse(fs.readFileSync(path.join(RAIZ, 'web-session.json'), 'utf8'));
    const t = s && s.data && s.data.data && s.data.data.access_token;
    if (t) return t;
  } catch (_) { /* seguir */ }

  return null;
}

/* ---------- Llamada base ---------- */
/**
 * Llama a un endpoint del APK. SIEMPRE por POST (el WAF bloquea GET).
 *
 * @param {string} url
 * @param {object} payload
 * @returns {Promise<object>} { ok, httpStatus, code, message, data, raw, waf, ms }
 */
async function llamar(url, payload = {}) {
  const t0 = Date.now();
  const token = leerToken();

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'okhttp/4.12.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(15000),
    });

    const texto = await res.text();
    const ms = Date.now() - t0;

    if (texto.includes('Request Rejected')) {
      log('warn', `WAF en ${url}`);
      return { ok: false, waf: true, httpStatus: res.status, code: 'WAF', ms };
    }

    let json = null;
    try { json = JSON.parse(texto); } catch (_) { /* no era JSON */ }

    const out = {
      ok: true,
      waf: false,
      httpStatus: res.status,
      ms,
      code: json && json.code != null ? String(json.code) : null,
      message: json ? json.message : null,
      data: json ? json.data : null,
      raw: json ?? texto.slice(0, 400),
    };

    log('info', `${url.replace(BASE, '')} → ${out.httpStatus} code=${out.code} ${out.ms}ms`);
    return out;
  } catch (e) {
    log('error', `${url.replace(BASE, '')} → ${e.message}`);
    return { ok: false, waf: false, httpStatus: null, code: 'ERR', message: e.message, ms: Date.now() - t0 };
  }
}

/* ============================================================
   CONSULTAS
   ============================================================ */

/** Estado de la compra de intervención. 1000 = disponible. */
async function estadoCompra() {
  return llamar(EP.reglasCompra, {});
}

/** Catálogo de actividades / origen de fondos. */
async function actividades() {
  return llamar(EP.actividades, {});
}

/** Reglas. Requiere `tipoRegla`. */
async function reglas(tipoRegla = 'COMPRA') {
  return llamar(EP.reglas, { tipoRegla });
}

/** Estados de operaciones. */
async function estados() {
  return llamar(EP.estados, {});
}

/** Oficinas. */
async function oficinas() {
  return llamar(EP.oficinas, {});
}

/**
 * Resumen completo del estado por el canal del APK.
 * Es lo que consume la pestaña "APK" de la web.
 */
async function estadoCompleto() {
  const [compra, act] = await Promise.all([
    estadoCompra(),
    actividades(),
  ]);

  const disponible = compra.code === '1000';

  return {
    ts: new Date().toISOString(),
    canal: 'apk',
    base: BASE,
    disponible,
    code: compra.code,
    message: compra.message,
    httpStatus: compra.httpStatus,
    ms: compra.ms,
    waf: compra.waf === true,
    // Lectura humana del código
    significado: disponible
      ? 'DISPONIBLE — se puede comprar ahora'
      : compra.code === '1003'
        ? 'SIN CUPO / cerrada en este instante (se agota en segundos)'
        : compra.code === 'WAF'
          ? 'bloqueado por el WAF del banco'
          : compra.message || `code ${compra.code}`,
    catalogo: act.data || null,
    catalogoCode: act.code,
    endpoints: EP,
  };
}

/* ============================================================
   COMPRA
   ============================================================ */

/**
 * Construye el payload de compra con el esquema REAL del APK.
 *
 * Evidencia (binario + contrato del gateway):
 *  · OperacionDivisas{cuentaOrigenBs, cuentaDestinoDivisa}  ← libapp.so
 *  · … , montoDivisa: … , codigoDivisa: …                   ← libapp.so
 *  · el gateway exige: cuentaOrigenBs, cuentaDestinoDivisa,
 *    montoDivisa, codigoDivisa (confirmado por validación del servidor)
 *
 * @param {object} cfg configuración con cuentas, monto y códigos
 * @param {number} [tasa] tasa a enviar (si no se pasa, no se incluye)
 */
function construirPayload(cfg, tasa = null) {
  const p = {
    cuentaOrigenBs: cfg.cuentaDebito,
    cuentaDestinoDivisa: cfg.cuentaDestino,
    montoDivisa: String(cfg.montoMaxUSD ?? 10),
    codigoDivisa: cfg.codigoDivisa || 'USD',
    codigoRegla: cfg.codigoRegla || 'RGLIC',
    codigoActividadEconomica: String(cfg.codigoActividadEconomica ?? '22'),
    destinoFondos: String(cfg.destinoFondos ?? '11'),
  };
  if (tasa != null && tasa > 0) p.tasaCambio = String(Number(tasa).toFixed(4));
  if (cfg.descOcupacion) p.descOcupacion = cfg.descOcupacion;
  if (cfg.jornadaDivisa) p.jornadaDivisa = cfg.jornadaDivisa;
  return p;
}

/**
 * Envía la orden de compra por el canal del APK.
 * @param {object} payload
 */
async function comprar(payload) {
  return llamar(EP.comprar, payload);
}

/**
 * Confirma una operación ya enviada.
 * @param {object} payload
 */
async function confirmar(payload) {
  return llamar(EP.confirmar, payload);
}

/**
 * COMPRA COMPLETA: envía y, si acepta, confirma.
 * Devuelve todo el rastro para poder reconstruir el flujo.
 *
 * @param {object} cfg
 * @param {number} [tasa]
 * @param {number} [hilos] disparos en paralelo (la subasta se agota rápido)
 */
async function comprarCompleto(cfg, tasa = null, hilos = 1) {
  const payload = construirPayload(cfg, tasa);
  const n = Math.max(1, Math.min(10, hilos));

  const inicio = Date.now();
  const intentos = await Promise.all(
    Array.from({ length: n }, () => comprar(payload))
  );

  // Primer intento aceptado
  let aceptada = null;
  for (const r of intentos) {
    const ok =
      r.code === '1000' ||
      (r.httpStatus === 200 && r.data &&
        (r.data.idOperacion || r.data.numeroOperacion || r.data.referencia));
    if (ok) { aceptada = r; break; }
  }

  const resultado = {
    ts: new Date().toISOString(),
    payload,
    hilos: n,
    duracionMs: Date.now() - inicio,
    intentos: intentos.map((r) => ({
      httpStatus: r.httpStatus, code: r.code, message: r.message, ms: r.ms,
    })),
    aceptada: !!aceptada,
  };

  if (aceptada) {
    const idOper = aceptada.data &&
      (aceptada.data.idOperacion || aceptada.data.id || aceptada.data.numeroOperacion);

    const conf = await confirmar(
      idOper ? { ...payload, operacionId: idOper } : payload
    );

    resultado.data = aceptada.data;
    resultado.confirmacion = {
      httpStatus: conf.httpStatus, code: conf.code,
      message: conf.message, data: conf.data,
    };
    log('info', `COMPRA ACEPTADA code=${aceptada.code} id=${idOper ?? '-'} conf=${conf.code}`);
  } else {
    log('info', `sin cupo: ${intentos[0].code}`);
  }

  // Evidencia completa
  try {
    fs.appendFileSync(
      path.join(RAIZ, 'logs', 'apk-compras.jsonl'),
      JSON.stringify(resultado) + '\n'
    );
  } catch (_) { /* seguir */ }

  return resultado;
}

module.exports = {
  BASE,
  EP,
  llamar,
  leerToken,
  estadoCompra,
  estadoCompleto,
  actividades,
  reglas,
  estados,
  oficinas,
  construirPayload,
  comprar,
  confirmar,
  comprarCompleto,
};
