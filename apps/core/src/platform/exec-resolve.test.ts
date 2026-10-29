import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveExecutable } from './exec-resolve.ts';
import { parsePs1Shim } from './win-shim.ts';

const root = mkdtempSync(join(tmpdir(), 'exec-resolve-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('F-61 exec-resolve — the shebang check reads two bytes, not the whole file', () => {
  it('F-61 a 600 MB executable starting with #! is a shebang script (whole-file read would overflow a string)', () => {
    const dir = mkdtempSync(join(root, 'big-'));
    const file = join(dir, 'huge-cli');
    const fd = openSync(file, 'w', 0o755);
    writeSync(fd, '#!/bin/sh\n');
    closeSync(fd);
    truncateSync(file, 600 * 1024 * 1024);
    try {
      const found = resolveExecutable('huge-cli', {
        os: 'linux',
        skipPath: true,
        extraDirs: [dir],
      });
      expect(found).toMatchObject({ ok: true, kind: 'shebang' });
    } finally {
      rmSync(file, { force: true });
    }
  });
});

// Обёртка pnpm `.ps1` в том виде, как её пишет pnpm 10 (снята с node_modules/.bin этого репозитория).
const PNPM_PS1 = [
  '#!/usr/bin/env pwsh',
  '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
  '',
  '$exe=""',
  '$pathsep=":"',
  '$env_node_path=$env:NODE_PATH',
  '$new_node_path="C:\\p\\node_modules\\.pnpm\\tool@1\\node_modules;C:\\p\\node_modules\\.pnpm\\node_modules"',
  'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
  '  $exe=".exe"',
  '  $pathsep=";"',
  '} else {',
  '  $new_node_path="/proc/cygdrive/c/p/node_modules/.pnpm/tool@1/node_modules"',
  '}',
  'if ([string]::IsNullOrEmpty($env_node_path)) {',
  '  $env:NODE_PATH=$new_node_path',
  '} else {',
  '  $env:NODE_PATH="$new_node_path$pathsep$env_node_path"',
  '}',
  '',
  '$ret=0',
  'if (Test-Path "$basedir/node$exe") {',
  '  if ($MyInvocation.ExpectingInput) {',
  '    $input | & "$basedir/node$exe"  "$basedir/../.pnpm/tool@1/node_modules/tool/bin/tool" $args',
  '  } else {',
  '    & "$basedir/node$exe"  "$basedir/../.pnpm/tool@1/node_modules/tool/bin/tool" $args',
  '  }',
  '  $ret=$LASTEXITCODE',
  '} else {',
  '  if ($MyInvocation.ExpectingInput) {',
  '    $input | & "node$exe"  "$basedir/../.pnpm/tool@1/node_modules/tool/bin/tool" $args',
  '  } else {',
  '    & "node$exe"  "$basedir/../.pnpm/tool@1/node_modules/tool/bin/tool" $args',
  '  }',
  '  $ret=$LASTEXITCODE',
  '}',
  '$env:NODE_PATH=$env_node_path',
  'exit $ret',
].join('\r\n');

describe('F-115 Windows shims — pnpm .ps1 carries NODE_PATH; node found through a node.cmd does not recurse', () => {
  it('F-115 pnpm .ps1: the Windows NODE_PATH branch is carried like the .cmd one', () => {
    const shim = parsePs1Shim(PNPM_PS1, 'C:\\p\\node_modules\\.bin\\tool.ps1', () => true);
    expect(shim).toMatchObject({
      kind: 'node',
      nodePath:
        'C:\\p\\node_modules\\.pnpm\\tool@1\\node_modules;C:\\p\\node_modules\\.pnpm\\node_modules',
    });
  });

  it('F-115 pnpm .ps1 with two Windows NODE_PATH assignments → refused (ambiguous), like .cmd', () => {
    const doubled = PNPM_PS1.replace('$pathsep=":"', '$pathsep=":"\r\n$new_node_path="C:\\other"');
    expect(
      parsePs1Shim(doubled, 'C:\\p\\node_modules\\.bin\\tool.ps1', () => true),
    ).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')(
    'F-115 PATH holding only a node.cmd shim → node falls back to our own binary, no recursion',
    () => {
      const dir = mkdtempSync(join(root, 'nodecmd-'));
      const cmd = (script: string) =>
        [
          '@SETLOCAL',
          '@IF EXIST "%~dp0\\node.exe" (',
          `  "%~dp0\\node.exe"  "%~dp0\\${script}" %*`,
          ') ELSE (',
          '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
          `  node  "%~dp0\\${script}" %*`,
          ')',
        ].join('\r\n');
      writeFileSync(join(dir, 'tool.js'), '');
      writeFileSync(join(dir, 'node-shim.js'), '');
      writeFileSync(join(dir, 'tool.cmd'), cmd('tool.js'));
      writeFileSync(join(dir, 'node.cmd'), cmd('node-shim.js'));
      const found = resolveExecutable('tool', { os: 'win32', env: { PATH: dir } });
      expect(found).toMatchObject({ ok: true, kind: 'shim-node', file: process.execPath });
    },
  );
});
