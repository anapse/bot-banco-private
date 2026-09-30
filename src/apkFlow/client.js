/* ============================================================================
 * CLIENTE HTTP DEL FLUJO APK
 * ----------------------------------------------------------------------------
 * Implementa el cliente tal como lo hace la APK: Dio + interceptores.
 * El interceptor añade los headers que la APK inyecta en TODAS las peticiones.
 *
 * TODO lo de este archivo sale del analisis de libapp.so:
 *   - host          : https://bdvdigital.banvenez.com:443
 *   - headers       : app-key, Authorization, content-type, Accept, user-agent
 *   - rutas         : ver rutas.js (extraidas del binario)
 *   - auth          : OAuth2 grant_type en query string
 *
 * APP-KEY: NO se inventa. Se lee de:
 *   1. .env  (BDV_APP_KEY)
 *   2. config.json (appKey)
 * Si no existe en ninguno, el cliente arranca SIN app-key y lo REPORTA como
 * header faltante (no se inventa un valor). El diagnostico mostrara el fallo.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const LOG = require('./logging');

const ROOT = path.join(__dirname, '..', '..');

// ---------------------------- configuracion --------------------------------
const HOST = 'https://bdvdigital.banvenez.com';
const BASE = `${HOST}`;

function leerEnv() {
  const ENV = {};
  try {
    for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) ENV[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
  return ENV;
}

function leerConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch (_) {
    return {};
  }
}

/** app-key: SOLO desde configuracion. Nunca se genera ni se inventa. */
function appKey() {
  const env = leerEnv();
  const cfg = leerConfig();
  return env.BDV_APP_KEY || env.APP_KEY || cfg.appKey || null;
}

// ------------------------------ estado -------------------------------------
const S = {
  accessToken: null,
  refreshToken: null,
  expiraEn: null,
  tokenType: 'Bearer',
  httpStatusUltimo: null,
  headersUltimos: null,
};

// --------------------------- peticion base ---------------------------------
/**
 * Ejecuta una peticion al host de la APK con los headers que usa la APK.
 * Registra todo en el log del flujo APK.
 */
async function pedir(rutaUrl, {
  fase = 'HTTP',
  metodo = 'GET',
  body = undefined,
  query = null,
  timeoutMs = 25000,
  requiereAuth = true,
  contentType = 'application/json',
} = {}) {
  const url = `${BASE}${rutaUrl}${query ? `?${query}` : ''}`;
  const t0 = Date.now();

  // --- headers, tal como los arma la APK (interceptor) ---
  const headers = {
    'Accept': 'application/json',
    'content-type': contentType,
    'user-agent': 'BDV-Digital/Android',
  };
  const ak = appKey();
  if (ak) {
    headers['app-key'] = ak;             // solo si existe configurado
  }
  if (requiereAuth && S.accessToken) {
    headers['Authorization'] = `${S.tokenType} ${S.accessToken}`;
  }

  let resultado;
  try {
    const res = await fetch(url, {
      method: metodo,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch (_) {}

    S.httpStatusUltimo = res.status;
    S.headersUltimos = headers;

    const code = json && (json.code ?? json.codigo ?? json.status ?? null);
    resultado = {
      ok: res.ok,
      http: res.status,
      json,
      texto: texto.slice(0, 500),
      headersEnviados: headers,
    };

    LOG.etapa({
      fase, endpoint: rutaUrl, metodo, http: res.status, code,
      estado: res.ok ? 'OK' : 'HTTP_ERROR',
      duracionMs: Date.now() - t0,
      solicitud: body,
      respuesta: json ?? resultado.texto,
      notas: ak ? null : 'SIN app-key configurada',
    });
    return resultado;
  } catch (e) {
    resultado = { ok: false, http: null, json: null, texto: null, error: e.message, headersEnviados: headers };
    LOG.fallo({
      fase, endpoint: rutaUrl, metodo, http: null,
      error: e.message, headers,
    });
    return resultado;
  }
}

// ------------------------------- sesion ------------------------------------
function sesionValida() { return !!S.accessToken; }
function token() { return S.accessToken; }
function headersActuales() {
  const ak = appKey();
  return {
    ...(ak ? { 'app-key': '«presente»' } : {}),
    ...(S.accessToken ? { Authorization: '«presente»' } : {}),
  };
}

module.exports = {
  HOST, BASE, S,
  pedir, appKey, sesionValida, token, headersActuales,
  leerEnv, leerConfig,
};
