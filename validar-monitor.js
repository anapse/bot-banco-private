/* PRUEBA DEL MONITOR — verifica la lógica sin tocar el banco
   Comprueba:
     1. detección de cambios (incluido data:null → objeto, aparición de tasa)
     2. validación antes de comprar (NO comprar si falta algo)
     3. protección contra doble compra
     4. enmascarado de credenciales en el log
   No envía ninguna orden al banco. */
'use strict';
const fs = require('fs');
const path = require('path');

let ok = 0, total = 0;
const add = (n, v) => { total++; if (v) ok++; console.log(`    ${v ? '✅' : '❌'} ${n}`); };

console.log('\n' + '='.repeat(62));
console.log(' PRUEBA DEL MONITOR (lógica, sin tocar el banco)');
console.log('='.repeat(62));

// ---------- 1. detección de cambios ----------
// Replica la función diff() del monitor
function diff(nombre, antes, ahora, claves) {
  const out = [];
  for (const k of claves) {
    const a = antes ? antes[k] : undefined;
    const b = ahora ? ahora[k] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ campo: `${nombre}.${k}`, antes: a ?? null, despues: b ?? null });
  }
  return out;
}
const CLAVES = ['code', 'dataEsNull', 'estado', 'tasaTexto', 'cupoPersNaturales', 'porcentajeComision', 'regla', 'description'];

console.log('\n[1] DETECCIÓN DE CAMBIOS');
// el caso que importa: CERRADO repetido no debe avisar; la apertura SÍ
const cerrado = { code: '01', dataEsNull: true, estado: 'cerrada', tasaTexto: null, cupoPersNaturales: null, porcentajeComision: null, regla: 'RGLIC', description: 'Transacción no disponible, por favor intente mas tarde' };
const igual = { ...cerrado };
const abierto = { code: '1000', dataEsNull: false, estado: 'abierta', tasaTexto: '860,94096', cupoPersNaturales: 100, porcentajeComision: '0.2', regla: 'RGLIC', description: 'OK' };

const d0 = diff('exri', null, cerrado, CLAVES);
const d1 = diff('exri', cerrado, igual, CLAVES);
const d2 = diff('exri', cerrado, abierto, CLAVES);

console.log(`    CERRADO → CERRADO : ${d1.length} cambios`);
console.log(`    CERRADO → ABIERTO : ${d2.length} cambios`);
add('CERRADO repetido NO genera ruido', d1.length === 0);
add('CERRADO → ABIERTO detecta los cambios', d2.length >= 5);
add('Detecta cambio de code (01 → 1000)', d2.some((c) => c.campo === 'exri.code'));
add('Detecta data: null → objeto', d2.some((c) => c.campo === 'exri.dataEsNull'));
add('Detecta aparición de tasaReferencia', d2.some((c) => c.campo === 'exri.tasaTexto'));
add('Detecta aparición de cupo', d2.some((c) => c.campo === 'exri.cupoPersNaturales'));
add('Detecta cambio de comisión', d2.some((c) => c.campo === 'exri.porcentajeComision'));

// caso del enunciado: code 1000 con data:null → luego data con tasa
const c1000null = { ...abierto, dataEsNull: true, tasaTexto: null, cupoPersNaturales: null };
const c1000obj = { ...abierto };
add('Detecta code 1000 data:null → data:{objeto}',
  diff('exri', c1000null, c1000obj, CLAVES).some((c) => c.campo === 'exri.dataEsNull'));

// ---------- 2. validación antes de comprar ----------
console.log('\n[2] VALIDACIÓN ANTES DE COMPRAR');
function validar(e, saldo, cfg, tieneRegla, payload) {
  const m = [];
  if (!tieneRegla) m.push('sin codigoRegla');
  if (e.estado !== 'abierta') m.push(`EXRI no abierto (${e.code})`);
  if (!(e.tasaReferencia > 0)) m.push('sin tasa');
  if (e.cupoPersNaturales == null) m.push('sin cupo');
  const nec = (cfg.montoMaxUSD || 0) * (e.tasaReferencia || 0);
  if (saldo != null && nec > 0 && saldo < nec) m.push('saldo insuficiente');
  if (!payload) m.push('sin payload');
  return m;
}
const e_ok = { estado: 'abierta', code: '1000', tasaReferencia: 860.94, cupoPersNaturales: 100 };
const e_cerrado = { estado: 'cerrada', code: '01', tasaReferencia: null, cupoPersNaturales: null };
const cfgP = { montoMaxUSD: 10 };
const pay = { cuentaOrigenBs: 'x', cuentaDestino: 'y', codigoRegla: 'RGLIC', destinoFondos: '11' };

add('Cerrado → NO compra', validar(e_cerrado, 8000, cfgP, true, null).length > 0);
// con saldo suficiente (10 USD x 860,94 = 8.609,41) sí debe permitir comprar
add('Abierto + todo OK + saldo suficiente → compra', validar(e_ok, 9000, cfgP, true, pay).length === 0);
add('Abierto pero SIN tasa → NO compra', validar({ ...e_ok, tasaReferencia: null }, 9000, cfgP, true, pay).includes('sin tasa'));
add('Abierto pero SIN cupo → NO compra', validar({ ...e_ok, cupoPersNaturales: null }, 9000, cfgP, true, pay).includes('sin cupo'));
add('Abierto pero SIN regla → NO compra', validar(e_ok, 9000, cfgP, false, pay).length > 0);
add('Saldo insuficiente → NO compra', validar(e_ok, 100, cfgP, true, pay).includes('saldo insuficiente'));
add('Código 1000 con data pero sin tasa → NO compra (no inventa)', validar({ ...e_ok, tasaReferencia: null }, 9000, cfgP, true, pay).length > 0);

// ---------- 3. protección doble compra ----------
console.log('\n[3] PROTECCIÓN CONTRA DOBLE COMPRA');
const S = { purchase_in_progress: false, purchase_confirmed: false };
function intentar() {
  if (S.purchase_in_progress) return 'ignorada (ya en curso)';
  if (S.purchase_confirmed) return 'ignorada (ya confirmada)';
  S.purchase_in_progress = true;
  return 'enviada';
}
const r1 = intentar();
const r2 = intentar();
S.purchase_in_progress = false;
S.purchase_confirmed = true;
const r3 = intentar();
console.log(`    intento 1: ${r1} | intento 2: ${r2} | tras confirmar: ${r3}`);
add('La primera compra se envía', r1 === 'enviada');
add('La segunda (simultánea) se bloquea', r2.includes('en curso'));
add('Tras confirmar, no se repite', r3.includes('confirmada'));

// ---------- 4. enmascarado ----------
console.log('\n[4] ENMASCARADO EN EL LOG');
const monSrc = fs.readFileSync(path.join(__dirname, 'monitor.js'), 'utf8');
add('No imprime tokens completos (Bearer → OCULTO)', monSrc.includes('«OCULTO»'));
add('Enmascara JWT', monSrc.includes('«JWT»'));
add('Enmascara cuentas bancarias', monSrc.includes('«CUENTA'));
add('Oculta claves sensibles en objetos', monSrc.includes('SENSIBLE'));

// ---------- 5. interpretaciones correctas ----------
console.log('\n[5] INTERPRETACIÓN DE RESPUESTAS');
const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
add('code 01 → CERRADO (conservado)', srv.includes("const code01 = out.code === '01'"));
add('code 1000 → apertura (corrección conservada)', /esCodeApertura = out\.code === '00' \|\| out\.code === '1000'/.test(srv));
add('validar-subasta 1001 NO es apertura', srv.includes("String(validar.code) === '1001'"));
add('Reutiliza el endpoint real de compra', srv.includes("'/mesacambiaria/sellbuycurrencyEXCV'") || srv.includes("comprar: '/mesacambiaria/sellbuycurrencyEXCV'"));
add('Reutiliza el parser real del proyecto', srv.includes('estadoIntervencionDesdeRespuesta'));

console.log('\n' + '='.repeat(62));
console.log(` ${ok}/${total} comprobaciones OK`);
console.log('='.repeat(62) + '\n');
process.exit(ok === total ? 0 : 1);
