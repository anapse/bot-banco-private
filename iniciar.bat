@echo off
chcp 65001 >nul
title BDV Bot Web - Compra de Divisas
cd /d "%~dp0"

echo ============================================================
echo   BDV Bot Web - Compra de Divisas
echo   Panel:        http://localhost:3721
echo   Desde la red: http://IP-DEL-VPS:3721
echo   (abre el puerto 3721 en el firewall del VPS)
echo.
echo   INDEPENDIENTE: este bot no necesita ninguna herramienta
echo   externa. La pestana APK del panel permite consultar y
echo   comprar por el canal real de la intervencion.
echo ============================================================
echo.

REM --- verificar Node.js ---
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js no esta instalado en este equipo.
    echo Instala Node.js 20 o superior desde https://nodejs.org y vuelve a ejecutar.
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('node --version') do echo Node.js %%v detectado
echo.

REM --- carpetas y archivos que debe haber (las crea si faltan) ---
if not exist "public" (
    echo [ERROR] No existe la carpeta "public". Copia la carpeta COMPLETA del bot.
    pause
    exit /b 1
)
if not exist ".env" (
    echo [AVISO] No existe .env - el bot pedira los datos de login en el panel.
)

REM --- bucle con reinicio automatico (para el VPS: si se cae, se levanta solo) ---
set /a fallos=0
:loop
echo [%date% %time%] Iniciando el bot...
REM --use-system-ca: usar los certificados del sistema (necesario para consultar el BCV en Windows)
node --use-system-ca server.js
echo [%date% %time%] El bot se detuvo (codigo %errorlevel%).
set /a fallos+=1
if %fallos% geq 5 (
    echo.
    echo [ERROR] El bot se detuvo 5 veces seguidas. Revisa el archivo bot.log
    echo         y corrige el problema antes de volver a iniciar.
    echo.
    pause
    exit /b 1
)
echo Reiniciando en 5 segundos...
ping -n 6 127.0.0.1 >nul
goto loop
