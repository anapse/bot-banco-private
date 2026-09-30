@echo off
REM ============================================================================
REM  FLUJO APK REAL — Monitor + Compra (Banco de Venezuela)
REM  ---------------------------------------------------------------------------
REM  Reproduce el flujo de la aplicacion oficial (bdvdigital.banvenez.com):
REM    LOGIN -> REGLAS DE COMPRA -> ACTIVIDADES -> ESTADOS -> OFICINAS
REM          -> COMPRAR -> CONFIRMAR
REM
REM  Cuando la intervencion esta CERRADA no compra: solo vigila y espera.
REM  En cuanto detecte la venta ABIERTA (con tasa real), ejecuta la compra.
REM
REM  Requiere app-key para autenticarse contra bdvdigital (se lee del .env).
REM ============================================================================
title FLUJO APK - BDV (monitor + compra)
cd /d "%~dp0"

echo.
echo  ============================================================
echo         FLUJO APK - BDV (monitor + compra real)
echo  ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [ERROR] Node.js no esta instalado o no esta en el PATH.
  pause
  exit /b 1
)

REM Intervalo entre consultas (ms). 2000 = 2 s
set APK_INTERVAL_MS=2000

echo  Host      : https://bdvdigital.banvenez.com
echo  Intervalo : %APK_INTERVAL_MS% ms
echo  Para parar: Ctrl + C
echo.
echo  ------------------------------------------------------------
echo.

node --use-system-ca src\apkFlow\real.js

echo.
echo  ------------------------------------------------------------
echo  El flujo APK termino.
pause
