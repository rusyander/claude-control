import type { CheckEntry, KeyParts } from '@agentdeck/contracts/core/records';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { newId } from '../../lib/ids/uuidv7.ts';
import { addDetachedWorktree } from '../../platform/git.ts';
import { keyFromParts } from '../key/index.ts';
import { findVitestEntry } from '../mutate/vitest-runner.ts';
import { runCheck } from '../run/run.ts';
import { createRecordStore } from '../store/index.ts';
import { proveRedBefore, type ProveSide } from './prove.ts';

/**
 * P94 на настоящем пути: одноразовый git-репозиторий (база с багом, финал с исправлением и
 * регрессионными тестами), копия базы — `git worktree add --detach` зоны A с файлом теста из
 * финала, прогон — `runCheck` зоны C под арендой, записи — подписанное хранилище зоны A, решение —
 * `decideRedBefore`. Узкий прогон — по файлу (`{files}`) и имени (`-t {tests}`): полное имя «a > b»
 * разворачивается в форму vitest (через пробел), а зелёный без выполненного теста — не зелёный.
 */

const roots: string[] = [];
const temp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), name));
  roots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};

function pinned(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP'])
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  return env;
}

const parts = (side: string): KeyParts => ({
  v: 1,
  checkId: 'tests',
  entryHash: 'e'.repeat(64),
  unit: '.',
  selection: [side],
  closure: 'c'.repeat(64),
  machinery: 'd'.repeat(64),
  base: null,
  inputs: 'f'.repeat(64),
  tools: {},
  env: {},
});
let keySeq = 0;
const side = (dir: string): ProveSide => {
  keySeq += 1;
  const p = parts(String(keySeq));
  return { dir, key: keyFromParts(p), parts: p };
};

const TESTS = {
  // ловит баг: на базе падает на своём утверждении
  'regress.test.mjs': [
    "import { add } from './src/sum.mjs';",
    "describe('sum', () => { it('adds', () => { expect(add(1, 2)).toBe(3); }); });",
  ],
  // бага не ловит: зелёный и на базе
  'weak.test.mjs': [
    "import { add } from './src/sum.mjs';",
    "describe('sum', () => { it('is a number', () => { expect(typeof add(1, 2)).toBe('number'); }); });",
  ],
  // на базе модуля нет — ошибка сборки, не красный на утверждении
  'fresh.test.mjs': [
    "import { mul } from './src/mul.mjs';",
    "describe('mul', () => { it('muls', () => { expect(mul(2, 3)).toBe(6); }); });",
  ],
};

describe('verifier/red proveRedBefore on the core runner (P94, real git + vitest)', () => {
  it('proven / green-on-base / no-verdict-engine, each from two signed records in the store', async () => {
    const vitest = findVitestEntry(dirname(fileURLToPath(import.meta.url)));
    expect(vitest).toBeDefined();
    const repo = temp('p94-repo-');
    git(repo, 'init', '-q');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'sum.mjs'), 'export const add = (a, b) => a - b;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'sum.mjs'), 'export const add = (a, b) => a + b;\n');
    writeFileSync(join(repo, 'src', 'mul.mjs'), 'export const mul = (a, b) => a * b;\n');
    for (const [file, lines] of Object.entries(TESTS))
      writeFileSync(join(repo, file), `${lines.join('\n')}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'fix');

    const baseDir = join(temp('p94-wt-'), 'base');
    const added = await addDetachedWorktree(repo, baseDir, baseSha);
    expect(added).toMatchObject({ created: baseDir, head: baseSha });
    for (const file of Object.keys(TESTS)) copyFileSync(join(repo, file), join(baseDir, file));

    const entry: CheckEntry = {
      id: 'tests',
      class: 'test-runner',
      argv: [process.execPath, vitest!, 'run', '--globals', '--root', '.'],
      cwd: '',
      unit: 'project',
      requiredAt: ['publish'],
      baseDependent: false,
      filter: {
        kind: 'vitest',
        argv: [
          process.execPath,
          vitest!,
          'run',
          '{files}',
          '--globals',
          '--root',
          '.',
          '-t',
          '{tests}',
        ],
      },
      inputs: [],
      envAllow: [],
      tools: [],
      artifacts: [],
      needs: [],
      source: 'detected',
    };
    const store = createRecordStore({ root: temp('p94-store-'), key: Buffer.alloc(32, 7) });
    const runTemp = temp('p94-tmp-');
    const deps = {
      run: (spec: Parameters<typeof runCheck>[0]) =>
        runCheck(
          spec,
          { leaseId: 'lease-p94', beatMs: 1_000, heartbeat: () => 'ok' as const },
          { now: Date.now, standEpoch: () => null },
        ),
      store,
      now: Date.now,
      newId,
    };
    const prove = (file: string, name: string) =>
      proveRedBefore(
        {
          test: { file, name },
          entry,
          unit: '.',
          base: side(baseDir),
          final: side(repo),
          taskId: null,
          env: pinned(),
          tempRoot: runTemp,
          deadlineMs: 120_000,
        },
        deps,
      );

    const proven = await prove('regress.test.mjs', 'sum > adds');
    expect(proven).toMatchObject({ value: { outcome: 'proven', test: 'sum > adds' } });
    const ids = 'value' in proven ? proven.value : null;
    const baseRec = store.record(ids!.base);
    expect(baseRec).toMatchObject({
      value: { grade: 'base', verdict: { kind: 'fail', reason: 'red' }, origin: 'core' },
    });
    expect('value' in baseRec && baseRec.value.failing.map((f) => f.name)).toContain('sum > adds');
    expect(store.record(ids!.final)).toMatchObject({
      value: { grade: 'narrow', verdict: { kind: 'pass' } },
    });

    expect(await prove('weak.test.mjs', 'sum > is a number')).toMatchObject({
      value: { outcome: 'green-on-base' },
    });
    expect(await prove('fresh.test.mjs', 'mul > muls')).toMatchObject({
      value: { outcome: 'no-verdict-engine' },
    });
    git(repo, 'worktree', 'remove', '--force', baseDir);
  }, 240_000);
});
