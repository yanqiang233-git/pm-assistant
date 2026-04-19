@echo off
REM ==========================================
REM  Windows 打包脚本
REM  在 Windows 机器上执行此脚本即可打包
REM ==========================================

REM 前置条件检查
where rustc >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未安装 Rust，请先安装: https://rustup.rs/
    pause
    exit /b 1
)

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未安装 Node.js，请先安装: https://nodejs.org/
    pause
    exit /b 1
)

REM 安装依赖
echo [1/3] 安装 npm 依赖...
call npm install
if %errorlevel% neq 0 (
    echo [错误] npm install 失败
    pause
    exit /b 1
)

REM 生成图标（如果替换了 app-icon.png）
echo [2/3] 生成图标...
call npx tauri icon src-tauri\icons\app-icon.png

REM 打包
echo [3/3] 开始打包 Windows 应用...
call npm run tauri build
if %errorlevel% neq 0 (
    echo [错误] 打包失败
    pause
    exit /b 1
)

echo.
echo ==========================================
echo  打包完成！
echo  输出目录: src-tauri\target\release\bundle\
echo ==========================================
pause
