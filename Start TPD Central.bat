@echo off
title Tisbury PD Central Server
rem pushd works on network (UNC) folders by mapping a temporary drive letter
pushd "%~dp0"

rem 1) Portable Python in a "python" folder next to this file
if exist "python\python.exe" (
    "python\python.exe" "tpd_central.py" %*
    goto end
)
rem 2) Installed Python
where py >nul 2>nul
if %errorlevel%==0 (
    py "tpd_central.py" %*
    goto end
)
where python >nul 2>nul
if %errorlevel%==0 (
    python "tpd_central.py" %*
    goto end
)

echo Python was not found on this computer.
echo Install it from python.org, or unzip a portable Python into a folder named "python" next to this file.

:end
popd
pause
