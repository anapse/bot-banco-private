/* ============================================================================
 * INVESTIGACION DEL 401 — probar variantes de autenticacion REALES
 * ----------------------------------------------------------------------------
 * Objetivo: determinar si el 401 de bdvdigital se resuelve con algun token
 * valido, y si el token del PORTAL sirve en la API de la APK (o viceversa).
 *
 * NO se inventa ninguna credencial. Se usan:
 *   · las credenciales del .env para el login real del portal
 *   · la ruta de OAuth que usa cada host (extraidas del binario/proyecto)
 *
 * NO se llama a /comprar ni /confirmar.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;

const ENV = {};
try {
  for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) ENV[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) {}

const oculto = (s) => s ? `presente(${String(s).length})` : 'AUSENTE';

async function pedir(url, { method = 'GET', headers = {}, body = null, timeout = 15000 } = {}) {
  try {
    const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeout) });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (_) {}
    return { http: r.status, json: j, texto: t.slice(0, 260) };
  } catch (e) {
    return { http: null, json: null, texto: `ERROR: ${e.message}` };
  }
}

(async () => {
  console.log('\n' + '='.repeat(78));
  console.log('  INVESTIGACION DEL 401 — VARIANTES DE AUTENTICACION REALES');
  console.log('='.repeat(78));
  console.log(`  BDV_USERNAME      : ${oculto(ENV.BDV_USERNAME)}`);
  console.log(`  BDV_PASSWORD      : ${oculto(ENV.BDV_PASSWORD)}`);
  console.log(`  BDV_ACCESS_TOKEN  : ${oculto(ENV.BDV_ACCESS_TOKEN)}`);
  console.log(`  BDV_REFRESH_TOKEN : ${oculto(ENV.BDV_REFRESH_TOKEN)}`);
  console.log('='.repeat(78));

  // -----------------------------------------------------------------------
  // 1. LOGIN REAL del portal (bdvenlinea) para obtener un token de verdad
  // -----------------------------------------------------------------------
  console.log('\n[1] LOGIN REAL DEL PORTAL (bdvenlinea) — para obtener token válido');
  const portalBase = 'https://bdvenlinea.banvenez.com';
  let tokenPortal = null;

  // el portal usa login en 2 pasos; probamos el flujo real del proyecto
  const rLogin = await pedir(`${portalBase}/oauthaccess/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: ENV.BDV_USERNAME, clave: ENV.BDV_PASSWORD }),
  });
  console.log(`  POST /oauthaccess/login → HTTP ${rLogin.http}`);
  console.log(`     ${rLogin.texto.slice(0, 180)}`);

  if (rLogin.http === 200 && rLogin.json) {
    tokenPortal = rLogin.json.access_token || (rLogin.json.data && rLogin.json.data.access_token) || null;
    console.log(`     token obtenido: ${oculto(tokenPortal)}`);
  }

  // -----------------------------------------------------------------------
  // 2. Probar el token del PORTAL contra la API de la APK (bdvdigital)
  // -----------------------------------------------------------------------
  if (tokenPortal) {
    console.log('\n[2] TOKEN DEL PORTAL contra la API DE LA APK (bdvdigital)');
    for (const ruta of [
      '/bdvx-operaciones-cambiarias/v1/operaciones/consultar/actividades',
      '/bdvx-consulta-cuenta-v2/v1/cuenta/saldo-v2',
    ]) {
      const r = await pedir(`https://bdvdigital.banvenez.com${ruta}`, {
        headers: { Authorization: `Bearer ${tokenPortal}`, 'Content-Type': 'application/json' },
      });
      console.log(`  GET ${ruta.slice(0, 52)}`);
      console.log(`     → HTTP ${r.http}  ${r.texto.slice(0, 130)}`);
    }
  } else {
    console.log('\n[2] Sin token del portal — no se puede probar el cruce de hosts.');
  }

  // -----------------------------------------------------------------------
  // 3. Variantes de autenticacion contra el HOST DE LA APK
  // -----------------------------------------------------------------------
  console.log('\n[3] VARIANTES DE AUTH contra bdvdigital (login)');
  const ak = ENV.BDV_APP_KEY || ENV.APP_KEY || null;
  const variantes = [
    ['Basic user:pass', { Authorization: 'Basic ' + Buffer.from(`${ENV.BDV_USERNAME}:${ENV.BDV_PASSWORD}`).toString('base64') }],
    ['Bearer refresh_token', ENV.BDV_REFRESH_TOKEN ? { Authorization: `Bearer ${ENV.BDV_REFRESH_TOKEN}` } : null],
    ['Bearer access_token', ENV.BDV_ACCESS_TOKEN ? { Authorization: `Bearer ${ENV.BDV_ACCESS_TOKEN}` } : null],
    ['app-key + Bearer', (ak && ENV.BDV_ACCESS_TOKEN) ? { 'app-key': ak, Authorization: `Bearer ${ENV.BDV_ACCESS_TOKEN}` } : null],
  ].filter((x) => x[1]);

  for (const [nombre, h] of variantes) {
    const r = await pedir('https://bdvdigital.banvenez.com/bdvx-oauth-server/oauth/token?grant_type=password&username=x&password=x', {
      method: 'POST', headers: h,
    });
    console.log(`  ${nombre.padEnd(22)} → HTTP ${r.http}  ${r.texto.slice(0, 90)}`);
  }
  if (!variantes.length) console.log('  (no hay tokens en .env para probar variantes)');

  // -----------------------------------------------------------------------
  // 4. ¿El gateway expone algo SIN auth? (rutas publicas)
  // -----------------------------------------------------------------------
  console.log('\n[4] RUTAS PUBLICAS en bdvdigital (sin auth)');
  for (const ruta of [
    '/bdvx-consultas-generales/v1/detalles-version',
    '/bdvx-afiliacion-directorio/v1/bancos/all',
    '/bdvx-geolocalizacion/api/offices/all',
    '/bdvx-consulta-apertura/v1/apertura/consultaEstado',
  ]) {
    const r = await pedir(`https://bdvdigital.banvenez.com${ruta}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`  GET ${ruta.slice(0, 56).padEnd(58)} → HTTP ${r.http}  ${r.texto.slice(0, 80)}`);
  }

  console.log('\n' + '='.repeat(78) + '\n');
})();
