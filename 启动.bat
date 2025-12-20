@echo off
chcp 65001 >nul

setlocal enabledelayedexpansion
title Glass Todo Portable
color 0A

:: 1. 切换到当前目录
cd /d "%~dp0"

:: 2. 设置临时环境变量
set "LOCAL_NODE=%~dp0bin"
set "PATH=%LOCAL_NODE%;%PATH%"

echo ========================================================
echo       Glass Todo 绿色便携版 (Portable Mode)
echo ========================================================

:: 3. 检查 bin 文件夹是否准备好
if not exist "%LOCAL_NODE%\node.exe" (
    color 0C
    echo.
    echo [错误] 未找到内置的 Node.js 环境！
    echo.
    echo 请按照以下步骤操作：
    echo 1. 在项目根目录创建一个名为 bin 的文件夹。
    echo 2. 下载 Node.js 的 Windows zip 包。
    echo 3. 解压并将 node.exe 等所有文件放入 bin 文件夹中。
    echo.
    echo 当前检测路径: %LOCAL_NODE%\node.exe
    pause
    exit
)

:: 4. 验证环境
echo [环境] 正在使用内置 Node.js:
call node -v
if %errorlevel% NEQ 0 (
    echo [错误] 内置 Node 无法运行，请检查 bin 文件夹内容。
    pause
    exit
)

:: 5. 检查依赖 (node_modules)
if not exist "node_modules" (
    echo.
    echo [提示] 首次运行，正在初始化依赖...
    echo       (使用内置 npm 安装，可能需要几分钟)
    
    call npm config set registry https://registry.npmmirror.com
    call npm install
    
    if !errorlevel! NEQ 0 (
        echo [错误] 依赖安装失败。请检查网络。
        pause
        exit
    )
)

:: 6. 启动服务 (静默模式)
echo.
echo ========================================================
echo       服务已启动 (内置模式)
echo       请在浏览器访问: http://localhost:3000
echo ========================================================
:: 等待 2 秒，确保服务启动完成
timeout /t 2 /nobreak >nul

:: 自动打开默认浏览器
start http://localhost:3000
node server.js

pause