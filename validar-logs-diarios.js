/* VERIFICACIÓN DEL SISTEMA DE LOGS DIARIOS
   Comprueba:
     1. la carpeta logs/ existe
     2. se crea el archivo del día
     3. los eventos se agregan al archivo CORRECTO
     4. el cambio de fecha usa OTRO archivo (no mezcla días)
     5. no se sobrescribe ni se borra lo anterior
     6. se conserva el contenido completo del banco
     7. los logs previos quedan INTACTOS
     8. sin credenciales en el log
   La prueba de rotación usa un directorio temporal: NO toca los logs reales.
*/
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROY = __dirname;
const LOGS = path.join(PROY, 'logs');
const API = 'http://127.0.0.1:3721';

// extraer la función real del logger desde server.js (sin arrancar el servidor)
const src = fs.readFileSync(path.join(PROY, 'server.js'), 'utf8');
const fnSrc = src.match(/function rutaLogDiario\(fecha\) \{[\s\S]*?\n\}/)[0];

let ok = 0, total = 0;
const add = (n, v) => { total++; if (v) ok++; console.log(`    ${v ? '✅' : '❌'} ${n}`); };

(async () => {
  console.log('\n' + '='.repeat(68));
  console.log(' VERIFICACIÓN — LOGS DIARIOS (un archivo por día en logs/)');
  console.log('='.repeat(68));

  // ---------- 1. carpeta logs/
  console.log('\n[1] CARPETA');
  const existeLogs = fs.existsSync(LOGS) && fs.statSync(LOGS).isDirectory();
  console.log('    ruta:', LOGS);
  add('La carpeta logs/ existe', existeLogs);

  // ---------- 2. archivo del día
  const hoy = new Date().toISOString().slice(0, 10);
  const archivoHoy = path.join(LOGS, `bot-${hoy}.log`);
  console.log('\n[2] ARCHIVO DEL DÍA');
  console.log('    esperado:', `logs/bot-${hoy}.log`);
  add(`Se creó logs/bot-${hoy}.log`, fs.existsSync(archivoHoy));

  // ---------- 3. generación del nombre
  console.log('\n[3] GENERACIÓN AUTOMÁTICA DEL NOMBRE');
  const mockLogs = path.join(os.tmpdir(), 'bdv_logs_test');
  const rutaLogDiario = new Function('LOGS_DIR', 'nowIso', 'path',
    fnSrc + '\nreturn rutaLogDiario;')(mockLogs, () => new Date().toISOString(), path);
  const r1 = rutaLogDiario('2026-09-20T10:00:00.000Z');
  const r2 = rutaLogDiario('2026-09-21T10:00:00.000Z');
  const r3 = rutaLogDiario('2026-09-22T10:00:00.000Z');
  console.log('    2026-09-20 →', path.basename(r1));
  console.log('    2026-09-21 →', path.basename(r2));
  console.log('    2026-09-22 →', path.basename(r3));
  add('El nombre se genera con la fecha de escritura',
    path.basename(r1) === 'bot-2026-09-20.log' &&
    path.basename(r2) === 'bot-2026-09-21.log' &&
    path.basename(r3) === 'bot-2026-09-22.log');
  add('Cada día apunta a un archivo DISTINTO', r1 !== r2 && r2 !== r3 && r1 !== r3);
  add('Todos dentro de logs/', [r1, r2, r3].every((r) => r.startsWith(mockLogs)));

  // ---------- 4. crear / agregar / rotar (directorio temporal)
  console.log('\n[4] PRUEBA REAL DE ROTACIÓN (temporal: no toca los logs reales)');
  fs.rmSync(mockLogs, { recursive: true, force: true });
  const escribir = (fecha, texto) => {
    const ruta = rutaLogDiario(fecha);
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.appendFileSync(ruta, texto + '\n');
    return ruta;
  };
  escribir('2026-09-21T08:00:00Z', '[2026-09-21T08:00:00Z] [info] evento 1 del día 21');
  escribir('2026-09-21T09:00:00Z', '[2026-09-21T09:00:00Z] [info] evento 2 del día 21');
  escribir('2026-09-22T08:00:00Z', '[2026-09-22T08:00:00Z] [info] evento del día 22');

  const p21 = path.join(mockLogs, 'bot-2026-09-21.log');
  const p22 = path.join(mockLogs, 'bot-2026-09-22.log');
  const c21 = fs.readFileSync(p21, 'utf8').trim().split('\n');
  const c22 = fs.readFileSync(p22, 'utf8').trim().split('\n');
  console.log('    bot-2026-09-21.log →', c21.length, 'línea(s)');
  console.log('    bot-2026-09-22.log →', c22.length, 'línea(s)');

  add('Si el archivo del día no existe, se CREA', fs.existsSync(p22));
  add('Si ya existe, se AGREGA al mismo archivo', c21.length === 2);
  add('El día 22 NO escribe en el archivo del 21',
    c21.every((l) => l.includes('día 21')) && c22.every((l) => !l.includes('día 21')));
  add('Nunca se sobrescribe: los eventos previos siguen ahí',
    c21[0].includes('evento 1') && c21[1].includes('evento 2'));
  fs.rmSync(mockLogs, { recursive: true, force: true });

  // ---------- 5. eventos reales del logger
  console.log('\n[5] EVENTOS REALES DEL LOGGER (prueba en vivo)');
  const leer = () => fs.readFileSync(archivoHoy, 'utf8').split('\n').filter(Boolean);
  const nAntes = leer().length;
  let generados = false;
  try {
    const st = await (await fetch(API + '/api/state')).json();
    await fetch(API + '/api/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monto: '150', cuentaDebito: st.cuentas.debito, cuentaDestino: st.cuentas.destino,
        destinoFondos: st.cfg.destinoFondos, actividadEconomica: st.cfg.codigoActividadEconomica,
        intervaloMs: 500
      })
    });
    await new Promise((r) => setTimeout(r, 5000));
    await fetch(API + '/api/stop', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 1200));
    generados = true;
  } catch (e) {
    console.log('    (no se pudo probar en vivo:', e.message + ')');
  }
  const lineas = leer();
  const nuevos = lineas.slice(nAntes);
  const nuevasTexto = nuevos.filter((l) => l.startsWith('['));
  const nuevosJson = nuevos.filter((l) => l.startsWith('{'));
  console.log('    líneas nuevas  :', nuevos.length, `(texto ${nuevasTexto.length} · JSON ${nuevosJson.length})`);
  if (nuevasTexto[0]) console.log('    ejemplo texto  :', nuevasTexto[0].slice(0, 88));
  if (nuevosJson[0]) console.log('    ejemplo JSON   :', nuevosJson[0].slice(0, 88));
  add('Los eventos nuevos se agregaron al archivo del DÍA', generados && nuevos.length > 0);
  add('Se escriben los dos tipos de línea (texto + JSON)',
    nuevasTexto.length > 0 && nuevosJson.length > 0);

  // ---------- 6. contenido y seguridad
  console.log('\n[6] CONTENIDO Y SEGURIDAD');
  const real = leer();
  const json = real.filter((l) => l.startsWith('{'));
  const parseables = json.filter((l) => { try { JSON.parse(l); return true; } catch (_) { return false; } });
  console.log('    líneas totales   :', real.length);
  console.log('    registros JSON   :', json.length, `(${parseables.length} parseables)`);
  console.log('    líneas de texto  :', real.filter((l) => l.startsWith('[')).length);
  const conRespuesta = parseables.filter((l) => JSON.parse(l).respuestaCompleta !== undefined).length;
  console.log('    con respuestaCompleta del banco:', conRespuesta);
  add('Se conserva el contenido completo del banco', conRespuesta > 0);
  add('Todos los registros JSON son válidos', parseables.length === json.length);

  // --- seguridad ---
  const crudo = real.join('\n');
  // Credenciales GRAVES: no deben aparecer nunca
  const graves = ['Bearer ', 'access_token=', 'refresh_token=', 'password',
    'Authorization:', '01020414330000654951', '01020414370001045242', '26870048']
    .filter((p) => crudo.includes(p));
  add('Sin credenciales ni datos sensibles', graves.length === 0);
  if (graves.length) console.log('      FUGA:', graves.join(', '));

  // JWT: el banco abrevia el token en sus mensajes ("Invalid refresh token: eyJhbG...Ba1h").
  // Se comprueba que no haya NINGÚN JWT COMPLETO ni token usable en claro.
  const jwtsCompletos = (crudo.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || []).length;
  const flags = (crudo.match(/eyJ[A-Za-z0-9._-]*/g) || []).length;
  console.log('    JWT completos en el log :', jwtsCompletos);
  console.log('    restos "eyJ" (fragmentos del banco):', flags);
  add('Ningún JWT completo ni token usable en claro', jwtsCompletos === 0);

  // Las líneas NUEVAS (tras la corrección) no deben traer ni el fragmento
  const eyJEnNuevas = nuevos.filter((l) => l.includes('eyJ')).length;
  add('Las líneas nuevas ya no traen restos de token', eyJEnNuevas === 0);
  if (eyJEnNuevas) console.log('      nuevas con eyJ:', eyJEnNuevas);

  // ---------- 7. logs previos
  console.log('\n[7] LOGS ANTERIORES');
  const previos = ['bot-2026-09-18.log', 'bot-2026-09-19.log', 'bot-escritorio-2026-08-31.log'];
  let intactos = true;
  for (const f of previos) {
    const p = path.join(LOGS, f);
    const okp = fs.existsSync(p) && fs.statSync(p).size > 0;
    console.log(`    ${f.padEnd(32)} ${okp ? 'intacto ✅' : 'FALTA ❌'} (${okp ? fs.statSync(p).size : 0} bytes)`);
    if (!okp) intactos = false;
  }
  add('Los logs anteriores siguen intactos (no se borran)', intactos);

  console.log('\n' + '='.repeat(68));
  console.log(` ${ok}/${total} comprobaciones OK`);
  console.log('='.repeat(68) + '\n');
  process.exit(ok === total ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
