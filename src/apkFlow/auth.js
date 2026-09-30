/* ============================================================================
 * AUTH — OAuth2 de la APK
 * ----------------------------------------------------------------------------
 * Reconstruido del binario:
 *   POST /bdvx-oauth-server/oauth/token?grant_type=password&username=…
 *   POST /bdvx-oauth-server/oauth/token?grant_type=refresh_token&refresh_token=…
 *
 * Los parametros van en la QUERY STRING (asi aparece el literal en libapp.so).
 * Guarda access_token / refresh_token. Una sola sesion (sin logins paralelos).
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const CLIENT = require('./client');
const LOG = require('./logging');
const { RUTAS } = require('./rutas');

const ROOT = path.join(__dirname, '..', '..');

let authEnCurso = null;   // candado: una sola autenticacion a la vez

function credenciales() {
  const env = CLIENT.leerEnv();
  return {
    usuario: env.BDV_USERNAME || env.BDV_USER || env.BDV_USUARIO || env.USUARIO || null,
    clave: env.BDV_PASSWORD || env.BDV_PASS || env.BDV_CLAVE || env.PASSWORD || null,
    // tokens ya existentes en .env: si estan, se reutilizan (misma sesion, sin re-login)
    accessToken: env.BDV_ACCESS_TOKEN || null,
    refreshTokenInicial: env.BDV_REFRESH_TOKEN || null,
  };
}

/** Carga los tokens que ya existan en .env para no repetir login. */
function precargarTokens() {
  const c = credenciales();
  if (c.accessToken) CLIENT.S.accessToken = c.accessToken;
  if (c.refreshTokenInicial) CLIENT.S.refreshToken = c.refreshTokenInicial;
  return !!(c.accessToken || c.refreshTokenInicial);
}

/** LOGIN con grant_type=password (parametros en query, como la APK). */
async function login() {
  const { usuario, clave } = credenciales();
  if (!usuario || !clave) {
    LOG.fallo({
      fase: 'LOGIN',
      endpoint: RUTAS.oauthPassword,
      error: 'faltan credenciales en .env (BDV_USER / BDV_PASS)',
    });
    return { ok: false, error: 'sin credenciales' };
  }

  const query = `grant_type=password&username=${encodeURIComponent(usuario)}`
    + `&password=${encodeURIComponent(clave)}`;

  const r = await CLIENT.pedir(RUTAS.oauthToken, {
    fase: 'LOGIN',
    metodo: 'POST',
    query,
    body: {},
    requiereAuth: false,
    timeoutMs: 30000,
  });

  return guardarToken(r, 'LOGIN');
}

/** REFRESH con grant_type=refresh_token. */
async function refresh() {
  const rt = CLIENT.S.refreshToken;
  if (!rt) return { ok: false, error: 'sin refresh_token' };

  const query = `grant_type=refresh_token&refresh_token=${encodeURIComponent(rt)}`;
  const r = await CLIENT.pedir(RUTAS.oauthToken, {
    fase: 'REFRESH',
    metodo: 'POST',
    query,
    body: {},
    requiereAuth: false,
    timeoutMs: 30000,
  });
  return guardarToken(r, 'REFRESH');
}

function guardarToken(r, fase) {
  const j = r.json;
  if (r.ok && j) {
    const at = j.access_token || (j.data && j.data.access_token) || null;
    const rt = j.refresh_token || (j.data && j.data.refresh_token) || null;
    if (at) {
      CLIENT.S.accessToken = at;
      if (rt) CLIENT.S.refreshToken = rt;
      CLIENT.S.tokenType = j.token_type || 'Bearer';
      CLIENT.S.expiraEn = j.expires_in ? Date.now() + (j.expires_in * 1000) : null;
      LOG.etapa({
        fase, endpoint: RUTAS.oauthToken, metodo: 'POST',
        http: r.http, estado: 'TOKEN_OK', duracionMs: 0,
        respuesta: { token_type: CLIENT.S.tokenType, expires_in: j.expires_in,
                     access_token: '«OCULTO»', refresh_token: rt ? '«OCULTO»' : null },
      });
      return { ok: true };
    }
  }
  LOG.fallo({
    fase, endpoint: RUTAS.oauthToken, metodo: 'POST',
    http: r.http, respuesta: r.json ?? r.texto, error: r.error,
    headers: r.headersEnviados,
  });
  return { ok: false, error: r.error || `HTTP ${r.http}`, http: r.http, json: r.json };
}

/** Asegura sesion. UN solo login en curso (candado). */
function asegurarSesion() {
  if (authEnCurso) return authEnCurso;
  authEnCurso = (async () => {
    // reutilizar tokens del .env si existen (misma sesion, sin re-login)
    precargarTokens();
    if (CLIENT.sesionValida()) return { ok: true, reutilizada: true };
    let r = await refresh();
    if (!r.ok) r = await login();
    return r;
  })().finally(() => { authEnCurso = null; });
  return authEnCurso;
}

function sesionValida() { return CLIENT.sesionValida(); }

module.exports = { login, refresh, asegurarSesion, sesionValida, credenciales, precargarTokens };
