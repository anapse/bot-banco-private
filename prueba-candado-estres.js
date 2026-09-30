/* ============================================================================
 * PRUEBA 2 — ESTRÉS: 20 llamadas simultáneas + escenario de RENOVACIÓN válida
 * ----------------------------------------------------------------------------
 * NO toca el banco. Comprueba dos escenarios distintos:
 *   A) 20 disparadores a la vez, con renovación FALLIDA → 1 login, 1 set
 *   B) 20 disparadores a la vez, con renovación VÁLIDA  → 1 renovación, 0 logins
 * Ejecutar:  node prueba-candado-estres.js
 * ========================================================================== */
'use strict';

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
let escenario = 'A';

const c = { renovaciones: 0, sets: 0, intentos: 0, pasos1: 0, pasos2: 0, ok: 0 };
let cupo = 3;

const bot = { webLoginData: null, webLoginTs: 0 };
let authPromise = null, webLoginPromise = null, authCount = 0, authEsperas = 0;

async function webRenewFalso() {
  c.renovaciones++;
  await esperar(20 + Math.random() * 30);
  if (escenario === 'A') throw new Error('sin refresh_token');
  bot.webLoginTs = Date.now();                          // renovación válida
  bot.webLoginData = { data: { access_token: 'renovado', refresh_token: 'r2', expires_in: '179' } };
  return { expires_in: '179' };
}
async function doWebLoginFalso() {
  c.pasos1++; await esperar(20 + Math.random() * 30);
  c.pasos2++; await esperar(20 + Math.random() * 30);
  c.intentos++;
  if (cupo-- > 0) throw new Error('Login web rechazado (13): cupo lleno');
  c.ok++;
  bot.webLoginData = { data: { access_token: 'tok', refresh_token: 'ref', expires_in: '179' } };
  bot.webLoginTs = Date.now();
  return { codigo: '00' };
}
async function webLogin() {
  if (webLoginPromise) { authEsperas++; return webLoginPromise; }
  webLoginPromise = doWebLoginFalso().finally(() => { webLoginPromise = null; });
  return webLoginPromise;
}
function asegurarSesionWeb() {
  if (authPromise) { authEsperas++; return authPromise; }
  if (bot.webLoginData && bot.webLoginData.data && bot.webLoginData.data.access_token &&
      bot.webLoginTs && Date.now() - bot.webLoginTs <= 150000) {
    return Promise.resolve();
  }
  authCount++;
  authPromise = _autenticarUnaVez().finally(() => { authPromise = null; });
  return authPromise;
}
async function _autenticarUnaVez() {
  c.sets++;
  try {
    if (bot.webLoginData && bot.webLoginData.data && bot.webLoginData.data.refresh_token) {
      await webRenewFalso();
    } else throw new Error('sin refresh_token');
  } catch (e) {
    for (let i = 1; i <= 12; i++) {
      try { await webLogin(); break; }
      catch (e2) {
        if (/13|cupo lleno|sesi[oó]n activa/i.test(e2.message)) { await esperar(30); continue; }
        throw e2;
      }
    }
  }
  if (!bot.webLoginData || !bot.webLoginData.data || !bot.webLoginData.data.access_token) {
    throw new Error('No se pudo obtener sesión web tras renovación/login');
  }
}

function reset() {
  c.renovaciones = c.sets = c.intentos = c.pasos1 = c.pasos2 = c.ok = 0;
  // El escenario B simula "hay sesión guardada con refresh_token pero el token
  // ya venció" → es justo el caso que debe RENOVAR sin loguear.
  if (escenario === 'B') {
    bot.webLoginData = { data: { access_token: 'viejo', refresh_token: 'ref-valido', expires_in: '179' } };
    bot.webLoginTs = Date.now() - 200000;   // 200 s > 150 s → token vencido
  } else {
    bot.webLoginData = null; bot.webLoginTs = 0;
  }
  authPromise = webLoginPromise = null; authCount = 0; authEsperas = 0;
  cupo = 3;
}

(async () => {
  let fallos = 0;
  for (const esc of ['A', 'B']) {
    escenario = esc; reset();
    const N = 20;
    const t0 = Date.now();
    const r = await Promise.allSettled(Array.from({ length: N }, () => asegurarSesionWeb()));
    const ms = Date.now() - t0;
    const exitos = r.filter((x) => x.status === 'fulfilled').length;

    console.log(`\n=== ESCENARIO ${esc} — ${N} llamadas SIMULTÁNEAS ===`);
    console.log(`  ${esc === 'A' ? 'renovación FALLIDA (obliga a re-loguear)' : 'renovación VÁLIDA (no debe loguear)'}`);
    console.log(`  autenticaciones reales : ${authCount}   (debe ser 1)`);
    console.log(`  sets de reintentos     : ${c.sets}   (debe ser 1)`);
    console.log(`  renovaciones           : ${c.renovaciones}   (debe ser ${esc === 'A' ? 0 : 1})`);
    console.log(`  intentos de login      : ${c.intentos}   (${esc === 'A' ? '3 (cupo lleno x2 + 1 ok)' : '0'})`);
    console.log(`  llamadas que esperaron : ${authEsperas}`);
    console.log(`  sesión obtenida        : ${exitos}/${N}`);
    console.log(`  duración               : ${ms} ms`);

    const checks = esc === 'A'
      ? [['1 autenticación', authCount === 1], ['1 set de reintentos', c.sets === 1],
         ['1 login exitoso', c.ok === 1], [`${N}/${N} con sesión`, exitos === N],
         ['paso1 === paso2 (sin paralelos)', c.pasos1 === c.pasos2]]
      : [['1 autenticación', authCount === 1], ['1 renovación', c.renovaciones === 1],
         ['0 logins (no hizo falta)', c.intentos === 0], [`${N}/${N} con sesión`, exitos === N]];
    for (const [n, ok] of checks) { console.log(`    ${ok ? '✅' : '❌'} ${n}`); if (!ok) fallos++; }
  }
  console.log(`\n${fallos === 0
    ? '🎉 ESTRÉS CORRECTO — 20 llamadas simultáneas → 1 sola autenticación en ambos escenarios.'
    : `⚠️  ${fallos} comprobación(es) fallaron.`}\n`);
  process.exit(fallos === 0 ? 0 : 1);
})();
