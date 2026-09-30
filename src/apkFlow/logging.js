/* ============================================================================
 * LOGGING DEL FLUJO APK — logs separados por naturaleza
 * ----------------------------------------------------------------------------
 *   logs/apk-flow-YYYY-MM-DD.log    → cada etapa del flujo (request/response)
 *   logs/apk-errors-YYYY-MM-DD.log  → fallos, con endpoint/HTTP/headers
 *   logs/portal-YYYY-MM-DD.log      → el monitor del portal (flujo antiguo)
 *
 * Nunca se registran: password, tokens completos, cookies, app-key.
 * Un archivo por día; se AÑADE siempre (nunca sobrescribe ni borra).
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');

// ------------------------------ saneado ------------------------------------
const SENSIBLE_KEY = /password|passwd|clave|secret|token|cookie|authorization|app-?key|huella|otp|pin/i;
const JWT = /\beyJ[A-Za-z0-9._-]{6,}/g;
const BEARER = /(Bearer\s+)[A-Za-z0-9._-]+/gi;
const CUENTA = /\b(\d{16})(\d{4})\b/g;

function maskStr(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(BEARER, '$1«OCULTO»')
    .replace(JWT, '«JWT»')
    .replace(CUENTA, '«CUENTA-…$2»');
}

/** Sanea recursivamente. Los campos sensibles se sustituyen por «OCULTO:n». */
function sanitize(x, prof = 0) {
  if (x == null || prof > 6) return x;
  if (typeof x === 'string') return maskStr(x);
  if (Array.isArray(x)) return x.slice(0, 60).map((v) => sanitize(v, prof + 1));
  if (typeof x === 'object') {
    const o = {};
    for (const k of Object.keys(x)) {
      const v = x[k];
      if (SENSIBLE_KEY.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        o[k] = `«OCULTO:${String(v).length}»`;
      } else {
        o[k] = sanitize(v, prof + 1);
      }
    }
    return o;
  }
  return x;
}

/** Lista de headers sin valores: solo nombres presentes/ausentes (sin filtrar secretos). */
function nombresHeaders(h) {
  if (!h) return { presentes: [], faltantes: [] };
  const presentes = Object.keys(h).map((k) => k.toLowerCase());
  // headers que la APK espera segun el analisis de libapp.so
  const esperados = ['app-key', 'authorization', 'content-type', 'accept', 'user-agent'];
  const faltantes = esperados.filter((e) => !presentes.includes(e));
  return { presentes, faltantes };
}

// ------------------------------ escritura ----------------------------------
function ruta(tipo, fecha) {
  const dia = String(fecha || new Date().toISOString()).slice(0, 10);
  return path.join(LOGS_DIR, `${tipo}-${dia}.log`);
}

function escribir(tipo, linea) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(ruta(tipo), linea + '\n');
  } catch (_) {}
}

function ts() { return new Date().toISOString(); }
function ms() { return Date.now(); }

/**
 * Registra una etapa del flujo APK.
 * @param {object} e  { fase, endpoint, metodo, http, code, estado, duracionMs,
 *                      respuesta, solicitud, headers, notas }
 */
function etapa(e) {
  const reg = {
    ts: ts(),
    flujo: 'APK',
    fase: e.fase,
    endpoint: e.endpoint || null,
    metodo: e.metodo || null,
    http: e.http ?? null,
    code: e.code ?? null,
    estado: e.estado || null,
    duracionMs: e.duracionMs ?? null,
    solicitud: e.solicitud ? sanitize(e.solicitud) : null,
    respuesta: e.respuesta !== undefined ? sanitize(e.respuesta) : null,
    notas: e.notas ? maskStr(String(e.notas)) : null,
  };
  // línea legible
  const legible = `[${reg.ts}] [APK] [${reg.fase}] ${reg.metodo || ''} ${reg.endpoint || ''} `
    + `http=${reg.http ?? '-'} code=${reg.code ?? '-'} estado=${reg.estado || '-'} ${reg.duracionMs ?? '-'}ms`
    + (reg.notas ? ` · ${reg.notas}` : '');
  escribir('apk-flow', legible);
  escribir('apk-flow', JSON.stringify(reg));
  return reg;
}

/** Registra un fallo con el detalle exigido: endpoint, HTTP, respuesta, headers. */
function fallo(e) {
  const hh = nombresHeaders(e.headers);
  const reg = {
    ts: ts(),
    flujo: 'APK',
    fase: e.fase,
    endpoint: e.endpoint || null,
    metodo: e.metodo || null,
    http: e.http ?? null,
    code: e.code ?? null,
    error: e.error ? maskStr(String(e.error)) : null,
    respuesta: e.respuesta !== undefined ? sanitize(e.respuesta) : null,
    headersPresentes: hh.presentes,
    headersFaltantes: hh.faltantes,
    solicitud: e.solicitud ? sanitize(e.solicitud) : null,
  };
  escribir('apk-errors', `[${reg.ts}] FALLO en ${reg.fase}`);
  escribir('apk-errors', `   endpoint   : ${reg.endpoint}`);
  escribir('apk-errors', `   HTTP       : ${reg.http ?? '-'}   code: ${reg.code ?? '-'}`);
  escribir('apk-errors', `   respuesta  : ${JSON.stringify(reg.respuesta)}`);
  escribir('apk-errors', `   headers presentes : ${hh.presentes.join(', ') || '(ninguno)'}`);
  escribir('apk-errors', `   headers faltantes : ${hh.faltantes.join(', ') || '(ninguno)'}`);
  if (reg.error) escribir('apk-errors', `   error      : ${reg.error}`);
  escribir('apk-errors', JSON.stringify(reg));
  return reg;
}

/** Log del flujo del PORTAL (separado, para no mezclar). */
function portal(nivel, msg, extra) {
  const linea = `[${ts()}] [PORTAL] [${nivel}] ${maskStr(String(msg))}`;
  escribir('portal', linea);
  if (extra) escribir('portal', JSON.stringify({ ts: ts(), flujo: 'PORTAL', ...sanitize(extra) }));
}

module.exports = { etapa, fallo, portal, sanitize, nombresHeaders, ruta };
