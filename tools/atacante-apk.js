/**
 * atacante-apk.js — Ataca la compra REAL por la API del APK.
 *
 * ============================================================
 * HALLAZGOS DE LA INVESTIGACIÓN (24-09-2026)
 * ============================================================
 *
 * POR QUÉ EL BOT NUNCA COMPRABA
 * ----------------------------
 * El bot consultaba el PORTAL (bdvenlinea) por
 *   /altaintervencioncambiaria/consultarReglasEXRI
 * y ese canal responde SIEMPRE code=01 / 1001 / HTTP 500 sin motivo.
 * Nunca refleja la apertura real de la subasta. Por eso el bot vivía
 * diciendo "cerrado" aunque estuviera abierto.
 *
 * LA API DEL APK ES OTRA
 * ----------------------
 * El APK usa  bdvdigital.banvenez.com  con rutas  bdvx-* :
 *
 *   /bdvx-intervencion-cambiaria/v1/intervencion/consultarReglasEXRI   -> 404 (esa ruta no existe aquí)
 *   /bdvx-operaciones-cambiarias/v1/operaciones/consultar/actividades  -> 1000 "Consulta exitosa"
 *   /bdvx-operaciones-cambiarias/v1/operaciones/consultar/reglas       -> pide 'tipoRegla'
 *   /bdvx-operaciones-cambiarias/v1/operaciones/consultar/reglas/compra-> 1003 = subasta cerrada
 *   /bdvx-operaciones-cambiarias/v1/operaciones/comprar                -> 1003 = subasta cerrada
 *   /bdvx-operaciones-cambiarias/v1/operaciones/confirmar              -> confirmación
 *
 * TABLA DE CÓDIGOS OBSERVADA
 * --------------------------
 *   1000 → operación OK / disponible
 *   1003 → "Las operaciones cambiarias estarán disponibles más tarde"
 *   1001 → datos de entrada inválidos
 *   4000 → servicio no disponible
 *   5000 → error inesperado
 *
 * IMPORTANTE: los endpoints bdvx-* NO validan el token (con un token
 * basura devuelven lo mismo). Es decir, el 1003 es el ESTADO REAL de la
 * subasta, no un rechazo de autenticación. Por eso este atacante puede
 * sondear sin depender del login.
 *
 * OJO CON EL WAF: las peticiones GET a algunas rutas devuelven
 * "Request Rejected" (WAF F5). Las POST pasan. Por eso todo va por POST.
 *
 * USO
 * ---
 *   node tools/atacante-apk.js              → solo sondea
 *   node tools/atacante-apk.js --comprar    → sondea y COMPRA al abrir
 *
 * La evidencia se guarda en logs/ataque-apk.jsonl (una línea JSON por
 * llamada: endpoint, payload, httpStatus y respuesta) para poder
 * reconstruir el flujo exacto si la compra llega a realizarse.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const LOG_TXT = path.join(RAIZ, 'logs', 'ataque-apk.log');
const LOG_JSONL = path.join(RAIZ, 'logs', 'ataque-apk.jsonl');

const BASE = 'https://bdvdigital.banvenez.com';
const EP = {
  actividades: `${BASE}/bdvx-operaciones-cambiarias/v1/operaciones/consultar/actividades`,
  reglas: `${BASE}/bdvx-operaciones-cambiarias/v1/operaciones/consultar/reglas`,
  reglasCompra: `${BASE}/bdvx-operaciones-cambiarias/v1/operaciones/consultar/reglas/compra`,
  comprar: `${BASE}/bdvx-operaciones-cambiarias/v1/operaciones/comprar`,
  confirmar: `${BASE}/bdvx-operaciones-cambiarias/v1/operaciones/confirmar`,
};

const COMPRAR = process.argv.includes('--comprar');
const INTERVALO_MS = Number(process.env.INTERVALO_MS || 250);
const HILOS = Math.max(1, Number(process.env.HILOS || 3));

/* ---------- Config y token ---------- */
function leerConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.json'), 'utf8'));
  return {
    monto: String(cfg.montoMaxUSD ?? 10),
    cuentaOrigenBs: cfg.cuentaDebito,
    cuentaDestino: cfg.cuentaDestino,
    codigoActividadEconomica: String(cfg.codigoActividadEconomica ?? '22'),
    destinoFondos: String(cfg.destinoFondos ?? '11'),
    codigoRegla: 'RGLIC',
  };
}

function leerToken() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(RAIZ, 'web-session.json'), 'utf8'));
    return s.data.data.access_token;
  } catch (_) {
    return null;
  }
}

/* ---------- Logs ---------- */
function log(nivel, msg) {
  const linea = `[${new Date().toISOString()}] [${nivel}] ${msg}`;
  console.log(linea);
  try {
    fs.mkdirSync(path.dirname(LOG_TXT), { recursive: true });
    fs.appendFileSync(LOG_TXT, linea + '\n');
  } catch (_) { /* seguir */ }
}

function evidenciar(tipo, ruta, payload, httpStatus, respuesta) {
  try {
    fs.appendFileSync(LOG_JSONL, JSON.stringify({
      ts: new Date().toISOString(),
      tipo,
      endpoint: ruta,
      metodo: 'POST',
      solicitud: payload,
      httpStatus,
      respuesta,
    }) + '\n');
  } catch (_) { /* seguir */ }
}

/* ---------- Llamada ---------- */
let TOKEN = null;

async function llamar(ruta, payload, etiqueta) {
  const enc = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'okhttp/4.12.0',
  };
  if (TOKEN) enc.Authorization = `Bearer ${TOKEN}`;

  try {
    const res = await fetch(ruta, {
      method: 'POST',
      headers: enc,
      body: JSON.stringify(payload ?? {}),
    });
    const texto = await res.text();

    if (texto.includes('Request Rejected')) {
      evidenciar(etiqueta, ruta, payload, res.status, 'WAF');
      return { code: 'WAF', status: res.status, message: 'bloqueado por WAF' };
    }

    let json = null;
    try { json = JSON.parse(texto); } catch (_) { /* no json */ }

    evidenciar(etiqueta, ruta, payload, res.status, json ?? texto.slice(0, 400));

    return {
      status: res.status,
      code: json && json.code != null ? String(json.code) : null,
      message: json ? json.message : null,
      data: json ? json.data : null,
    };
  } catch (e) {
    evidenciar(etiqueta, ruta, payload, null, 'ERROR ' + e.message);
    return { code: 'ERR', status: null, message: e.message };
  }
}

/* ---------- Bucle ---------- */
async function main() {
  TOKEN = leerToken();
  const cfg = leerConfig();

  log('info', '=====================================================');
  log('info', ' ATACANTE APK — ' + (COMPRAR ? 'MODO COMPRA COMPLETA' : 'MODO SONDA'));
  log('info', '=====================================================');
  log('info', `  endpoint  : ${EP.comprar}`);
  log('info', `  monto     : ${cfg.monto} USD`);
  log('info', `  origen    : …${String(cfg.cuentaOrigenBs).slice(-4)}`);
  log('info', `  destino   : …${String(cfg.cuentaDestino).slice(-4)}`);
  log('info', `  regla     : ${cfg.codigoRegla}`);
  log('info', `  intervalo : ${INTERVALO_MS} ms`);
  log('info', `  token     : ${TOKEN ? TOKEN.slice(0, 16) + '…' : '(sin token)'}`);
  log('info', '-----------------------------------------------------');

  const payload = {
    cuentaOrigenBs: cfg.cuentaOrigenBs,
    cuentaDestino: cfg.cuentaDestino,
    monto: cfg.monto,
    codigoRegla: cfg.codigoRegla,
    codigoActividadEconomica: cfg.codigoActividadEconomica,
    destinoFondos: cfg.destinoFondos,
  };

  let n = 0;
  let ultimo = null;

  for (;;) {
    n += 1;

    // 1) ¿Está disponible la compra? (1003 = cerrada)
    const est = await llamar(EP.reglasCompra, {}, 'consulta-estado');

    if (est.code !== ultimo) {
      log('info', `[${n}] CAMBIO → code=${est.code} · ${est.message ?? ''}`);
      ultimo = est.code;
    } else if (n % 60 === 0) {
      log('info', `[${n}] sigue: code=${est.code}`);
    }

    // 2) Si está disponible, comprar YA — VARIOS DISPAROS EN PARALELO
    //    (la subasta se agota en segundos: hay que ir a por todas).
    const disponible = est.code === '1000';

    if (disponible || (COMPRAR && n % 3 === 0)) {
      const etiqueta = disponible ? 'COMPRA' : 'disparo-ciego';

      if (disponible) {
        log('info', `[${n}] 🎯 ABIERTO (1000) — DISPARANDO ${HILOS} COMPRAS EN PARALELO`);
      }

      const intentos = disponible
        ? await Promise.all(
            Array.from({ length: HILOS }, (_, i) => llamar(EP.comprar, payload, `compra-h${i}`))
          )
        : [await llamar(EP.comprar, payload, etiqueta)];

      let r = intentos[0];
      let acepto = false;

      for (const it of intentos) {
        if (disponible) {
          log('info', `    → http=${it.status} code=${it.code} msg=${it.message ?? ''} ${it.ms ?? '?'}ms`);
        }

        const ok =
          it.code === '1000' ||
          (it.status === 200 && it.data &&
            (it.data.idOperacion || it.data.numeroOperacion || it.data.referencia));

        if (ok) { acepto = true; r = it; break; }
      }

      if (!disponible && n % 60 === 0) {
        log('info', `[${n}] disparo ciego → code=${r.code}`);
      }

      if (acepto) {
        log('info', '#####################################################');
        log('info', '#  🎉🎉  COMPRA ACEPTADA  🎉🎉');
        log('info', '#####################################################');
        log('info', `  code    : ${r.code}`);
        log('info', `  message : ${r.message}`);
        log('info', `  data    : ${JSON.stringify(r.data)}`);
        log('info', `  payload : ${JSON.stringify(payload)}`);

        // Confirmar, como hace el APK
        const idOper = r.data && (r.data.idOperacion || r.data.id || r.data.numeroOperacion);
        const conf = await llamar(
          EP.confirmar,
          idOper ? { ...payload, operacionId: idOper } : payload,
          'confirmar'
        );
        log('info', `  CONFIRMACION → http=${conf.status} code=${conf.code} msg=${conf.message ?? ''}`);
        log('info', `  data conf   : ${JSON.stringify(conf.data)}`);
        log('info', '#####################################################');
        break;
      }
    }

    await new Promise((s) => setTimeout(s, INTERVALO_MS));
  }
}

main().catch((e) => {
  log('error', `Fallo fatal: ${e.message}`);
  process.exit(1);
});
