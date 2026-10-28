@echo off
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"

if "%1"=="--check" goto check

echo.
echo  ==========================================================
echo   Step 0/3   Timeline demo  (two weeks, no input needed)
echo  ==========================================================
echo.
python demo_timeline.py
echo.
echo  Press any key to continue...
pause >nul

echo.
echo  ==========================================================
echo   Step 1/3   Session A : talk, and it remembers
echo  ==========================================================
echo.
python demo_a_write.py
echo.
echo  Press any key to simulate RESTARTING the app (Session B)...
pause >nul

echo.
echo  ==========================================================
echo   Step 2/3   Session B : brand new process, does it remember?
echo  ==========================================================
echo.
python demo_b_recall.py
echo.
timeout /t 2 >nul

echo.
echo  ==========================================================
echo   Step 3/3   Now try it yourself
echo   Type what YOU would say. /help for commands, /quit to exit.
echo  ==========================================================
echo.
python chat_play.py

pause
goto :eof

:check
python demo_timeline.py >nul 2>&1 || exit /b 1
python demo_a_write.py >nul 2>&1 || exit /b 1
python demo_b_recall.py >nul 2>&1 || exit /b 1
python chat_play.py --check || exit /b 1
python mcp_test.py >nul 2>&1 || exit /b 1
echo CHECK_DONE
exit /b 0
