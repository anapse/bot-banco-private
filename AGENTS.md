# BOT BDV — Compra de Divisas — Contexto del proyecto

> Contexto **estable**: arquitectura, reglas y decisiones que NO cambian.
> El estado cambiante está en `HANDOFF.md`.

---

## Propósito

Bot que compra divisas en las **subastas de intervención cambiaria del
Banco de Venezuela (BDV)** cuando el titular no puede estar conectado.

- **Cuenta que compra:** KARELYS2812 (V-26870048)
- **Supervisión:** un familiar con el APK (otra cuenta) avisa cuando la subasta abre
- **Ubicación:** `D:\PROYECTOS\bot raul`
- **Perfil de Hermes:** `bot-raul`

**Estrategia:** prender el bot ANTES de la ventana y enviar la orden
repetidamente. **NO** pre-verificar disponibilidad — se envía y el banco
decide. Al aceptar, compró y se detiene.

**Contexto crítico:** la subasta **abre y se agota en SEGUNDOS**. El
enemigo es la **velocidad**, no el acceso.

---

## Arquitectura

```
server.js         servidor + panel web (puerto 3721)   ← INDEPENDIENTE
apk-api.js        canal del APK (bdvx-*)               ← motor compartido
public/index.html la web (panel + formulario)
tools/            atacante-apk.js, test-lan.sh
```

**El bot NO depende de Hermes para operar.** Hermes es herramienta de
desarrollo. El bot corre solo (`iniciar.bat` / `arrancar-solo.vbs`).

```
HERMES      → desarrollo/actualización (no operativo)
BOT WEB     → sistema operativo independiente
MOTOR       → apk-api.js + server.js (lo usan automático y manual)
```

---

## ⭐ HALLAZGO PRINCIPAL: dos canales distintos

| | Canal | Estado |
|---|---|---|
| **Portal** `bdvenlinea` | `/altaintervencioncambiaria/consultarReglasEXRI` | ❌ **SIEMPRE `code=01`** (455 consultas, todas igual) |
| **APK** `bdvdigital.banvenez.com` | rutas `bdvx-*` | ✅ **estado real** |

**Por eso el bot decía "cerrado" estando abierto: miraba el canal equivocado.**

### Tabla de códigos

| Código | Significado |
|---|---|
| `1000` | ✅ operación **disponible** |
| `1003` | ⏳ **sin cupo** / cerrada (habitual — se agota en segundos) |
| `1001` | datos de entrada inválidos |
| `4000` | servicio no disponible |
| `5000` | error inesperado |
| `WAF` | bloqueado por el cortafuegos del banco |

### Endpoints del APK

```
/bdvx-operaciones-cambiarias/v1/operaciones/consultar/reglas/compra  → estado (1003=sin cupo)
/bdvx-operaciones-cambiarias/v1/operaciones/consultar/actividades    → catálogo
/bdvx-operaciones-cambiarias/v1/operaciones/consultar/reglas         → pide 'tipoRegla'
/bdvx-operaciones-cambiarias/v1/operaciones/comprar                  → COMPRA
/bdvx-operaciones-cambiarias/v1/operaciones/confirmar                → CONFIRMACIÓN
```

**Notas técnicas:**
- El WAF **bloquea GET** → todo va por **POST**.
- Los endpoints `bdvx-*` **no validan el token** (con basura responden igual)
  → el `1003` es el estado REAL, no un rechazo de auth.
- El token del portal **sirve** para la API del APK (no hace falta el OAuth del APK).
- Las respuestas del portal vienen **cifradas AES-256-ECB** (el bot ya las descifra).

---

## Reglas de trabajo

### ⛔ Prohibiciones absolutas
- **NO ejecutar compras/transferencias sin autorización explícita.**
- **NO probar credenciales** contra servicios reales.
- **SOLO-LECTURA primero** → reportar → esperar OK antes de tocar.
- **No borrar el origen hasta verificar el destino.**
- **"Detente aquí" es vinculante.**
- **NO enviar peticiones masivas al banco.**
- **NO inventar una tasa** — siempre la del banco en vivo.

### ✅ Método
1. Auditar antes de modificar (leer el código, no suponer).
2. **Analizar → probar → corregir → verificar → continuar.**
3. Clasificar hallazgos: **Confirmado / Probable / No verificado**.
4. Evidencia real, nunca suposiciones.

### Sobre la tasa
- **NUNCA** usar un valor fijo. Siempre la del banco en vivo.
- Prioridad: **RGLIC de intervención** → si está cerrada, menudeo publicado.
- El **BCV NO sirve** para la subasta (es promedio diario).
- El menudeo (`863,00833`) **no es la tasa de la subasta** — es respaldo.

---

## Decisiones que NO deben cambiarse

| Decisión | Motivo |
|---|---|
| **Formulario existente es LA interfaz** | No crear pestañas ni flujos paralelos |
| **Automático y manual usan el MISMO motor** | `apk-api.js` compartido |
| **Todo por POST** | El WAF bloquea GET |
| **Rutas de assets relativas** | Acceso por LAN |
| **Puerto 3721** | El panel |
| **10 USD de monto** | El probado con el saldo disponible |
| **Credenciales en `.env`** | Nunca en la web |

---

## Comandos

```bash
# Arrancar (doble clic o)
iniciar.bat                    # con reinicio automático si se cae
cscript //nologo arrancar-solo.vbs   # desacoplado

# Panel
http://localhost:3721

# Ataque automático por el canal del APK
node tools/atacante-apk.js --comprar
INTERVALO_MS=250 HILOS=3 node tools/atacante-apk.js --comprar

# Verificar LAN
npm run test:lan   # (o bash tools/test-lan.sh 192.168.1.3)
```

---

## Archivos importantes

| Archivo | Qué es |
|---|---|
| `HANDOFF.md` | **Estado actual** ← leer al empezar |
| `HALLAZGO-API-APK.md` | Por qué no compraba (el diagnóstico) |
| `OPERACION-INDEPENDIENTE.md` | Guía de uso autónomo |
| `server.js` | Servidor + panel (~2700 líneas) |
| `apk-api.js` | Canal del APK |
| `config.json` | Monto, cuentas, reglas |
| `logs/bot-YYYY-MM-DD.log` | Log del día |
| `logs/apk-compras.jsonl` | Evidencia de cada intento de compra |

---

## ⚠️ Advertencia de seguridad conocida

- **`BDV_PASSWORD` está en texto plano en `.env`**
- `web-session.json` guarda `access_token` + `refresh_token` **sin cifrar**
- Los logs contienen el **historial bancario** (dato que el bot NO necesita)

**El `refresh_token` renueva la sesión sin OTP** → es acceso persistente.
Pendiente de proteger (ver HANDOFF).
