/* ============================================================================
 * RECORRIDO REAL DEL FLUJO APK — sin comprar
 * ----------------------------------------------------------------------------
 * Hace una peticion REAL a cada endpoint del flujo de la APK y registra
 * exactamente que responde el servidor. NO llama a /comprar ni a /confirmar.
 *
 * Determina que parte del flujo funciona hoy y cual queda bloqueada, y por que
 * (autenticacion / header / ruta / payload / ventana cerrada).
 * ========================================================================== */
'use strict';
const CLIENT = require('./client');
const INV = require('./intervention');
const OPS = require('./operations');
const LOG = require('./logging');
const { RUTAS } = require('./rutas');

const L = '='.repeat(78);

// Nombre legible por endpoint
const ETAPAS = [
  { fase: 'LOGIN',           ruta: RUTAS.oauthToken,        metodo: 'POST', auth: false,
    desc: 'OAuth2 token (grant_type=password)' },
  { fase: 'SALDO',           ruta: RUTAS.saldoV2,           metodo: 'GET',  auth: true,
    desc: 'saldo-v2 de la cuenta' },
  { fase: 'CLIENTE',         ruta: RUTAS.cliente,           metodo: 'GET',  auth: true,
    desc: 'datos del cliente' },
  { fase: 'REGLAS',          ruta: RUTAS.consultarReglas,   metodo: 'GET',  auth: true,
    desc: 'reglas generales de operaciones' },
  { fase: 'REGLAS COMPRA',   ruta: RUTAS.reglasCompra,      metodo: 'GET',  auth: true,
    desc: 'reglas aplicables a COMPRA' },
  { fase: 'ACTIVIDADES',     ruta: RUTAS.actividades,       metodo: 'GET',  auth: true,
    desc: 'actividades economicas' },
  { fase: 'ESTADOS',         ruta: RUTAS.estados,           metodo: 'GET',  auth: true,
    desc: 'estados de operacion' },
  { fase: 'OFICINAS',        ruta: RUTAS.oficinas,          metodo: 'GET',  auth: true,
    desc: 'oficinas' },
  { fase: 'INTERVENCION_INIT', ruta: RUTAS.intervencionInit, metodo: 'POST', auth: true,
    desc: 'init de intervencion cambiaria' },
  { fase: 'EXRI',            ruta: RUTAS.consultarReglasEXRI, metodo: 'POST', auth: true,
    desc: 'reglas EXRI (disponibilidad intervencion)' },
  { fase: 'MERCADO',         ruta: RUTAS.mercado,           metodo: 'GET',  auth: true,
    desc: 'mercado menudeo' },
];

/** Diagnostica la causa de un fallo a partir de la respuesta real. */
function diagnosticarCausa(r) {
  const t = JSON.stringify(r.json ?? r.texto ?? '').toLowerCase();
  if (r.error && /timeout|aborted/i.test(r.error)) return 'TIMEOUT (red/servidor lento)';
  if (r.http === 401) {
    if (t.includes('full authentication')) return 'AUTENTICACION — falta token/app-key completo';
    return 'AUTENTICACION — no autorizado (token invalido o ausente)';
  }
  if (r.http === 403) return 'AUTORIZACION — token valido pero sin permiso';
  if (r.http === 404) return 'RUTA — no enruta (sin credenciales validas el gateway no expone)';
  if (r.http === 500) return 'SERVIDOR — error interno (posible servicio fuera de ventana)';
  if (r.http === 400) return 'PETICION — payload/parametros rechazados';
  if (r.http === 409) return 'CONFLICTO — estado no permite la operacion';
  if (r.http === 200) return 'OK';
  return `HTTP ${r.http ?? '-'}`;
}

/** Extrae los campos recibidos, de forma util. */
function campos(j) {
  if (j == null) return '(sin cuerpo)';
  if (Array.isArray(j)) {
    return `array[${j.length}]` + (j[0] && typeof j[0] === 'object'
      ? ` · claves: ${Object.keys(j[0]).slice(0, 12).join(', ')}` : '');
  }
  if (typeof j === 'object') {
    const k = Object.keys(j);
    return `objeto · claves: ${k.slice(0, 14).join(', ')}${k.length > 14 ? ` …(+${k.length - 14})` : ''}`;
  }
  return String(j).slice(0, 120);
}

const code = (j) => (j && typeof j === 'object' && !Array.isArray(j))
  ? (j.code ?? j.codigo ?? j.status ?? null)
  : (Array.isArray(j) && j[0] ? (j[0].code ?? j[0].codigo ?? null) : null);

const mensaje = (j) => {
  if (!j) return null;
  if (Array.isArray(j)) j = j[0] || {};
  return j.message ?? j.description ?? j.descripcion ?? j.error_description ?? null;
};

(async () => {
  console.log('\n' + L);
  console.log('   RECORRIDO REAL DEL FLUJO APK — SIN COMPRAR');
  console.log(L);
  const ak = CLIENT.appKey();
  console.log(`  HOST    : ${CLIENT.HOST}`);
  console.log(`  app-key : ${ak ? `presente («OCULTO:${ak.length}»)` : '⚠️  NO CONFIGURADA'}`);
  console.log(`  tokens  : ${CLIENT.leerEnv().BDV_ACCESS_TOKEN ? '.env con BDV_ACCESS_TOKEN' : 'sin token en .env'}`);
  console.log(L);

  const filas = [];

  // ---- 0. LOGIN (se hace aparte para poder reportarlo) ----
  const AUTH = require('./auth');
  const tok0 = AUTH.precargarTokens();
  const ses = tok0 ? { ok: CLIENT.sesionValida(), reutilizada: true } : await AUTH.login();

  let rLogin;
  if (tok0 && CLIENT.sesionValida()) {
    rLogin = { http: null, json: { nota: 'token reutilizado del .env (sin login nuevo)' } };
  } else {
    // ya se intento en AUTH.login; reflejar su resultado
    const c = AUTH.credenciales();
    const query = `grant_type=password&username=${encodeURIComponent(c.usuario || '')}&password=«OCULTO»`;
    rLogin = await CLIENT.pedir(RUTAS.oauthToken, {
      fase: 'LOGIN', metodo: 'POST', query, body: {}, requiereAuth: false,
    });
  }
  filas.push({
    etapa: 'Login', endpoint: RUTAS.oauthToken, metodo: 'POST',
    http: rLogin.http, code: code(rLogin.json), resultado: diagnosticarCausa(rLogin),
  });

  const haySesion = CLIENT.sesionValida();

  // ---- 1..N. recorrido (omitir LOGIN que ya está arriba) ----
  for (const e of ETAPAS) {
    if (e.fase === 'LOGIN') continue;

    process.stdout.write(`  → ${e.fase.padEnd(18)} `);
    const r = await CLIENT.pedir(e.ruta, {
      fase: e.fase, metodo: e.metodo,
      body: e.metodo === 'POST' ? {} : undefined,
      requiereAuth: e.auth,
    });
    const causa = diagnosticarCausa(r);
    const c = code(r.json);
    const m = mensaje(r.json);

    console.log(`HTTP ${String(r.http ?? '-').padEnd(4)} code=${String(c ?? '-').padEnd(5)} ${causa}`);

    filas.push({
      etapa: e.fase, endpoint: e.ruta, metodo: e.metodo,
      http: r.http, code: c, mensaje: m, resultado: causa,
      campos: campos(r.json), json: r.json, texto: r.texto,
    });
  }

  // ---- NO se llama comprar ni confirmar ----
  console.log('\n  ⏹  /comprar y /confirmar NO ejecutados (ventana cerrada).');

  // ---- TABLA RESUMEN ----
  console.log('\n' + L);
  console.log('  TABLA — ESTADO REAL DE CADA ETAPA DEL FLUJO APK');
  console.log(L);
  console.log('  ' + 'Etapa'.padEnd(18) + 'HTTP'.padEnd(6) + 'Código'.padEnd(8) + 'Resultado');
  console.log('  ' + '─'.repeat(74));
  for (const f of filas) {
    console.log('  ' + String(f.etapa).padEnd(18)
      + String(f.http ?? '-').padEnd(6)
      + String(f.code ?? '-').padEnd(8)
      + f.resultado);
  }
  console.log(L);

  // ---- detalle de campos por etapa ----
  console.log('\n  DETALLE DE CAMPOS RECIBIDOS');
  console.log('  ' + '─'.repeat(74));
  for (const f of filas) {
    console.log(`\n  ▸ ${f.etapa}  [${f.metodo} ${f.endpoint}]`);
    console.log(`      HTTP ${f.http ?? '-'}   code=${f.code ?? '-'}`);
    if (f.mensaje) console.log(`      mensaje: ${String(f.mensaje).slice(0, 150)}`);
    if (f.campos) console.log(`      campos : ${f.campos}`);
    if (f.json && f.http !== 200) {
      console.log(`      respuesta: ${JSON.stringify(f.json).slice(0, 220)}`);
    }
  }
  console.log('\n' + L);

  // ---- guardar informe ----
  LOG.etapa({
    fase: 'RECORRIDO', endpoint: '(todos)', metodo: 'VARIOS', http: null,
    estado: 'COMPLETADO', notas: 'recorrido sin compra',
    respuesta: filas.map((f) => ({
      etapa: f.etapa, endpoint: f.endpoint, metodo: f.metodo,
      http: f.http, code: f.code, resultado: f.resultado,
    })),
  });

  const oks = filas.filter((f) => f.http === 200).length;
  console.log(`  ETAPAS CON HTTP 200: ${oks} de ${filas.length}`);
  console.log(L + '\n');
  process.exit(0);
})().catch((e) => {
  console.error('ERROR FATAL:', e.message);
  process.exit(1);
});
