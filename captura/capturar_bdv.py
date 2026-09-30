"""
================================================================================
 BDV — CAPTURA DE TRÁFICO DE LA APK OFICIAL  (mitmproxy addon)
================================================================================
 Objetivo: registrar REQUEST/RESPONSE reales de la app oficial para reconstruir
 los contratos exactos (headers, bodies, códigos, app-key, X-MEDIA).

 SEGURIDAD / REGLAS DE ESTA FASE
  · SOLO LECTURA: este addon no modifica ni reenvía nada distinto.
  · REDACTADO OBLIGATORIO: tokens, claves, cédulas, cuentas y datos personales
    se enmascaran ANTES de escribir en disco.
  · No se ejecuta ninguna compra: se captura lo que el usuario hace en la app.

 USO:
   mitmdump -s capturar_bdv.py --set confdir=<dir> -w flujo_completo.mitm
================================================================================
"""
import json
import os
import re
from datetime import datetime

# ------------------------------------------------------------------ config
OUT_DIR = os.environ.get("BDV_CAP_DIR", os.path.join(os.path.expanduser("~"), "bdv_captura"))
os.makedirs(OUT_DIR, exist_ok=True)
JSONL = os.path.join(OUT_DIR, "contratos.jsonl")
LOG   = os.path.join(OUT_DIR, "captura.log")

# Dominios que nos interesan (la app oficial). Se captura todo lo demás igual,
# pero se MARCA lo relevante para localizarlo rápido.
HOSTS_RELEVANTES = ("bdvdigital.banvenez.com", "banvenez.com")

# ------------------------------------------------------------------ redactado
# NUNCA se escribe el valor real de estos en disco.
CAMPOS_SECRETOS = {
    "password", "clave", "pass", "contrasena", "contraseña", "pwd",
    "access_token", "refresh_token", "token", "id_token",
    "authorization", "app-key", "app_key", "apikey", "api-key",
    "x-media", "x_api_key", "cookie", "set-cookie",
    "cedula", "documento", "id", "identificacion",
    "cuenta", "cuentaOrigenBs", "cuentaDestino", "cuentaDestinoDivisa",
    "telefono", "email", "correo", "huella", "ticketId",
    "numeroTarjeta", "tarjeta", "factor3", "codigoConfirmacion",
}

# Patrones que hay que enmascarar dentro de textos libres (URLs, etc.)
PATRONES = [
    (re.compile(r"(password=)[^&\s]+", re.I), r"\1«REDACTADO»"),
    (re.compile(r"(refresh_token=)[^&\s]+", re.I), r"\1«REDACTADO»"),
    (re.compile(r"(access_token=)[^&\s]+", re.I), r"\1«REDACTADO»"),
    (re.compile(r"(username=)[^&\s]+", re.I), r"\1«REDACTADO»"),
    (re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]+", re.I), r"\1«REDACTADO»"),
    # JWT
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"), "«JWT-REDACTADO»"),
    # cédula venezolana
    (re.compile(r"\b[VEJ]-?\d{6,9}\b"), "«CEDULA»"),
    # cuenta de 20 dígitos
    (re.compile(r"\b\d{20}\b"), "«CUENTA»"),
]


def redactar(valor, clave=None):
    """Enmascara un valor. Si la clave es sensible, se oculta entero."""
    if clave and str(clave).lower() in CAMPOS_SECRETOS:
        s = str(valor)
        # conservamos longitud para poder comparar estructuras sin filtrar el dato
        return f"«REDACTADO:{len(s)}»"
    s = str(valor)
    for patron, rep in PATRONES:
        s = patron.sub(rep, s)
    return s


def redactar_obj(o, clave_padre=None):
    """Recorre dict/list y redacta recursivamente."""
    if isinstance(o, dict):
        return {k: redactar_obj(v, k) for k, v in o.items()}
    if isinstance(o, list):
        return [redactar_obj(v, clave_padre) for v in o]
    return redactar(o, clave_padre)


def parsear(texto, content_type):
    """Intenta JSON; si no, devuelve texto redactado."""
    if not texto:
        return None
    if "json" in (content_type or "").lower() or texto.lstrip()[:1] in "{[":
        try:
            return redactar_obj(json.loads(texto))
        except Exception:
            pass
    return redactar(texto[:4000])


def escribir(registro):
    with open(JSONL, "a", encoding="utf-8") as f:
        f.write(json.dumps(registro, ensure_ascii=False) + "\n")
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"{registro['hora']} {registro['metodo']:6} {registro['status']:>4} {registro['url']}\n")


def clasificar_etapa(url, metodo):
    """Etiqueta la llamada con la ETAPA del flujo a la que corresponde."""
    u = url.lower()
    if "/oauth" in u or "login" in u or "token" in u:
        return "AUTH"
    if "mercado" in u and "menudeo" in u:
        return "MERCADO"
    if "intervencion" in u:
        return "REGLAS_INTERVENCION"
    if "consulta-reglas" in u or "consultar/reglas" in u:
        return "REGLAS_POR_MONEDA/COMPRA"
    if "actividades" in u:
        return "ACTIVIDADES"
    if "/comprar" in u:
        return "COMPRA"
    if "/confirmar" in u:
        return "CONFIRMACION"
    if "estados" in u:
        return "ESTADO"
    if "saldo" in u or "cuenta" in u:
        return "CUENTAS/SALDO"
    if "oficinas" in u:
        return "OFICINAS"
    return "OTRO"


# ------------------------------------------------------------------- hooks
def request(flow):
    try:
        host = flow.request.pretty_host
        if not any(h in host for h in HOSTS_RELEVANTES):
            return
        flow.metadata["bdv_guardar"] = True
    except Exception:
        pass


def response(flow):
    try:
        if not flow.metadata.get("bdv_guardar"):
            return
        req, res = flow.request, flow.response
        ct_req = req.headers.get("content-type", "")
        ct_res = res.headers.get("content-type", "")

        body_req = None
        try:
            body_req = parsear(req.get_text(strict=False), ct_req)
        except Exception:
            body_req = "«no legible»"

        cuerpo_res = None
        try:
            cuerpo_res = parsear(res.get_text(strict=False), ct_res)
        except Exception:
            cuerpo_res = "«no legible»"

        registro = {
            "hora": datetime.now().isoformat(timespec="seconds"),
            "etapa": clasificar_etapa(req.pretty_url, req.method),
            "metodo": req.method,
            "url": req.pretty_url,
            "url_redactada": redactar(req.pretty_url),
            "status": res.status_code,
            "request": {
                "headers": {k: redactar(v, k) for k, v in req.headers.items()},
                "body": body_req,
                # QUERY PARAMETERS separados (clave para reconstruir contratos)
                "query": {k: redactar(v, k) for k, v in req.query.items()},
            },
            "response": {
                "headers": {k: redactar(v, k) for k, v in res.headers.items()},
                "body": cuerpo_res,
            },
        }
        escribir(registro)
    except Exception as e:
        try:
            with open(LOG, "a", encoding="utf-8") as f:
                f.write(f"ERROR en hook: {e}\n")
        except Exception:
            pass
