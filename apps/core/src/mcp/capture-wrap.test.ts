import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CAPTURE_SHIM,
  CAPTURE_TOKEN_FILE,
  CAPTURE_VARS,
  CAPTURE_WRAP_FLAG,
} from '../platform/capture-shim.ts';
import {
  CAPTURE_TOOLS,
  captureWrapperArgv,
  composeCaptureNodeOptions,
  splitNodeOptions,
  withoutCaptureRequire,
} from './capture-wrap.ts';

/**
 * Сборка `NODE_OPTIONS` захвата (G22, P54) и argv обёртки PATH. Решающая проверка — живой node:
 * слова собираются так, как их режет сам node, поэтому путь прокладки с пробелом и кириллицей
 * исполняется настоящим процессом, а не только сравнивается строкой.
 */

const shim = createRequire(import.meta.url)(CAPTURE_SHIM) as {
  VARS: Record<string, string>;
  WRAP_FLAG: string;
  ACCESS_FILE: string;
};

const root = mkdtempSync(join(tmpdir(), 'capture-wrap-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('core side of the shim names the same variables as the shim itself', () => {
  it('VARS, wrap flag and access file name match the cjs exports', () => {
    expect(shim.VARS).toEqual(CAPTURE_VARS);
    expect(shim.WRAP_FLAG).toBe(CAPTURE_WRAP_FLAG);
    expect(shim.ACCESS_FILE).toBe(CAPTURE_TOKEN_FILE);
  });
});

describe('NODE_OPTIONS composition (G22: the shim goes first, other entries kept)', () => {
  it('splits like node: quotes keep spaces, backslash inside quotes escapes, raw spelling kept', () => {
    expect(splitNodeOptions('  --a  --require "C:\\\\x y\\\\s.cjs" -r=b ')).toEqual([
      { value: '--a', raw: '--a' },
      { value: '--require', raw: '--require' },
      { value: 'C:\\x y\\s.cjs', raw: '"C:\\\\x y\\\\s.cjs"' },
      { value: '-r=b', raw: '-r=b' },
    ]);
  });

  it('shim first, foreign entries after it in their order and spelling', () => {
    const got = composeCaptureNodeOptions(
      '--max-old-space-size=4096 --require "/opt/my tools/trace.cjs"',
      '/srv/capture-preload.cjs',
    );
    expect(got).toBe(
      '--require "/srv/capture-preload.cjs" --max-old-space-size=4096 --require "/opt/my tools/trace.cjs"',
    );
  });

  it('a previous shim entry (any copy, any spelling) is replaced, never doubled; reinstall is idempotent', () => {
    const prev =
      '--require "/old/clone/capture-preload.cjs" --inspect -r C:\\a\\capture-preload.cjs --require=/x/capture-preload.cjs';
    const once = composeCaptureNodeOptions(prev, '/new/capture-preload.cjs');
    expect(once).toBe('--require "/new/capture-preload.cjs" --inspect');
    expect(composeCaptureNodeOptions(once, '/new/capture-preload.cjs')).toBe(once);
    expect(withoutCaptureRequire(once)).toBe('--inspect');
    expect(withoutCaptureRequire(undefined)).toBe('');
  });

  it('P54: a shim path with a space and Cyrillic loads in a real node, foreign entries still apply', () => {
    const dir = join(root, 'путь с пробелом');
    mkdirSync(dir, { recursive: true });
    const copy = join(dir, 'capture-preload.cjs');
    copyFileSync(CAPTURE_SHIM, copy);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_OPTIONS: composeCaptureNodeOptions('--max-old-space-size=200', copy),
    };
    for (const name of Object.values(CAPTURE_VARS)) delete env[name];
    const probe = [
      "const v8 = require('node:v8');",
      'const loaded = Object.keys(require.cache).filter((k) => k.endsWith("capture-preload.cjs"));',
      'console.log(JSON.stringify({ loaded, heapMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576) }));',
    ].join('\n');
    const run = spawnSync(process.execPath, ['-e', probe], {
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as { loaded: string[]; heapMb: number };
    expect(out.loaded).toEqual([copy]);
    expect(out.heapMb).toBeLessThan(400);
  });
});

describe('PATH wrapper argv (03:119)', () => {
  it('node + shim + wrap flag + one base64url word carrying tool, real argv and asked subcommands', () => {
    const spec = { tool: 'go', real: ['C:\\Go\\bin\\go.exe'], ask: ['test', 'vet'] };
    const argv = captureWrapperArgv('/usr/bin/node', spec);
    expect(argv.slice(0, 3)).toEqual(['/usr/bin/node', CAPTURE_SHIM, CAPTURE_WRAP_FLAG]);
    expect(argv[3]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(argv[3]!, 'base64url').toString('utf8'))).toEqual(spec);
  });

  it('the wrapped tools: checks of go/cargo/dotnet/gradle/mvn by subcommand, pytest always', () => {
    expect(CAPTURE_TOOLS.map((t) => t.tool)).toEqual([
      'go',
      'cargo',
      'dotnet',
      'gradle',
      'mvn',
      'pytest',
    ]);
    expect(CAPTURE_TOOLS.find((t) => t.tool === 'go')!.ask).not.toContain('build');
    expect(CAPTURE_TOOLS.find((t) => t.tool === 'pytest')!.ask).toBe('*');
  });
});
