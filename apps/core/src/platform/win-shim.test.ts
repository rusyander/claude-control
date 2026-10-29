import { describe, expect, it } from 'vitest';
import { parseCmdShim, parsePs1Shim } from './win-shim.ts';
import {
  CUSTOM_CMD,
  npmCmdNativeShim,
  npmCmdShim,
  npmPs1Shim,
  pnpmCmdShim,
} from './__fixtures__/shims.ts';

/**
 * Разбор обёрток Windows без оболочки (09 §spawn, P54) — чистая функция, пути по правилам
 * win32 на любой ОС: на Linux эти ветки иначе не исполнялись бы вовсе. Граница подмены —
 * только «есть ли файл» (`isFile`); тексты обёрток — снятые с машины (`__fixtures__/shims.ts`).
 * Всё, что генератор не пишет, обязано дать `undefined` (отказ), а не догадку.
 */

const SHIM_DIR = 'C:\\tools\\bin';
const files = (...paths: string[]) => {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (path: string) => set.has(path.toLowerCase());
};
const CLI_JS = 'C:\\tools\\bin\\node_modules\\pkg\\cli.js';
const CLI_EXE = 'C:\\tools\\bin\\node_modules\\pkg\\cli.exe';

describe('P54 win-shim .cmd parser', () => {
  it('P54 npm .cmd: node target with its script; script missing → refused', () => {
    const text = npmCmdShim('node_modules\\pkg\\cli.js');
    expect(parseCmdShim(text, `${SHIM_DIR}\\pkg.cmd`, files(CLI_JS))).toEqual({
      kind: 'node',
      target: CLI_JS,
      nodeFlags: [],
    });
    expect(parseCmdShim(text, `${SHIM_DIR}\\pkg.cmd`, files())).toBeUndefined();
  });

  it('P54 npm .cmd: node flags before the script are carried; a _prog that is not node → refused', () => {
    const flagged = npmCmdShim('node_modules\\pkg\\cli.js').replace(
      '"%_prog%"  "%dp0%',
      '"%_prog%" --max-old-space-size=4096 --no-warnings "%dp0%',
    );
    expect(parseCmdShim(flagged, `${SHIM_DIR}\\pkg.cmd`, files(CLI_JS))?.nodeFlags).toEqual([
      '--max-old-space-size=4096',
      '--no-warnings',
    ]);
    const bun = npmCmdShim('node_modules\\pkg\\cli.js').replace(
      'SET "_prog=node"',
      'SET "_prog=bun"',
    );
    expect(parseCmdShim(bun, `${SHIM_DIR}\\pkg.cmd`, files(CLI_JS))).toBeUndefined();
  });

  it('P54 npm native .cmd: an .exe target runs as itself; a .js by association, a missing .exe, or a _prog beside it → refused', () => {
    const shim = `${SHIM_DIR}\\pkg.cmd`;
    expect(
      parseCmdShim(npmCmdNativeShim('node_modules\\pkg\\cli.exe'), shim, files(CLI_EXE)),
    ).toEqual({ kind: 'native', target: CLI_EXE, nodeFlags: [] });
    expect(
      parseCmdShim(npmCmdNativeShim('node_modules\\pkg\\cli.js'), shim, files(CLI_JS)),
    ).toBeUndefined();
    expect(
      parseCmdShim(npmCmdNativeShim('node_modules\\pkg\\cli.exe'), shim, files()),
    ).toBeUndefined();
    const withProg = npmCmdNativeShim('node_modules\\pkg\\cli.exe').replace(
      'CALL :find_dp0',
      'CALL :find_dp0\r\nSET "_prog=node"',
    );
    expect(parseCmdShim(withProg, shim, files(CLI_EXE))).toBeUndefined();
  });

  it('P54 pnpm .cmd: both branches call one script → node target with the shim NODE_PATH; diverging branches, ambiguous NODE_PATH, a missing script → refused', () => {
    const shim = `${SHIM_DIR}\\tsc.CMD`;
    const target = 'C:\\tools\\.pnpm\\typescript\\bin\\tsc';
    const text = pnpmCmdShim('..\\.pnpm\\typescript\\bin\\tsc', 'C:\\tools\\.pnpm\\node_modules');
    expect(parseCmdShim(text, shim, files(target))).toEqual({
      kind: 'node',
      target,
      nodeFlags: [],
      nodePath: 'C:\\tools\\.pnpm\\node_modules',
    });
    expect(parseCmdShim(text, shim, files())).toBeUndefined();
    const diverging = text.replace(
      'node  "%~dp0\\..\\.pnpm\\typescript\\bin\\tsc"',
      'node  "%~dp0\\..\\.pnpm\\other\\bin\\tsc"',
    );
    expect(parseCmdShim(diverging, shim, files(target))).toBeUndefined();
    const twoPaths = text.replace(';%NODE_PATH%"', '"');
    expect(parseCmdShim(twoPaths, shim, files(target))).toBeUndefined();
    // Без NODE_PATH вовсе — цель та же, пути нет.
    const bare = ['@IF EXIST "%~dp0\\node.exe" (', '  "%~dp0\\node.exe"  "%~dp0\\x.js" %*', ')'];
    expect(parseCmdShim(bare.join('\r\n'), shim, files('C:\\tools\\bin\\x.js'))).toEqual({
      kind: 'node',
      target: 'C:\\tools\\bin\\x.js',
      nodeFlags: [],
    });
  });

  it('P54 .cmd outside the generators: a hand-written batch, no %* line, three runs → refused', () => {
    const shim = `${SHIM_DIR}\\x.cmd`;
    const any = () => true;
    expect(parseCmdShim(CUSTOM_CMD, shim, any)).toBeUndefined();
    expect(parseCmdShim('@echo off\r\necho hi\r\n', shim, any)).toBeUndefined();
    const three = ['node "%~dp0\\a.js" %*', 'node "%~dp0\\a.js" %*', 'node "%~dp0\\a.js" %*'];
    expect(parseCmdShim(three.join('\r\n'), shim, any)).toBeUndefined();
  });
});

describe('P54 win-shim .ps1 parser', () => {
  const shim = `${SHIM_DIR}\\pkg.ps1`;

  it('P54 npm .ps1: all four & lines call one script → node target; script missing → refused', () => {
    const text = npmPs1Shim('node_modules/pkg/cli.js');
    expect(parsePs1Shim(text, shim, files(CLI_JS))).toEqual({
      kind: 'node',
      target: CLI_JS,
      nodeFlags: [],
    });
    expect(parsePs1Shim(text, shim, files())).toBeUndefined();
  });

  it('P54 npm .ps1: branches naming different scripts or different flags → refused', () => {
    const text = npmPs1Shim('node_modules/pkg/cli.js');
    const lastScript = text.lastIndexOf('node_modules/pkg/cli.js');
    const diverging = `${text.slice(0, lastScript)}node_modules/pkg/other.js${text.slice(lastScript + 'node_modules/pkg/cli.js'.length)}`;
    expect(parsePs1Shim(diverging, shim, files(CLI_JS))).toBeUndefined();
    const flagged = text.replace('& "node$exe"  "', '& "node$exe" --inspect "');
    expect(parsePs1Shim(flagged, shim, files(CLI_JS))).toBeUndefined();
  });

  it('P54 .ps1 native: & "$basedir/x.exe" $args → native; two different binaries, a mixed line, no & line → refused', () => {
    const native = (rel: string) => `& "$basedir/${rel}" $args`;
    expect(parsePs1Shim(native('node_modules/pkg/cli.exe'), shim, files(CLI_EXE))).toEqual({
      kind: 'native',
      target: CLI_EXE,
      nodeFlags: [],
    });
    const two = [native('node_modules/pkg/cli.exe'), native('node_modules/pkg/b.exe')];
    expect(parsePs1Shim(two.join('\n'), shim, () => true)).toBeUndefined();
    const mixed = [native('node_modules/pkg/cli.exe'), '& "$basedir/x.exe" --x $args'];
    expect(parsePs1Shim(mixed.join('\n'), shim, () => true)).toBeUndefined();
    expect(parsePs1Shim('Write-Host hi\n', shim, () => true)).toBeUndefined();
  });
});
