@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 npm,请先安装 Node.js: https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo 首次运行,正在安装依赖(约 100MB,请耐心等待)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败,请检查网络后重试。
    pause
    exit /b 1
  )
)

echo 正在启动应用...
call npm start
