/* ============================================================================
 * test-tasas.js — pruebas LOCALES y puras del parseo/formato numérico
 * ----------------------------------------------------------------------------
 * No toca la red ni el banco: sólo ejercita tasas-numero.js.
 * Uso:  node test-tasas.js
 * ========================================================================== */
'use strict';
const { parseNumeroBanco, fmtNumeroBanco } = require('./tasas-numero');

let ok = 0, fail = 0;
function check(desc, obtenido, esperado) {
  const bien = JSON.stringify(obtenido) === JSON.stringify(esperado);
  if (bien) { ok++; console.log(`  ✅ ${desc} → ${JSON.stringify(obtenido)}`); }
  else { fail++; console.log(`  ❌ ${desc} → ${JSON.stringify(obtenido)} (esperado ${JSON.stringify(esperado)})`); }
}

console.log('\n=== PARSEO (parseNumeroBanco) — formatos exigidos ===');
check('"847,44420"  (coma decimal, 5 dec)', parseNumeroBanco('847,44420'), 847.4442);
check('"8.000,00"   (miles con punto + coma)', parseNumeroBanco('8.000,00'), 8000);
check('"847.44420"  (punto decimal, 5 dec)', parseNumeroBanco('847.44420'), 847.4442);
check('"8000.00"    (punto decimal, 2 dec)', parseNumeroBanco('8000.00'), 8000);

console.log('\n=== PARSEO — otros casos del banco ===');
check('"0,20"       (porcentaje comisión)', parseNumeroBanco('0,20'), 0.2);
check('"0,01"       (monto mínimo menudeo)', parseNumeroBanco('0,01'), 0.01);
check('"8.000"      (solo punto, 3 dígitos → miles)', parseNumeroBanco('8.000'), 8000);
check('"1.234.567,89" (miles + decimal)', parseNumeroBanco('1.234.567,89'), 1234567.89);
check('"385087.73"  (saldo crudo)', parseNumeroBanco('385087.73'), 385087.73);
check('"-33,00"     (importe negativo)', parseNumeroBanco('-33,00'), -33);
check('"  855,91864 " (con espacios)', parseNumeroBanco('  855,91864 '), 855.91864);
check('847.4442     (ya numérico)', parseNumeroBanco(847.4442), 847.4442);
check('null          (sin dato)', parseNumeroBanco(null), null);
check('""            (vacío)', parseNumeroBanco(''), null);
check('"abc"         (no numérico)', parseNumeroBanco('abc'), null);

console.log('\n=== FORMATO (fmtNumeroBanco) ===');
check('847.4442 → 5 dec con coma', fmtNumeroBanco(847.4442, 5), '847,44420');
check('385087.73 → 2 dec (saldo)', fmtNumeroBanco(385087.73, 2), '385087,73');
check('null → null', fmtNumeroBanco(null, 2), null);

console.log('\n=== REGRESIÓN del bug de la auditoría ===');
// El bug era: "8.000,00".replace(',', '.') → parseFloat("8.000.00") = 8  (INCORRECTO)
const viejo = parseFloat(String('8.000,00').replace(',', '.'));
console.log(`  · método viejo sobre "8.000,00" → ${viejo}  (bug demostrado)`);
check('método nuevo sobre "8.000,00" → 8000 (corregido)', parseNumeroBanco('8.000,00'), 8000);

console.log(`\n=== RESULTADO: ${ok} correctas, ${fail} fallidas ===\n`);
process.exit(fail === 0 ? 0 : 1);
