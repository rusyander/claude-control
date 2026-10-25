import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Дыры ключа журнала проверок, найденные на группе №1 24.10.
 * - Собранный выход соседа по `file:` (`shared-ui/dist`, вне git) в ключ потребителя не входил:
 *   зелёный tsc, записанный при одном `dist`, годился и для другого (TS2305 на устаревшем dist).
 * - Список файлов eslint/prettier от скриптов проекта приходит в нестабильном порядке: те же
 *   87 файлов в другом порядке давали новый ключ и промах.
 * Монорепо в temp с настоящим git и настоящим `--require` preload; снаружи подменены сами
 * tsc и eslint — поддельные, считают свои настоящие запуски. `VL_DIR` — журнал под проверкой.
 */
const DIR = process.env.VL_DIR
  ? resolve(process.env.VL_DIR)
  : resolve(__dirname, '../../../../../tools/verify-ledger');
const PRELOAD = join(DIR, 'preload.cjs').replace(/\\/g, '/');

/** Поддельный tsc: читает типы соседа так, как их читает настоящий, — из его `dist`. */
const FAKE_TSC = `
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_COUNT, 'x');
const types = fs.readFileSync('../shared-ui/dist/index.d.ts', 'utf8');
if (!types.includes('createRefetchUnlessFresh')) {
  console.log("error TS2305: '@x/shared-ui' has no exported member 'createRefetchUnlessFresh'");
  process.exit(2);
}
console.log('PASS tsc');
`;
const FAKE_ESLINT = `
require('node:fs').appendFileSync(process.env.FAKE_COUNT, 'x');
console.log('PASS eslint');
`;

let root: string;
let repo: string;
let consumer: string;
let home: string;
let count: string;

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function put(rel: string, body: string) {
  const file = join(repo, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-ledger-gaps-'));
  repo = join(root, 'repo');
  consumer = join(repo, 'consumer');
  home = join(root, 'home');
  count = join(root, 'count.txt');
  mkdirSync(repo, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  put('.gitignore', 'node_modules/\ndist/\n');
  put('package.json', '{"name":"mono","private":true}\n');
  put(
    'shared-ui/package.json',
    '{"name":"@x/shared-ui","types":"dist/index.d.ts","main":"dist/index.js","exports":{".":{"types":"./dist/index.d.ts","import":"./dist/index.js"}}}\n',
  );
  put('shared-ui/src/index.ts', 'export const createRefetchUnlessFresh = 1;\n');
  put('shared-ui/dist/index.d.ts', 'export declare const createRefetchUnlessFresh: number;\n');
  put('shared-ui/dist/index.js', 'export const createRefetchUnlessFresh = 1;\n');
  put(
    'consumer/package.json',
    '{"name":"consumer","private":true,"dependencies":{"@x/shared-ui":"file:../shared-ui"}}\n',
  );
  put('consumer/src/a.ts', 'export const a = 1;\n');
  put('consumer/node_modules/typescript/bin/tsc', FAKE_TSC);
  put('consumer/node_modules/eslint/bin/eslint.js', FAKE_ESLINT);
  git('add', '-A');
  git('commit', '-qm', 'init');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'NODE_OPTIONS' || k.startsWith('AGENTDECK_VERIFY_LEDGER')) continue;
    env[k] = v;
  }
  return env;
}

function tool(script: string, args: string[]) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: consumer,
    encoding: 'utf8',
    env: {
      ...baseEnv(),
      NODE_OPTIONS: `--require "${PRELOAD}"`,
      AGENTDECK_VERIFY_LEDGER_HOME: home,
      AGENTDECK_VERIFY_LEDGER: 'on',
      FAKE_COUNT: count,
    },
    timeout: 60_000,
  });
  return {
    code: r.status,
    out: r.stdout,
    err: r.stderr,
    reused: r.stderr.includes('[verify-ledger] reused green'),
  };
}
const tsc = (...args: string[]) => tool('node_modules/typescript/bin/tsc', ['--noEmit', ...args]);
const eslint = (...args: string[]) => tool('node_modules/eslint/bin/eslint.js', args);
const realRuns = () => (existsSync(count) ? readFileSync(count, 'utf8').length : 0);

describe('журнал проверок: дыры ключа группы №1', () => {
  it('F4: собранный dist соседа по file: — в ключе потребителя, устаревший dist не повторяет зелёный', () => {
    expect(tsc().code).toBe(0);
    expect(tsc().reused).toBe(true);
    expect(realRuns()).toBe(1);
    // Меняется только неотслеживаемый `dist` соседа — дерево git то же.
    put('shared-ui/dist/index.d.ts', 'export declare const somethingElse: number;\n');
    expect(git('status', '--porcelain')).toBe('');
    const stale = tsc();
    expect(stale.reused, stale.err).toBe(false);
    expect(stale.code).toBe(2);
    expect(stale.out).toContain('TS2305');
    expect(realRuns()).toBe(2);
  });

  it('F5: тот же набор файлов eslint в другом порядке — повтор; другой набор — прогон', () => {
    const flags = [
      '--cache',
      '--cache-location',
      'node_modules/.cache/eslint/',
      '--no-warn-ignored',
    ];
    expect(eslint(...flags, 'src/a.ts', 'src/b.ts', 'src/c.ts').code).toBe(0);
    const permuted = eslint(...flags, 'src/c.ts', 'src/a.ts', 'src/b.ts');
    expect(permuted.reused, permuted.err).toBe(true);
    expect(realRuns()).toBe(1);
    expect(eslint(...flags, 'src/a.ts', 'src/b.ts').reused).toBe(false);
    expect(realRuns()).toBe(2);
    // Значение ключа — не файл списка: `--cache-location X a` и `--cache-location a X` — разные.
    expect(eslint('--cache-location', 'src/a.ts', 'src/b.ts').code).toBe(0);
    expect(eslint('--cache-location', 'src/b.ts', 'src/a.ts').reused).toBe(false);
    expect(realRuns()).toBe(4);
  });

  it('F5: tsc порядок аргументов сохраняет — перестановка даёт прогон', () => {
    expect(tsc('src/a.ts', 'src/b.ts').code).toBe(0);
    expect(tsc('src/b.ts', 'src/a.ts').reused).toBe(false);
    expect(realRuns()).toBe(2);
  });
});
