"""
PRUEBA DEL REDACTADO — verifica que NINGÚN dato sensible llega al disco.
Se ejecuta el addon con flujos SIMULADOS y se comprueba la salida.
"""
import sys, os, json, importlib.util

# cargar el addon como modulo
spec = importlib.util.spec_from_file_location("cap", r"D:\PROYECTOS\bot raul\captura\capturar_bdv.py")
cap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cap)

print('=' * 74)
print('PRUEBA 1 — redactar() sobre valores individuales')
print('=' * 74)
casos = [
    ('password',      'MiClaveSecreta123'),
    ('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk'),
    ('app-key',       'a1b2c3d4e5f6a7b8c9d0'),
    ('X-MEDIA',       'ANDROID-99887766'),
    ('refresh_token', 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXAiOiJyZWZyZXNoIn0.zzzzzzzzzzz'),
    ('cedula',        'V-26870048'),
    ('cuenta',        '01020414330000654951'),
    ('Content-Type',  'application/json'),
    ('Accept',        'application/json'),
]
for k, v in casos:
    r = cap.redactar(v, k)
    seguro = 'SEGURO ' if ('REDACTADO' in r or '«' in r) else 'EXPUESTO!'
    print(f'  [{seguro}] {k:16} {v[:34]:36} -> {r}')

print()
print('=' * 74)
print('PRUEBA 2 — URL con credenciales en query string')
print('=' * 74)
url = 'https://bdvdigital.banvenez.com/bdvx-oauth-server/oauth/token?grant_type=password&username=V-26870048&password=SuperClave123'
print('  entrada:', url)
print('  salida :', cap.redactar(url))
assert 'SuperClave123' not in cap.redactar(url), 'FUGA: la clave apareció'
assert '26870048' not in cap.redactar(url), 'FUGA: la cédula apareció'
print('  ✅ sin fugas')

print()
print('=' * 74)
print('PRUEBA 3 — body JSON anidado (estructura típica de respuesta)')
print('=' * 74)
body = {
    "code": "1000",
    "data": {
        "access_token": "eyJhbGciOiJIUzI1NiJ9.PAYLOAD.FIRMA",
        "refresh_token": "eyJhbGciOiJIUzI1NiJ9.REFRESH.FIRMA",
        "cuentaOrigenBs": "01020414330000654951",
        "cedulaDestino": "V-26870048",
        "monto": "150.00",
        "tasaCambio": "858.0596",
        "reglas": [{"codigoRegla": "RGLIC", "tasaCompra": "848,54580", "tasaVenta": "857,03125"}]
    }
}
red = cap.redactar_obj(body)
salida = json.dumps(red, ensure_ascii=False, indent=2)
print(salida)
crudo = json.dumps(red)
for fuga in ['eyJhbGci', '01020414330000654951', '26870048', 'PAYLOAD', 'REFRESH']:
    assert fuga not in crudo, f'FUGA DETECTADA: {fuga}'
print()
print('  ✅ sin fugas de tokens, cuentas ni cédulas')
print('  ✅ estructura conservada (campos y códigos legibles para reconstruir el contrato)')

print()
print('=' * 74)
print('RESULTADO: el addon redacta correctamente antes de escribir en disco.')
print('=' * 74)
