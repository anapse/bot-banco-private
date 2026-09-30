/* VALIDACIÓN — RASTREO DE LA TASA Y DEL INTERVALO
   Comprueba, con el ciclo real corriendo:
     1) la tasa del payload es VIGENTE (antigüedad pequeña, no minutos)
     2) el log registra el valor EXACTO enviado + su fuente + antigüedad
     3) el intervalo efectivo coincide con la configuración
   NO compra: el banco rechaza (intervención cerrada). */
'use strict';
const fs = require('fs');
const path = require('path');
const API = 'http://127.0.0.1:3721';

const leerLog = () => {
  const f = path.join(__dirname, 'logs', `bot-${new Date().toISOString().slice(0, 10)}.log`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
};

(async () => {
  console.log('\n' + '='.repeat(70));
  console.log(' RASTREO DE LA TASA Y DEL INTERVALO');
  console.log('='.repeat(70));

  const n0 = leerLog().length;
  const st0 = await (await fetch(API + '/api/state')).json();

  console.log('\n[1] CONFIGURACIÓN');
  console.log('    intervalo configurado :', st0.cfg.intervaloMs, 'ms');

  // --- arrancar con 500 ms como el formulario
  console.log('\n[2] Arrancando ciclo (intervalo 500 ms)…');
  await fetch(API + '/api/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      monto: '150', cuentaDebito: st0.cuentas.debito, cuentaDestino: st0.cuentas.destino,
      destinoFondos: st0.cfg.destinoFondos, actividadEconomica: st0.cfg.codigoActividadEconomica,
      intervaloMs: 500
    })
  });
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 6000));
  const st1 = await (await fetch(API + '/api/state')).json();
  const seg = (Date.now() - t0) / 1000;
  await fetch(API + '/api/stop', { method: 'POST' });
  await new Promise((r) => setTimeout(r, 1200));

  console.log('    órdenes en', seg.toFixed(1), 's :', st1.bot.rechazos, '→',
    (st1.bot.rechazos / seg).toFixed(1), 'órdenes/s');

  // --- analizar los intentos
  const compras = leerLog().slice(n0).filter((j) => j.tipo === 'compra');
  console.log('\n[3] RASTREO DE LA TASA EN CADA INTENTO');
  console.log('    intento | tasaEnviada | tasaVigente | fuente        | campoBanco            | edadMs');
  compras.slice(-6).forEach((c) => {
    console.log('    ' + String(c.intento).padStart(6), '|',
      String(c.tasaEnviada).padEnd(11), '|',
      String(c.tasaVigente).padEnd(11), '|',
      String(c.fuenteTasa).padEnd(13), '|',
      String(c.campoTasaBanco || '-').padEnd(21), '|',
      c.edadTasaMs);
  });

  const edades = compras.map((c) => c.edadTasaMs).filter((x) => typeof x === 'number');
  const edadMax = edades.length ? Math.max(...edades) : null;
  const edadMed = edades.length ? Math.round(edades.reduce((a, b) => a + b, 0) / edades.length) : null;
  console.log(`\n    antigüedad de la tasa usada → máx ${edadMax} ms · media ${edadMed} ms`);
  console.log('    (antes: hasta 300000 ms = 5 min)');

  // --- coherencia payload ↔ registrado
  const coherente = compras.every((c) => c.tasaEnviada === (c.solicitud && c.solicitud.tasaCambio));
  const conFuente = compras.every((c) => !!c.fuenteTasa);
  const conEdad = edades.length === compras.length && compras.length > 0;
  const fresca = edadMax != null && edadMax < 5000;

  const checks = [
    ['El log registra la tasa EXACTA enviada',      compras.length > 0 && compras.every((c) => 'tasaEnviada' in c)],
    ['tasaEnviada == valor del payload enviado',    coherente],
    ['Se registra la FUENTE de la tasa',            conFuente],
    ['Se registra la ANTIGÜEDAD del dato',          conEdad],
    ['La tasa es VIGENTE (< 5 s, no minutos)',      fresca],
    ['El intervalo efectivo ≈ configuración',       Math.abs(st1.bot.rechazos / seg - 1000 / 500) < 1.5],
  ];

  console.log('\n[4] VERIFICACIÓN');
  let ok = 0;
  for (const [n, v] of checks) { console.log(`    ${v ? '✅' : '❌'} ${n}`); v && ok++; }
  console.log(`\n    ${ok}/${checks.length} OK`);
  console.log('='.repeat(70) + '\n');
  process.exit(ok === checks.length ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
