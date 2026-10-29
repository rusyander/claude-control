/**
 * Обёртки ровно в том виде, в каком их пишет npm `cmd-shim` (сняты с установленных здесь
 * обёрток 2026-10-28) — тест разбирает настоящий формат, а не придуманный.
 * `rel` — путь цели от каталога обёртки, через `\` для .cmd и `/` для .ps1.
 */

export function npmCmdShim(rel: string): string {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*`,
    '',
  ].join('\r\n');
}

/** Обёртка npm над нативным файлом (как у CLI, поставляющих .exe в пакете). */
export function npmCmdNativeShim(rel: string): string {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    `"%dp0%\\${rel}"   %*`,
    '',
  ].join('\r\n');
}

export function npmPs1Shim(rel: string): string {
  const call = (node: string) => `& "${node}"  "$basedir/${rel}" $args`;
  return [
    '#!/usr/bin/env pwsh',
    '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
    '',
    '$exe=""',
    'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
    '  $exe=".exe"',
    '}',
    '$ret=0',
    'if (Test-Path "$basedir/node$exe") {',
    '  if ($MyInvocation.ExpectingInput) {',
    `    $input | ${call('$basedir/node$exe')}`,
    '  } else {',
    `    ${call('$basedir/node$exe')}`,
    '  }',
    '  $ret=$LASTEXITCODE',
    '} else {',
    '  if ($MyInvocation.ExpectingInput) {',
    `    $input | ${call('node$exe')}`,
    '  } else {',
    `    ${call('node$exe')}`,
    '  }',
    '  $ret=$LASTEXITCODE',
    '}',
    'exit $ret',
    '',
  ].join('\n');
}

/**
 * Обёртка pnpm (`node_modules/.bin/tsc.CMD`, снята 2026-10-28): `NODE_PATH` выставляется сама,
 * ветка ELSE дописывает `%NODE_PATH%` — разбор берёт только значение без подстановки.
 */
export function pnpmCmdShim(rel: string, nodePath: string): string {
  return [
    '@SETLOCAL',
    '@IF NOT DEFINED NODE_PATH (',
    `  @SET "NODE_PATH=${nodePath}"`,
    ') ELSE (',
    `  @SET "NODE_PATH=${nodePath};%NODE_PATH%"`,
    ')',
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${rel}" %*`,
    ') ELSE (',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    `  node  "%~dp0\\${rel}" %*`,
    ')',
    '',
  ].join('\r\n');
}

/** Самописная обёртка: не формат npm/pnpm — ядро обязано отказать, а не звать cmd.exe. */
export const CUSTOM_CMD = [
  '@echo off',
  'setlocal',
  'if "%1"=="--fast" goto fast',
  'node "%~dp0\\lib\\main.js" %*',
  'goto :eof',
  ':fast',
  'node "%~dp0\\lib\\fast.js" %*',
  '',
].join('\r\n');
