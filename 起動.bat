@echo off
cd /d "%~dp0"
rem VSCode等のElectron製ターミナルから起動すると ELECTRON_RUN_AS_NODE が
rem 引き継がれ、Electron APIを読み込めずに起動へ失敗するため解除する。
set ELECTRON_RUN_AS_NODE=
if not exist node_modules (
  echo First run: installing dependencies...
  call npm install
)
echo Starting External Device Simulator...
call npm start
