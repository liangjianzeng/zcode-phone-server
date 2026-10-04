@echo off
rem zcode-phone-server 启动脚本：优先用 tools\node22，否则用系统 Node（需 >= 22.5）
if exist "%~dp0tools\node22\node.exe" (
  "%~dp0tools\node22\node.exe" "%~dp0server.mjs" %*
) else if exist "%~dp0..\tools\node22\node.exe" (
  "%~dp0..\tools\node22\node.exe" "%~dp0server.mjs" %*
) else (
  node "%~dp0server.mjs" %*
)
