import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Окружение в ключе журнала проверок (24.10, ложный зелёный: прогон мутанта через хук
 * загрузки получил записанный зелёный прогона-тождества — окружение в ключ не входило).
 * Тот же запуск дважды: второй — с мутантом, который валит проверку, через окружение,
 * ключ node, переменную, которую читает конфиг, или PATH. Второй обязан ИДТИ и краснеть,
 * а не повторять зелёный. Живые процессы node с настоящим `--require` preload и
 * настоящим git; снаружи подменён только сам vitest — поддельный, грузит конфиг пакета и
 * считает свои настоящие запуски. `VL_DIR` — каталог журнала под проверкой («красное до»).
 */
const DIR = process.env.VL_DIR
  ? resolve(process.env.VL_DIR)
  : resolve(__dirname, '../../../../../tools/verify-ledger');
const PRELOAD = join(DIR, 'preload.cjs').replace(/\\/g, '/');

/** Поддельный vitest: конфиг пакета, затем вердикт; мутант ставит глобальный флаг. */
const FAKE_VITEST = `
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
if (fs.existsSync('vitest.config.mjs')) {
  const cfg = await import(pathToFileURL('vitest.config.mjs').href);
  if (cfg.default) await cfg.default();
}
fs.appendFileSync(process.env.FAKE_COUNT, 'x');
if (process.env.FAKE_SPAWN_NPX) {
  const r = spawnSync('npx', ['--version'], { shell: true, encoding: 'utf8' });
  if (r.status !== 0) { console.log('FAIL npx from PATH'); process.exit(1); }
}
if (globalThis.__MUTANT__) { console.log('FAIL mutant alive'); process.exit(1); }
console.log('PASS ' + fs.readFileSync('src.ts', 'utf8').trim());
`;
/** Конфиг пакета: подгружает хук из переменной окружения — как обвязка мутаций. */
const CONFIG = `import { pathToFileURL } from 'node:url';
export default async () => {
  if (process.env.MUT_HOOK) await import(pathToFileURL(process.env.MUT_HOOK).href);
};
`;
const HOOK = 'globalThis.__MUTANT__ = true;\n';

let root: string;
let repo: string;
let home: string;
let count: string;
let hooks: string;

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-ledger-env-'));
  repo = join(root, 'repo');
  home = join(root, 'home');
  count = join(root, 'count.txt');
  // Хуки — вне дерева, как временный каталог инструмента мутаций; один — в каталоге,
  // в имени которого есть `verify-ledger`: его обязан не спутать со своим preload.
  hooks = join(root, 'verify-ledger-mutants');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'hook.mjs'), HOOK);
  writeFileSync(join(hooks, 'hook.cjs'), HOOK);
  mkdirSync(join(repo, 'node_modules/vitest'), { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'package.json'), '{"name":"app","private":true}\n');
  writeFileSync(join(repo, 'src.ts'), 'A\n');
  writeFileSync(join(repo, 'vitest.config.mjs'), CONFIG);
  writeFileSync(join(repo, 'node_modules/vitest/vitest.mjs'), FAKE_VITEST);
  git('add', '-A');
  git('commit', '-qm', 'init');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Окружение без журнала снаружи: тест не должен зависеть от того, кто его запустил. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'NODE_OPTIONS' || k.startsWith('AGENTDECK_VERIFY_LEDGER')) continue;
    env[k] = v;
  }
  return env;
}

function vitest(opts: { env?: NodeJS.ProcessEnv; nodeArgs?: string[]; nodeOptions?: string } = {}) {
  const r = spawnSync(
    process.execPath,
    [...(opts.nodeArgs ?? []), 'node_modules/vitest/vitest.mjs', 'run'],
    {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...baseEnv(),
        NODE_OPTIONS: `--require "${PRELOAD}"${opts.nodeOptions ? ` ${opts.nodeOptions}` : ''}`,
        AGENTDECK_VERIFY_LEDGER_HOME: home,
        AGENTDECK_VERIFY_LEDGER: 'on',
        FAKE_COUNT: count,
        ...opts.env,
      },
      timeout: 60_000,
    },
  );
  return {
    code: r.status,
    out: r.stdout,
    err: r.stderr,
    // Оба пути повтора: запись по ключу и сужение vitest «ничего не изменилось» (24.10 —
    // ложный зелёный шёл именно сужением: ключ семейства тоже без окружения).
    reused:
      r.stderr.includes('[verify-ledger] reused green') ||
      /\[verify-ledger\] nothing the tests can see changed since green .*; reused/.test(r.stderr),
  };
}
const realRuns = () => (existsSync(count) ? readFileSync(count, 'utf8').length : 0);
const hookUrl = (name: string) => pathToFileURL(join(hooks, name)).href;
const hookPath = (name: string) => join(hooks, name).replace(/\\/g, '/');

/** Тождество зелёное и записано; затем прогон с мутантом обязан идти и краснеть. */
function expectMutantRuns(mutant: Parameters<typeof vitest>[0]) {
  const identity = vitest();
  expect(identity.code).toBe(0);
  expect(identity.out).toContain('PASS A');
  // Тот же запуск без мутанта повторяется — журнал вообще работает на этом дереве.
  expect(vitest().reused).toBe(true);
  const run = vitest(mutant);
  expect(run.reused, run.err).toBe(false);
  expect(run.code, `${run.out}\n${run.err}`).toBe(1);
  expect(realRuns()).toBe(2);
}

describe('журнал проверок: окружение в ключе', () => {
  it('хук через NODE_OPTIONS --import — прогон, а не повтор зелёного', () => {
    expectMutantRuns({ nodeOptions: `--import ${hookUrl('hook.mjs')}` });
  });

  it('хук ключом node (--import) — прогон, а не повтор зелёного', () => {
    expectMutantRuns({ nodeArgs: ['--import', hookUrl('hook.mjs')] });
  });

  it('хук из переменной, которую читает конфиг проверки, — прогон, а не повтор', () => {
    expectMutantRuns({ env: { MUT_HOOK: join(hooks, 'hook.mjs') } });
    // Лента называет разошедшуюся переменную по имени, без значения.
    const feed = readFileSync(join(home, 'events.jsonl'), 'utf8');
    const drift = feed
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { envChanged?: string })
      .filter((e) => e.envChanged);
    expect(drift.map((e) => e.envChanged)).toEqual(['MUT_HOOK']);
    expect(feed).not.toContain(hooks.replace(/\\/g, '\\\\'));
  });

  it('хук --require из каталога с «verify-ledger» в имени — не свой preload, в ключе', () => {
    expectMutantRuns({ nodeOptions: `--require "${hookPath('hook.cjs')}"` });
  });

  it('то же ключом node — не срезается как свой preload', () => {
    expectMutantRuns({ nodeArgs: ['--require', hookPath('hook.cjs')] });
  });

  it('PATH: другой исполняемый файл под тем же именем — прогон, а не повтор', () => {
    const fake = join(root, 'fake-bin');
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, 'npx.cmd'), '@exit /b 3\r\n');
    writeFileSync(join(fake, 'npx'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    const env = { FAKE_SPAWN_NPX: '1' };
    expect(vitest({ env }).code).toBe(0);
    expect(vitest({ env }).reused).toBe(true);
    const path = `${fake}${delimiter}${process.env.PATH ?? ''}`;
    const run = vitest({ env: { ...env, PATH: path, Path: path } });
    expect(run.reused).toBe(false);
    expect(run.code).toBe(1);
  });

  it('свой preload в другой записи (`--require=` без кавычек) — тот же ключ, повтор', () => {
    expect(vitest().code).toBe(0);
    const r = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run'], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...baseEnv(),
        NODE_OPTIONS: `--require=${PRELOAD}`,
        AGENTDECK_VERIFY_LEDGER_HOME: home,
        AGENTDECK_VERIFY_LEDGER: 'on',
        FAKE_COUNT: count,
      },
      timeout: 60_000,
    });
    expect(r.stderr).toContain('[verify-ledger] reused green');
    expect(realRuns()).toBe(1);
  });

  it('local-overlay: бездействующий срезан, действующий — в ключе вместе с подменой', () => {
    const overlay = join(root, 'local-overlay', 'preload.cjs').replace(/\\/g, '/');
    mkdirSync(join(root, 'local-overlay'), { recursive: true });
    writeFileSync(overlay, '');
    const target = join(root, 'overlay-src.mjs');
    writeFileSync(target, 'export const v = 1;\n');
    const reg = join(root, 'registry.json');
    const env = { LOCAL_OVERLAY_REGISTRY: reg };
    const withOverlay = { env, nodeOptions: `--require "${overlay}"` };
    // Реестр без корня этого репозитория: overlay ничего не подменяет — как будто его нет.
    writeFileSync(reg, JSON.stringify({ roots: {} }));
    expect(vitest({ env }).code).toBe(0);
    expect(vitest(withOverlay).reused).toBe(true);
    // Корень покрывает репозиторий: с overlay подмена действует — другой прогон; без него
    // подмены нет, и это тот же прогон, что первый.
    const top = realpathSync.native(repo).replace(/\\/g, '/').toLowerCase();
    const map = { [`${top}/src.ts`]: { overlay: target, hash: null } };
    writeFileSync(reg, JSON.stringify({ roots: { [top]: map } }));
    expect(vitest(withOverlay).reused).toBe(false);
    expect(vitest(withOverlay).reused).toBe(true);
    expect(vitest({ env }).reused).toBe(true);
    // Правка файла подмены — прогон, а не повтор.
    writeFileSync(target, 'export const v = 2;\n');
    expect(vitest(withOverlay).reused).toBe(false);
    expect(realRuns()).toBe(3);
  });

  it('сессионные переменные агента ключ не меняют — повтор между сессиями цел', () => {
    expect(
      vitest({ env: { CLAUDE_CODE_SESSION_ID: 's1', CLAUDE_PID: '1', PWD: '/a', SHLVL: '1' } })
        .code,
    ).toBe(0);
    const other = vitest({
      env: {
        CLAUDE_CODE_SESSION_ID: 's2',
        CLAUDE_PID: '2',
        PWD: '/b',
        SHLVL: '3',
        VSCODE_PID: '9',
        EFC_1_2: 'x',
        AGENTDECK_GROUP_STAGE: 'deliver',
        npm_lifecycle_event: 'test',
        INIT_CWD: '/c',
      },
    });
    expect(other.reused).toBe(true);
    expect(realRuns()).toBe(1);
  });
});
