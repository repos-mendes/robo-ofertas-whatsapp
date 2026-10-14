@echo off
chcp 65001 >nul
rem Reconecta o WhatsApp do robô quando ele é deslogado ("WhatsApp deslogado" no logs\app.log).
rem Duplo clique neste arquivo: para o robô, arquiva a sessão antiga, mostra o QR e religa o robô.
cd /d "%~dp0"

echo.
echo === Reconectar WhatsApp do robô de ofertas ===
echo.
echo Isso vai PARAR o robô, descartar a sessão atual do WhatsApp e pedir um QR novo.
echo Tenha em mãos o celular do chip do robô.
echo.
choice /C SN /M "Continuar"
if errorlevel 2 exit /b 0

echo.
echo [1/4] Parando o robô...
schtasks /Change /TN "RoboOfertasWhatsApp" /DISABLE >nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*dist/src/index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
timeout /t 3 /nobreak >nul

echo [2/4] Arquivando a sessão antiga...
if exist "data\wa-session" (
  for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmm"') do ren "data\wa-session" "wa-session.antiga-%%d"
)

echo [3/4] Gerando o QR. No celular: WhatsApp ^> Dispositivos conectados ^> Conectar dispositivo
echo.
call npm run wa:login
if errorlevel 1 (
  rem Código 515 logo após o pareamento é normal: a sessão já foi salva, basta rodar de novo.
  echo.
  echo Tentando de novo para concluir o pareamento...
  call npm run wa:login
)

if not exist "data\wa-session\creds.json" (
  echo.
  echo X O pareamento não foi concluído. O robô continua PARADO.
  echo   Rode este arquivo de novo.
  pause
  exit /b 1
)

echo.
echo [4/4] Religando o robô...
schtasks /Change /TN "RoboOfertasWhatsApp" /ENABLE >nul
schtasks /Run /TN "RoboOfertasWhatsApp" >nul

echo.
echo OK - WhatsApp reconectado e robô no ar. Pode fechar esta janela.
pause
