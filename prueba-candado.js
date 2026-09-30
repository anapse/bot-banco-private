/* ============================================================================
 * PRUEBA LOCAL DEL CANDADO ÚNICO DE AUTENTICACIÓN
 * ----------------------------------------------------------------------------
 * NO toca el banco. Simula el modelo de concurrencia REAL del server.js:
 *   · un único candado (authPromise) que envuelve TODO el proceso de auth
 *   · N llamadas SIMULTÁNEAS a asegurarSesionWeb() desde varios "disparadores"
 *     (arranque, renovación 30 s, menudeo 5 min, intervención 30 s, petición HTTP)
 * y verifica que solo se produce:
 *       1 login · 1 renovación · 1 conjunto de reintentos
 *
 * Ejecutar:  node prueba-candado.js
 * ========================================================================== */
'use strict';

/* ------------------------- banco simulado (falso) ------------------------- */
// El caso REAL observado: la renovación no está disponible y el banco responde
// "cupo lleno (13)" un par de veces ANTES de aceptar. Lo que debe ser ÚNICO es
// la CADENA de reintentos (un solo ciclo 1→2→3), no cada intento individual.
const contadores = { renovaciones: 0, pasos1: 0, pasos2: 0, loginsOK: 0, setsReintento: 0, intentos: 0 };
let fallarRenovacion = true;   // la renovación falla → obliga a re-loguear
let cupoLlenoVeces = 2;        // el banco devuelve "cupo lleno (13)" las 2 primeras veces

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Simula POST /oauthaccess/actualizar (webRenew)
async function webRenewFalso() {
  contadores.renovaciones++;
  await esperar(30 + Math.random() * 40);           // latencia de red simulada
  if (fallarRenovacion) throw new Error('sin refresh_token');
  return { expires_in: '179' };
}

// Simula el login de 2 pasos (doWebLogin → webLogin)
async function doWebLoginFalso() {
  contadores.pasos1++;
  await esperar(40 + Math.random() * 40);           // paso 1: verificar usuario
  contadores.pasos2++;
  await esperar(40 + Math.random() * 40);           // paso 2: enviar clave
  contadores.intentos++;
  if (cupoLlenoVeces > 0) {                          // el banco dice "cupo lleno"
    cupoLlenoVeces--;
    throw new Error('Login web rechazado (13): cupo lleno');
  }
  contadores.loginsOK++;
  bot.webLoginData = { data: { access_token: 'tok-prueba', refresh_token: 'ref-prueba', expires_in: '179' } };
  bot.webLoginTs = Date.now();
  return { codigo: '00', ticketId: 'T' + Date.now() };
}

/* --------------------- el CANDADO ÚNICO (igual que server.js) -------------- */
const bot = { webLoginData: null, webLoginTs: 0, webTicket: null };
let authPromise = null;
let authCount = 0;
let authEsperas = 0;
let webLoginPromise = null;
const LOG = [];

function log(level, msg) { LOG.push(`  [${level}] ${msg}`); }

async function webLogin() {
  if (webLoginPromise) { authEsperas++; return webLoginPromise; }  // login en vuelo: se comparte
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
  contadores.setsReintento++;   // UN set de reintentos por autenticación (nunca uno por llamador)
  try {
    if (bot.webLoginData && bot.webLoginData.data && bot.webLoginData.data.refresh_token) {
      log('info', 'Token por vencer — renovando sesión…');
      await webRenewFalso();
    } else {
      throw new Error('sin refresh_token');
    }
  } catch (e) {
    log('warn', `Renovación no disponible (${e.message}) — re-logueando…`);
    for (let intento = 1; intento <= 12; intento++) {
      try {
        log('info', `Login web (intento ${intento})…`);
        await webLogin();
        break;
      } catch (e2) {
        if (/13|cupo lleno|sesion activa|sesión activa/i.test(e2.message)) {
          log('warn', `Cupo de sesión lleno (13) — reintento… (${intento}/12)`);
          await esperar(50);                 // (en producción: 90 s)
          continue;
        }
        throw e2;
      }
    }
  }
  if (!bot.webLoginData || !bot.webLoginData.data || !bot.webLoginData.data.access_token) {
    throw new Error('No se pudo obtener sesión web tras renovación/login');
  }
}

/* ------------------------------ la prueba --------------------------------- */
(async () => {
  console.log('\n=== PRUEBA: 8 llamadas SIMULTÁNEAS a asegurarSesionWeb() ===');
  console.log('(arranque + renovación 30 s + menudeo 5 min + intervención 30 s + 4 HTTP)\n');

  // 8 disparadores concurrentes, exactamente como en la vida real
  const disparadores = [
    'arranque(setTimeout)', 'renovacion(30s)', 'menudeo(5min)', 'intervencion(30s)',
    'http:/api/state', 'http:/api/web-tasa', 'bot:tick', 'http:/api/web-renew'
  ];
  const t0 = Date.now();
  const resultados = await Promise.allSettled(
    disparadores.map((nombre) => asegurarSesionWeb().then(
      () => ({ nombre, ok: true }),
      (e) => ({ nombre, ok: false, err: e.message })
    ))
  );
  const ms = Date.now() - t0;

  console.log(LOG.join('\n'));
  console.log('\n=== RESULTADO ===');
  console.log(`  autenticaciones REALES iniciadas (authCount) : ${authCount}`);
  console.log(`  llamadas que ESPERARON la misma promesa      : ${authEsperas}`);
  console.log(`  SETS de reintentos (debe ser 1)              : ${contadores.setsReintento}`);
  console.log(`  intentos de login dentro del set             : ${contadores.intentos}`);
  console.log(`  login paso 1 (verificar usuario)             : ${contadores.pasos1}`);
  console.log(`  login paso 2 (enviar clave)                  : ${contadores.pasos2}`);
  console.log(`  logins exitosos                              : ${contadores.loginsOK}`);
  console.log(`  duración total                               : ${ms} ms`);
  console.log(`\n  disparadores resueltos: ${resultados.map(r => r.value.nombre + (r.value.ok ? ' ✔' : ' ✘')).join(', ')}`);

  const exitos = resultados.filter(r => r.value.ok).length;
  const fallos = resultados.filter(r => !r.value.ok);
  console.log(`  sesión obtenida: ${exitos}/8   · errores: ${fallos.length}`);
  if (fallos.length) console.log('  errores: ' + fallos.map(f => f.value.nombre + ': ' + f.value.err).join(' | '));

  // ---- veredicto
  const checks = [
    ['Solo 1 autenticación real (no 4)',      authCount === 1],
    ['UN solo set de reintentos (no 4)',      contadores.setsReintento === 1],
    ['Renovación no se ejecuta sin refresh_token', contadores.renovaciones === 0],
    ['1 login exitoso',                       contadores.loginsOK === 1],
    ['Los 8 disparadores comparten la sesión', exitos === 8],
    ['Ningún login paralelo (paso1 === paso2)', contadores.pasos1 === contadores.pasos2],
  ];
  console.log('\n=== VERIFICACIÓN (1 login · 1 sesión · 1 set de reintentos) ===');
  let todo = true;
  for (const [nombre, ok] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${nombre}`);
    if (!ok) todo = false;
  }
  console.log(`\n${todo ? '🎉 CORRECTO — el bot hace UN SOLO login para toda la ejecución.' : '⚠️  FALLÓ — todavía hay autenticación paralela.'}\n`);
  process.exit(todo ? 0 : 1);
})();
