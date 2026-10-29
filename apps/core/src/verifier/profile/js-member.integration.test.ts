import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { currentOs } from '../../platform/os-kind.ts';
import { readRepoView } from '../../platform/repo-view.ts';
import { findVitestEntry } from '../mutate/vitest-runner.ts';
import { argvFor } from '../run/argv.ts';
import { runCheck } from '../run/run.ts';
import { narrowVerdict, verdictOf } from '../run/verdict.ts';
import { detectProfile } from './detect.ts';
import { PROFILE_VIEW_SPEC } from './inputs.ts';

/**
 * A2r3-Q03 на настоящем пути: рабочее пространство pnpm, vitest стоит ТОЛЬКО в члене (корень его не
 * знает). Профиль читается с диска (`readRepoView` → `detectProfile`), узкий прогон члена собирает
 * `argvFor` так же, как запрос проверки (единица, выборка, без файлов), и идёт настоящим `pnpm` через
 * `runCheck` из cwd записи (корень воркспейса). Из корня `pnpm exec vitest` не находит раннер
 * («Command "vitest" not found»); селектор пакета менеджера уводит команду в каталог члена.
 * vitest члена — ссылка на настоящий пакет ядра и свой bin-шим (POSIX sh + Windows .cmd).
 */

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function pinned(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'ComSpec',
    'APPDATA',
    'LOCALAPPDATA',
    'HOME',
    'USERPROFILE',
    'TEMP',
    'TMP',
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  // Сам прогон тестов ядра запущен через bin ядра: его `node_modules/.bin` в PATH нашёл бы vitest
  // из корня воркспейса и спрятал бы дефект. Раннер должен найтись только у члена.
  for (const name of ['PATH', 'Path'])
    if (env[name] !== undefined)
      env[name] = env[name]
        .split(delimiter)
        .filter((p) => !/node_modules/.test(p))
        .join(delimiter);
  // Сеть не участвует: pnpm, решивший доустановить зависимости, падает, а не тянет чужой vitest.
  env.npm_config_offline = 'true';
  return env;
}

/** Версия pnpm репозитория: под ней собран образ Linux (corepack) и стоит pnpm разработчика. */
function repoPackageManager(): string {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../../../../package.json'), 'utf8'),
  ) as { packageManager?: string };
  if (!manifest.packageManager) throw new Error('repo package.json declares no packageManager');
  return manifest.packageManager;
}

function memberOnlyWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ws-member-'));
  roots.push(root);
  const write = (rel: string, text: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  // packageManager закреплён: без него corepack взял бы последний pnpm из сети (на Linux — pnpm 12,
  // что доустановил vitest 5 сам и спрятал бы, чей раннер нашёлся).
  write(
    'package.json',
    JSON.stringify({ name: 'mono', private: true, packageManager: repoPackageManager() }),
  );
  write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  write(
    'packages/a/package.json',
    JSON.stringify({
      name: 'a',
      scripts: { test: 'vitest run' },
      devDependencies: { vitest: '*' },
    }),
  );
  write(
    'packages/a/src/a.test.ts',
    "import { describe, expect, it } from 'vitest';\n" +
      "describe('member', () => {\n  it('adds', () => expect(1 + 1).toBe(2));\n  it('other', () => expect(1).toBe(1));\n});\n",
  );
  const vitest = findVitestEntry(import.meta.dirname);
  if (!vitest) throw new Error('vitest of the core not found');
  mkdirSync(join(root, 'packages/a/node_modules'), { recursive: true });
  symlinkSync(
    realpathSync(dirname(vitest)),
    join(root, 'packages/a/node_modules/vitest'),
    'junction',
  );
  write('packages/a/node_modules/.bin/vitest.cmd', '@node "%~dp0/../vitest/vitest.mjs" %*\n');
  write(
    'packages/a/node_modules/.bin/vitest',
    '#!/bin/sh\nexec node "$(dirname "$0")/../vitest/vitest.mjs" "$@"\n',
  );
  chmodSync(join(root, 'packages/a/node_modules/.bin/vitest'), 0o755);
  return root;
}

describe('JS workspace member narrow run (A2r3-Q03, real pnpm)', () => {
  it('a member narrow run finds the vitest installed only in the member and runs just the selected test', async () => {
    const root = memberOnlyWorkspace();
    const view = await readRepoView(root, PROFILE_VIEW_SPEC);
    if (!('value' in view)) throw new Error(`view: ${JSON.stringify(view)}`);
    const entry = detectProfile(view.value, { os: currentOs() }).registry.checks.find(
      (c) => c.id === 'pkg:test',
    );
    expect(entry?.filter?.kind).toBe('vitest');
    const { argv, narrowed } = argvFor(entry!, {
      unit: 'a',
      selection: ['member > adds'],
      base: null,
      files: [],
    });
    expect(narrowed).toBe(true);
    const temp = join(root, '.run-tmp');
    const result = await runCheck(
      {
        checkRunId: 'member-narrow',
        taskId: 'task-member',
        entry: entry!,
        argv,
        cwd: entry!.cwd === '' ? root : join(root, entry!.cwd),
        env: pinned(),
        tempRoot: temp,
        deadlineMs: 120_000,
      },
      { leaseId: 'lease-member', beatMs: 1_000, heartbeat: () => 'ok' },
      { now: Date.now, standEpoch: () => null },
    );
    expect({ end: result.end, exit: result.exit }, result.log).toEqual({ end: 'exit', exit: 0 });
    // Только выбранный тест: сосед `member > other` под `-t` не гонится.
    expect(
      result.passing?.map((p) => p.name),
      result.log,
    ).toEqual(['member > adds']);
    expect(narrowVerdict(verdictOf(result), { kind: 'vitest', log: result.log }).verdict).toEqual({
      kind: 'pass',
    });
  }, 180_000);

  it('repo-relative {files} of a member narrow run are rebased to the member cwd and select only that file', async () => {
    const root = memberOnlyWorkspace();
    // Сосед с тем же именем теста: без выборки по файлу прогнались бы оба.
    writeFileSync(
      join(root, 'packages/a/src/b.test.ts'),
      "import { describe, expect, it } from 'vitest';\ndescribe('member', () => {\n  it('adds', () => expect(2).toBe(2));\n});\n",
    );
    const view = await readRepoView(root, PROFILE_VIEW_SPEC);
    if (!('value' in view)) throw new Error(`view: ${JSON.stringify(view)}`);
    const { registry } = detectProfile(view.value, { os: currentOs() });
    const entry = registry.checks.find((c) => c.id === 'pkg:test');
    expect(entry?.filter?.filesFrom).toBe('unit');
    // Каталог единицы — из реестра, как его берёт вызывающий.
    const unitDir = registry.units['a']?.paths[0];
    expect(unitDir).toBe('packages/a');
    const { argv } = argvFor(entry!, {
      unit: 'a',
      selection: ['member > adds'],
      base: null,
      files: ['packages/a/src/a.test.ts'],
      unitDir: unitDir!,
    });
    const result = await runCheck(
      {
        checkRunId: 'member-files',
        taskId: 'task-member',
        entry: entry!,
        argv,
        cwd: entry!.cwd === '' ? root : join(root, entry!.cwd),
        env: pinned(),
        tempRoot: join(root, '.run-tmp'),
        deadlineMs: 120_000,
      },
      { leaseId: 'lease-member', beatMs: 1_000, heartbeat: () => 'ok' },
      { now: Date.now, standEpoch: () => null },
    );
    expect({ end: result.end, exit: result.exit }, result.log).toEqual({ end: 'exit', exit: 0 });
    expect(
      result.passing?.map((p) => p.name),
      result.log,
    ).toEqual(['member > adds']);
  }, 180_000);
});
