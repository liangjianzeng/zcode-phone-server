@echo off
rem zcode-phone-server 守护脚本：进程退出后 3 秒自动重启，独立于 ZCode 生命周期
cd /d "%~dp0"
:loop
echo [%date% %time%] server starting >> logs\keepalive.log
node server.mjs >> logs\server.log 2>&1
echo [%date% %time%] server exited (code %errorlevel%), restarting in 3s >> logs\keepalive.log
timeout /t 3 /nobreak >nul
goto loop
