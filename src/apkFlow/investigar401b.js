/* ============================================================================
 * INVESTIGACION 401 — v2 (corrige el parseo del .env)
 * ----------------------------------------------------------------------------
 * Las credenciales SI estan en .env. Este script:
 *   1. Hace LOGIN REAL en el portal (flujo 2 pasos) y obtiene token.
 *   2. Prueba ese token contra la API de la APK (bdvdigital).
 *   3. Hace LOGIN REAL contra bdvdigital con las credenciales reales.
 *   4. Registra la respuesta exacta de cada intento.
 *
 * NO llama a /comprar ni /confirmar.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

// ---- parseo robusto del .env ----
function leerEnv() {
  const E = {};
  const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const linea of txt.split(/\r?\n/)) {
    const s = linea.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 1) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    E[k] = v;
  }
  return E;
}
const ENV = leerEnv();
const oc = (s) => (s ? `presente(${String(s).length} chars)` : 'AUSENTE');

async function pedir(url, { method = 'GET', headers = {}, body = null, timeout = 20000 } = {}) {
  try {
    const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeout) });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (_) {}
    return { http: r.status, json: j, texto: t.slice(0, 300), headers: Object.fromEntries([...r.headers].slice(0, 10)) };
  } catch (e) {
    return { http: null, json: null, texto: `ERROR: ${e.message}` };
  }
}

(async () => {
  console.log('\n' + '='.repeat(78));
  console.log('  INVESTIGACION 401 — v2');
  console.log('='.repeat(78));
  console.log(`  BDV_USERNAME : ${ENV.BDV_USERNAME || 'AUSENTE'}`);
  console.log(`  BDV_PASSWORD : ${oc(ENV.BDV_PASSWORD)}`);
  console.log('='.repeat(78));

  const U = ENV.BDV_USERNAME || '';
  const P = ENV.BDV_PASSWORD || '';

  // =======================================================================
  // A. LOGIN contra el HOST DE LA APK (bdvdigital) con credenciales REALES
  // =======================================================================
  console.log('\n[A] LOGIN REAL contra bdvdigital (host de la APK)');
  const q = `grant_type=password&username=${encodeURIComponent(U)}&password=${encodeURIComponent(P)}`;
  const a1 = await pedir(`https://bdvdigital.banvenez.com/bdvx-oauth-server/oauth/token?${q}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  });
  console.log(`  POST /bdvx-oauth-server/oauth/token?grant_type=password`);
  console.log(`     → HTTP ${a1.http}`);
  console.log(`     respuesta: ${a1.texto.slice(0, 220)}`);

  // variante: por body
  const a2 = await pedir('https://bdvdigital.banvenez.com/bdvx-oauth-server/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=password&username=${encodeURIComponent(U)}&password=${encodeURIComponent(P)}`,
  });
  console.log(`  POST /bdvx-oauth-server/oauth/token  (form-urlencoded en body)`);
  console.log(`     → HTTP ${a2.http}`);
  console.log(`     respuesta: ${a2.texto.slice(0, 220)}`);

  // =======================================================================
  // B. LOGIN REAL en el PORTAL (bdvenlinea) — flujo del proyecto
  // =======================================================================
  console.log('\n[B] LOGIN REAL en el PORTAL (bdvenlinea) — flujo 2 pasos');
  const b1 = await pedir('https://bdvenlinea.banvenez.com/oauthaccess/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: U, clave: P }),
  });
  console.log(`  paso 1 POST /oauthaccess/login → HTTP ${b1.http}`);
  console.log(`     ${b1.texto.slice(0, 200)}`);

  // =======================================================================
  // C. ¿Los endpoints ABIERTOS de bdvdigital dan datos utiles?
  // =======================================================================
  console.log('\n[C] ENDPOINTS ABIERTOS de bdvdigital (sin auth) — ¿qué datos dan?');
  for (const ruta of [
    '/bdvx-geolocalizacion/api/offices/all',
    '/bdvx-afiliacion-directorio/v1/bancos/all',
  ]) {
    const r = await pedir(`https://bdvdigital.banvenez.com${ruta}`, { headers: { 'Content-Type': 'application/json' } });
    console.log(`\n  GET ${ruta}`);
    console.log(`     → HTTP ${r.http}   code=${r.json ? (r.json.code ?? '-') : '-'}`);
    if (r.json && r.json.data) {
      const d = r.json.data;
      if (Array.isArray(d)) {
        console.log(`     array[${d.length}] · claves del primer item: ${Object.keys(d[0] || {}).join(', ')}`);
        console.log(`     muestra: ${JSON.stringify(d[0]).slice(0, 150)}`);
      } else {
        console.log(`     ${JSON.stringify(d).slice(0, 180)}`);
      }
    }
  }

  // =======================================================================
  // D. Confirmar: ¿el 401 es por AUTH o por RUTA? Probar ruta inexistente
  // =======================================================================
  console.log('\n[D] ¿401 por AUTH o por RUTA? — comparar ruta real vs inventada');
  for (const ruta of [
    '/bdvx-operaciones-cambiarias/v1/operaciones/consultar/actividades',
    '/bdvx-operaciones-cambiarias/v1/operaciones/consultar/NO-EXISTE',
    '/bdvx-host-inventado/v1/no-existe',
  ]) {
    const r = await pedir(`https://bdvdigital.banvenez.com${ruta}`, { headers: { 'Content-Type': 'application/json' } });
    console.log(`  ${ruta.slice(0, 56).padEnd(58)} → HTTP ${r.http}  ${r.texto.slice(0, 70)}`);
  }

  console.log('\n' + '='.repeat(78) + '\n');
})();
