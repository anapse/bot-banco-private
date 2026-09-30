# 🤖 BDV Bot Web — Compra de divisas (intervención cambiaria)

Bot local + panel web que vigila la venta de divisas de la **intervención
cambiaria** del Banco de Venezuela y compra automáticamente cuando se cumplen
**tus reglas** (monto máximo, tasa máxima), mientras tú no estás.

## Inicio rápido

```bash
node server.js
# → abre http://127.0.0.1:3721
```

1. Abre el panel → pestaña **Bot** → configura tus reglas → **Guardar**.
2. Pestaña **Panel** → **▶ Iniciar**.
3. El bot envía la orden cada N segundos; cuando el banco abre la venta de
   divisas y la tasa está dentro de tu límite, compra solo, guarda la
   referencia y te avisa (pantalla y/o Telegram).

> Sin dependencias: solo Node.js 18+ (usa `fetch` nativo).

## Modos

| Modo | Qué hace | Credenciales |
|---|---|---|
| `sim` (default) | Intervenciones, tasas y compras **simuladas**. Cero tráfico al banco. | No necesita |
| `real` | Usa los endpoints del portal bdvenlinea con tu sesión. | Sí (`.env`) |

**Empieza siempre en SIM** para probar el flujo completo (compra simulada →
referencia → notificación) antes de pasar a REAL.

## Tasas: INTERVENCIÓN · MENUDEO · CACHÉ

Hay **una sola función** que decide la tasa: `getTasaOperativa()` (server.js).
El panel **no elige tasa**: sólo pinta lo que el backend entrega.

### INTERVENCIÓN (la ÚNICA tasa operativa)
- **Endpoint**: `POST /altaintervencioncambiaria/consultarReglasEXRI`
- **Campo de tasa**: `tasaReferencia`
- **Estado**: `code` del banco (`00` = habilitada, `01` = cerrada; cualquier otro se registra como *desconocido* y se conserva la respuesta completa)
- **Origen**: `intervencion`
- Si la intervención **no está habilitada, la tasa operativa es `null`**: se muestra
  *"NO DISPONIBLE"* y **no se envía ninguna orden**. Nunca se sustituye por menudeo.

### MENUDEO (referencia informativa — NO operativa)
- **Endpoint**: `POST /menudeo/consulta-mercado/`
- **Compra USD**: `tasaCambioCompraDolar` · **Venta USD**: `tasaCambioVentaDolar`
- **Compra EUR**: `tasaCambioCompraEuro` · **Venta EUR**: `tasaCambioVentaEuro`
- **Estado**: `estadoPolitica`, y por divisa `estatusDolar` / `estatusEuro`
- **Origen**: `menudeo`
- Se muestra en una tarjeta **separada**, rotulada como referencia. **No alimenta el formulario ni el payload.**
- Cada sentido (compra/venta) y cada divisa se guarda por separado: no se salta de un sentido a otro.

### CACHÉ (`web-tasa.json`)
- Es **sólo un registro histórico/visual**. Al arrancar se carga como `historico`.
- **Nunca** se usa como tasa operativa ni como "tasa actual"; la operativa sólo sale de una
  respuesta del banco obtenida en la sesión en curso.

### Frescura y validación
- Cada consulta registra `timestamp`, `endpoint`, `httpStatus`, `estado`, `origen` y `ageMs`.
- La interfaz muestra la antigüedad ("actualizada hace 12 s") y marca los datos de sesiones anteriores.
- Una tasa sólo se marca **OPERATIVA** si: viene de una respuesta actual, es del mercado
  correcto, el estado está habilitado, es numéricamente válida y no procede de caché ni de simulación.

### Comisión
- Se reporta el `porcentajeComision` que entrega el banco.
- **El importe de la comisión no se calcula** (base de cálculo *NO VERIFICADA*): se muestra
  "Comisión según banco" y los componentes van separados (montoDivisa · tasa · subtotal · comisión · total).

> ⚠️ El contrato de la respuesta **ABIERTA** de `consultarReglasEXRI` está **NO VERIFICADO**.
> Sólo hay evidencia de la respuesta cerrada (`code '01'`). Cuando aparezca una respuesta abierta real,
> se analiza y se adapta el parser **a lo observado**, sin rellenar campos faltantes con valores inventados.

## Endpoints que usa

### Portal web (flujo operativo del bot) — bdvenlinea.banvenez.com

- `POST /oauthaccess/verificar-usuario-unico` — paso 1 del login (ticket)
- `POST /oauthaccess/login` — paso 2 del login (clave cifrada AES)
- `POST /oauthaccess/actualizar` — renovación de sesión (refresh_token)
- `POST /oauthaccess/cerrar` — cierre de sesión
- `GET  /consultasaldocuenta/consultaCuentas` — cuentas del cliente
- `POST /menudeo/consulta-mercado/` — tasas de menudeo (referencia aparte)
- `POST /consulta-saldo-cuenta-cliente/consulta/saldo` — saldo disponible
- `POST /altaintervencioncambiaria/consultarReglasEXRI` — reglas de la intervención (tasaReferencia)
- `POST /altaintervencioncambiaria/obtenerDataCombo` — catálogo de actividades/destinos
- `POST /mesacambiaria/sellbuycurrencyEXCV` — ejecutar la compra de divisas
- `POST /picconsultamovimientos/queryLastMovements` — movimientos de la cuenta

### App móvil (extraídos del APK oficial — bdvdigital.banvenez.com)

Los mismos servicios que la app Flutter (`libapp.so`). Requieren `app-key`
(se genera en runtime, no está en el binario), por eso el bot opera por el
portal web, que no lo exige:

- `GET /bdvx-intervencion-cambiaria/v1/intervencion/consultarReglasEXRI`
- `GET /bdvx-intervencion-cambiaria/v1/intervencion/`
- `GET /bdvx-menudeo-v2/v1/mercado`
- `POST /bdvx-menudeo-v2/v1/transar`
- `POST /bdvx-operaciones-cambiarias/v1/operaciones/comprar`
- `POST /bdvx-operaciones-cambiarias/v1/operaciones/confirmar`
- `GET  /bdvx-operaciones-cambiarias/v1/operaciones/consultar/estados`
- `GET  /bdvx-operaciones-cambiarias/v1/operaciones/consultar/reglas/compra`
- `POST /bdvx-oauth-server/oauth/token` — login/refresh OAuth (credenciales en query string)

## ⚠️ MODO REAL — antes de activarlo (importante)

El flujo operativo usa el portal web con login de 2 pasos (verificado en vivo).
La extracción estática del APK da **rutas**, pero no el **contrato exacto** de
cada POST de la app (headers adicionales como `app-key`, firma de peticiones).
Para usar los endpoints de la app necesitas:

1. **Capturar el tráfico real** del APK una vez (mitmproxy/PCAPdroid —
   los Flutter ignoran el proxy del sistema).
2. **Token**: el bot ya hace login y renovación por el portal web solo;
   `BDV_USERNAME`/`BDV_PASSWORD` en `.env` bastan.

## Riesgos que debes conocer

- **Políticas del banco**: automatizar operaciones puede contravenir los Términos
  de Servicio y activar bloqueos/alertas de seguridad en tu cuenta. Úsalo bajo tu
  responsabilidad, con montos pequeños primero.
- **Credenciales**: viven solo en `bot raul\.env` (nunca en el panel web).
  No compartas ese archivo. Si el token se filtra, revócalo desde la app.
- **Este proyecto es educativo/de uso personal**: no está afiliado al Banco de
  Venezuela y no garantiza ejecución de operaciones.

## Modo diagnóstico de apertura (`DIAGNOSTICO_BDV=true`)

Sirve para **averiguar qué responde el banco durante una apertura real sin comprar nada**.

- Se activa poniendo `DIAGNOSTICO_BDV=true` en `.env` (y se desactiva con `false` o quitando la línea).
- **Bloquea la compra**: `intentarCompraWeb()` no se ejecuta y `/api/web-comprar` responde `modoDiagnostico:true`. Nunca se llama a `sellbuycurrencyEXCV`.
- **No añade endpoints**: registra las consultas que la app ya hace (login, cuentas, saldo, mercado, reglas EXRI, validar-subasta).
- **No aumenta la frecuencia**: se engancha al ciclo de 30 s (intervención) y al de 5 min (menudeo).
- Registra cada consulta con: `hora endpoint metodo httpStatus duracionMs code message campos clasificacion`.
- **Redacta** tokens, cuentas, cédulas, teléfonos, correos y claves antes de escribir.
- Escribe en `logs/diagnostico-YYYY-MM-DD.log` (sin rotación) además del log normal.
- Emite un bloque comparativo **MERCADO vs EXRI** y el **payload que se enviaría** (redactado).
- Consulta bajo demanda: `GET /api/diagnostico` · Estado: `GET /api/state` → `bot.diagnostico`.


## Seguridad del panel

- `/api/state` entrega **sólo** lo que el panel necesita: **nunca** `access_token`,
  `refresh_token`, contraseña, claves AES ni números de cuenta completos (van enmascarados).
- Las cuentas se muestran enmascaradas (`…4951`) y el **servidor** resuelve el número real
  al operar: el navegador no maneja números completos.
- `/api/web-debug` **ya no es un proxy**: no acepta `{path, method, body}`; sólo devuelve el
  estado interno de tasas y la última respuesta registrada.
- Si expones el panel (ngrok u otro), añade protección: cualquiera con la URL podría
  iniciar operaciones.

## Estructura

```
bot raul/
├── server.js        # servidor web + motor del bot (sin dependencias)
├── tasas-numero.js  # parseo/formato numérico del banco (con pruebas)
├── test-tasas.js    # pruebas locales: node test-tasas.js
├── config.json      # reglas del bot (no secretos)
├── .env             # secretos (crea uno desde .env.example)
├── .env.example
├── bot.log          # registro de actividad (con rotación)
├── logs/            # log diario completo (bot-AAAA-MM-DD.log)
└── public/
    └── index.html   # panel web
```

> `TG_BOT_TOKEN` / `TG_CHAT_ID` del `.env` **no se usan** (las notificaciones leen
> `config.json → telegram`). Quedan reservados.
