@echo off
rem zcode-phone-server 守护脚本：进程退出后 3 秒自动重启，独立于 ZCode 生命周期
rem 幂等修复(2026-11-03)：此前端口被占时仍盲目拉起 -> EADDRINUSE 每 3 秒崩溃一次无限刷日志
rem （keepalive.log/server.log 暴涨，日志全被 EADDRINUSE 堆栈淹没，故障无法定位）。
rem 现改为：端口有监听者时只等待接管（5 秒复查），原实例退出后自动补位重启；
rem 多个守护实例共存安全（输家等待，赢家服务），手动拉起 server.mjs 也不再打架。
cd /d "%~dp0"
rem 端口以 config.json 为单一来源（与 server.mjs 一致），读取失败回落 8787
set PORT=8787
node -e "try{const c=JSON.parse(require('fs').readFileSync('config.json','utf8'));process.stdout.write(String(c.port||8787))}catch(e){process.stdout.write('8787')}" > "%TEMP%\zps_port.txt" 2>nul
set /p PORT=<"%TEMP%\zps_port.txt"
set PORT=%PORT: =%

:loop
rem 端口已有监听者 = 已有实例在服务：不拉起，5 秒后复查，等它退出后接管
netstat -ano -p TCP | findstr /c:":%PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  timeout /t 5 /nobreak >nul
  goto loop
)
echo [%date% %time%] server starting >> logs\keepalive.log
node server.mjs >> logs\server.log 2>&1
echo [%date% %time%] server exited (code %errorlevel%), restarting in 3s >> logs\keepalive.log
timeout /t 3 /nobreak >nul
goto loop
