@echo off
REM ============================================================================
REM  MONITOR INTERVENCION CAMBIARIA — Banco de Venezuela
REM  Vigila el estado y COMPRA automaticamente cuando el banco abra.
REM  100%% por CMD. No abre ninguna pagina web.
REM ============================================================================
title MONITOR INTERVENCION CAMBIARIA - BDV
cd /d "%~dp0"

echo.
echo  ============================================================
echo         MONITOR INTERVENCION CAMBIARIA - BDV
echo  ============================================================
echo.

REM --- Node presente?
where node >nul 2>nul
if errorlevel 1 (
  echo  [ERROR] Node.js no esta instalado o no esta en el PATH.
  echo          Instalalo desde https://nodejs.org
  pause
  exit /b 1
)

REM --- Intervalo entre comprobaciones (ms). Se puede cambiar aqui.
REM     2000 = 2 s (por defecto) | 1000 = 1 s | 500 = 0,5 s (rapido)
set CHECK_INTERVAL_MS=2000

echo  Intervalo  : %CHECK_INTERVAL_MS% ms
echo  Log        : logs\bot-AAAA-MM-DD.log
echo  Para parar : Ctrl + C
echo.
echo  ------------------------------------------------------------
echo.

REM --use-system-ca: Windows necesita el almacen de certificados del sistema
node --use-system-ca monitor.js --intervalo=%CHECK_INTERVAL_MS%

echo.
echo  ------------------------------------------------------------
echo  El monitor termino.
pause
