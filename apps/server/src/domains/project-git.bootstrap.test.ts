import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WorktreeBootstraps,
  bootstrapPlanFor,
  detectBootstrapPlan,
  isHeavyPlan,
} from './project-git.ts';
import { logTail } from './project-git/bootstrap.ts';
import { parseChurn, revertLockfileChurn } from './project-git/lockfiles.ts';

/**
 * Бутстрап копии (T5): выбор команды — на файлах, запуск — на настоящих
 * процессах `node -e`, потому что таймаут, код выхода и лог подделкой не
 * доказываются. Команды короткие: тест не ставит зависимостей.
 */

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

const NODE = process.execPath.includes(' ') ? `"${process.execPath}"` : process.execPath;

const NPM_CI = 'npm ci --prefer-offline --no-audit --no-fund';
const PNPM_I = 'pnpm install --frozen-lockfile --prefer-offline';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

describe('detectBootstrapPlan: по lock-файлу в корне и на первом уровне', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-boot-detect-'));
  });
  afterEach(() => dropTemp(dir));

  it('pnpm / npm / yarn — своя команда, без lock-файла — ничего', () => {
    expect(detectBootstrapPlan(dir)).toBeUndefined();
    writeFileSync(join(dir, 'yarn.lock'), '');
    expect(detectBootstrapPlan(dir)?.summary).toBe('yarn install --immutable');
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    expect(detectBootstrapPlan(dir)?.summary).toBe(NPM_CI);
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    expect(detectBootstrapPlan(dir)?.summary).toBe(PNPM_I);
    expect(isHeavyPlan(detectBootstrapPlan(dir))).toBe(false);
  });

  it('настроенная команда сильнее автоопределения, пустая — «определи сама»', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    expect(bootstrapPlanFor(dir, '  make setup  ')?.summary).toBe('make setup');
    expect(bootstrapPlanFor(dir, '   ')?.summary).toBe(PNPM_I);
    expect(bootstrapPlanFor(dir, undefined)?.summary).toBe(PNPM_I);
  });

  it('в корне нет — по цепочке на каталог первого уровня, служебные мимо (Д13)', () => {
    mkdirSync(join(dir, 'web'));
    writeFileSync(join(dir, 'web', 'pnpm-lock.yaml'), '');
    mkdirSync(join(dir, 'admin'));
    writeFileSync(join(dir, 'admin', 'package-lock.json'), '{}');
    mkdirSync(join(dir, 'backend'));
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'yarn.lock'), '');
    mkdirSync(join(dir, '.cache'));
    writeFileSync(join(dir, '.cache', 'yarn.lock'), '');
    mkdirSync(join(dir, 'web', 'deep'));
    writeFileSync(join(dir, 'web', 'deep', 'yarn.lock'), '');

    const plan = detectBootstrapPlan(dir);
    expect(plan?.chains.map((chain) => chain.cwd)).toEqual(['admin', 'web']);
    expect(plan?.summary).toBe(`[admin] ${NPM_CI} · [web] ${PNPM_I}`);
    expect(isHeavyPlan(plan)).toBe(true);
    // Lock-файл в корне сильнее вложенных: корень — это и есть проект.
    writeFileSync(join(dir, 'yarn.lock'), '');
    expect(detectBootstrapPlan(dir)?.summary).toBe('yarn install --immutable');
  });

  it('локальная библиотека с несобранным входом собирается, соседи её ждут', () => {
    for (const name of ['lib', 'app', 'e2e', 'web']) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, name === 'web' ? 'pnpm-lock.yaml' : 'package-lock.json'), '{}');
    }
    writeJson(join(dir, 'lib', 'package.json'), {
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './x/*': './dist/*',
      },
      scripts: { build: 'vite build' },
    });
    writeJson(join(dir, 'app', 'package.json'), {
      dependencies: { lib: 'file:../lib', outside: 'file:../../elsewhere', react: '^18' },
    });
    writeJson(join(dir, 'web', 'package.json'), { dependencies: { lib: 'link:../lib' } });
    writeJson(join(dir, 'e2e', 'package.json'), { devDependencies: {} });

    const plan = detectBootstrapPlan(dir);
    const byDir = Object.fromEntries((plan?.chains ?? []).map((chain) => [chain.cwd, chain]));
    expect(byDir.lib?.steps.map((step) => step.command)).toEqual([NPM_CI, 'npm run build']);
    // Собираемая — первой; npm-сосед не ждёт (ставит ссылку), pnpm-сосед ждёт (кладёт копию).
    expect(plan?.chains[0]?.cwd).toBe('lib');
    expect(byDir.app?.after).toEqual([]);
    expect(byDir.web?.after).toEqual(['lib']);
    expect(byDir.app?.steps).toHaveLength(1);
    expect(byDir.e2e?.after).toEqual([]);

    // Вход собран (как в основной копии) — сборки нет, ждать некого.
    mkdirSync(join(dir, 'lib', 'dist'));
    writeFileSync(join(dir, 'lib', 'dist', 'index.d.ts'), '');
    writeFileSync(join(dir, 'lib', 'dist', 'index.js'), '');
    const built = detectBootstrapPlan(dir);
    expect(built?.chains.find((chain) => chain.cwd === 'lib')?.steps).toHaveLength(1);
    expect(built?.chains.find((chain) => chain.cwd === 'web')?.after).toEqual([]);
  });

  /**
   * Живой прогон 24.09.2026: сводка подготовки считалась по ОСНОВНОЙ копии, где
   * `dist` общей библиотеки собран руками, — сборка из плана пропадала, хотя в
   * свежую копию `dist` не приезжает (он в `.gitignore`). Репозиторий настоящий:
   * вопрос именно в том, что git отдаст копии.
   */
  it('основная копия с собранным, но не отслеживаемым входом — план как у свежей копии', () => {
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    for (const name of ['lib', 'app']) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'package-lock.json'), '{}');
    }
    writeJson(join(dir, 'lib', 'package.json'), {
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      scripts: { build: 'vite build' },
    });
    writeJson(join(dir, 'app', 'package.json'), { dependencies: { lib: 'file:../lib' } });
    writeFileSync(join(dir, '.gitignore'), 'dist/\n');
    git('init', '-b', 'main');
    git('config', 'user.email', 'probe@example.com');
    git('config', 'user.name', 'probe');
    git('add', '.');
    git('commit', '-m', 'init');
    mkdirSync(join(dir, 'lib', 'dist'));
    writeFileSync(join(dir, 'lib', 'dist', 'index.d.ts'), '');
    writeFileSync(join(dir, 'lib', 'dist', 'index.js'), '');

    const plan = detectBootstrapPlan(dir);
    expect(plan?.chains.find((chain) => chain.cwd === 'lib')?.steps.map((s) => s.command)).toEqual([
      NPM_CI,
      'npm run build',
    ]);
    expect(plan?.summary).toContain(
      '[lib] npm ci --prefer-offline --no-audit --no-fund && npm run build',
    );
    expect(isHeavyPlan(plan)).toBe(true);

    // Вход закоммичен — копия получит его из git, собирать нечего.
    writeFileSync(join(dir, '.gitignore'), '');
    git('add', '.');
    git('commit', '-m', 'dist in git');
    expect(
      detectBootstrapPlan(dir)?.chains.find((chain) => chain.cwd === 'lib')?.steps,
    ).toHaveLength(1);
  });
});

describe('WorktreeBootstraps.run: план настоящими процессами', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-boot-plan-'));
    mkdirSync(join(dir, 'a'));
    mkdirSync(join(dir, 'b'));
    mkdirSync(join(dir, 'c'));
  });
  afterEach(() => dropTemp(dir));

  const node = (code: string): string => `${NODE} -e "${code}"`;
  // Ждёт файл до 8 с и падает, если не дождался: так видно, что цепочки шли РАЗОМ.
  const waitFor = (file: string): string =>
    node(
      `const f=require('fs');const t=Date.now();(function w(){if(f.existsSync('${file}'))process.exit(0);if(Date.now()-t>8000)process.exit(7);setTimeout(w,50)})()`,
    );
  const touch = (file: string): string => node(`require('fs').writeFileSync('${file}','')`);
  const step = (cwd: string, command: string) => ({ cwd, command });

  it('цепочки идут параллельно, зависимая ждёт свою, каждая в своём каталоге', async () => {
    const runner = new WorktreeBootstraps(join(dir, '.logs'), { timeoutMs: 30_000 });
    const state = await runner.run(dir, {
      summary: 'plan',
      chains: [
        // a ждёт отметку b: без параллельного запуска упала бы по таймауту ожидания.
        {
          cwd: 'a',
          steps: [step('a', waitFor('../b/started')), step('a', touch('done'))],
          after: [],
        },
        {
          cwd: 'b',
          steps: [step('b', touch('started')), step('b', waitFor('../a/done'))],
          after: [],
        },
        // c стартует только после a: отметка a уже должна лежать.
        {
          cwd: 'c',
          steps: [step('c', node(`process.exit(require('fs').existsSync('../a/done')?0:9)`))],
          after: ['a'],
        },
      ],
    });

    expect(state.status).toBe('ok');
    expect(state.exitCode).toBe(0);
    expect(state.command).toBe('plan');
    const log = runner.log(dir);
    expect(log).toContain('[a] $ ');
    expect(log).toContain('[c] ');
  });

  it('провал шага: код в состоянии, хвост цепочки пропущен, соседняя доходит', async () => {
    const runner = new WorktreeBootstraps(join(dir, '.logs'), { timeoutMs: 30_000 });
    const state = await runner.run(dir, {
      summary: 'plan',
      chains: [
        {
          cwd: 'a',
          steps: [step('a', node('process.exit(4)')), step('a', touch('after-fail'))],
          after: [],
        },
        { cwd: 'b', steps: [step('b', touch('ok'))], after: ['a'] },
      ],
    });

    expect(state.status).toBe('failed');
    expect(state.exitCode).toBe(4);
    expect(existsSync(join(dir, 'a', 'after-fail'))).toBe(false);
    expect(existsSync(join(dir, 'b', 'ok'))).toBe(true);
  });
});

describe('revertLockfileChurn: корень и первый уровень', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-boot-churn-'));
  });
  afterEach(() => dropTemp(dir));

  it('откатывает переписанные lock-файлы в корне и в каталоге первого уровня, глубже — нет', async () => {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    run('init', '-q');
    mkdirSync(join(dir, 'web', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'package-lock.json'), 'root');
    writeFileSync(join(dir, 'web', 'pnpm-lock.yaml'), 'web');
    writeFileSync(join(dir, 'web', 'deep', 'yarn.lock'), 'deep');
    run('add', '-A');
    run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

    writeFileSync(join(dir, 'package-lock.json'), 'rewritten');
    writeFileSync(join(dir, 'web', 'pnpm-lock.yaml'), 'rewritten');
    writeFileSync(join(dir, 'web', 'deep', 'yarn.lock'), 'rewritten');
    writeFileSync(join(dir, 'web', 'yarn.lock'), 'new');

    const reverted = await revertLockfileChurn(dir);

    expect([...reverted].sort()).toEqual([
      'package-lock.json',
      'web/pnpm-lock.yaml',
      'web/yarn.lock',
    ]);
    expect(readFileSync(join(dir, 'package-lock.json'), 'utf8')).toBe('root');
    expect(readFileSync(join(dir, 'web', 'pnpm-lock.yaml'), 'utf8')).toBe('web');
    expect(existsSync(join(dir, 'web', 'yarn.lock'))).toBe(false);
    expect(readFileSync(join(dir, 'web', 'deep', 'yarn.lock'), 'utf8')).toBe('rewritten');
  });
});

describe('logTail', () => {
  it('режет с начала целой строки', () => {
    const text = `${'a'.repeat(50)}\n${'b'.repeat(50)}\n${'c'.repeat(50)}`;
    const tail = logTail(text, 80);
    expect(tail.startsWith('c')).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(80);
    expect(logTail('short', 80)).toBe('short');
  });
});

describe('parseChurn: разбор porcelain для lock-файлов', () => {
  it('отслеживаемые и новые файлы различаются', () => {
    expect(parseChurn(' M package-lock.json\0?? bun.lock\0')).toEqual([
      { path: 'package-lock.json', tracked: true },
      { path: 'bun.lock', tracked: false },
    ]);
    expect(parseChurn('')).toEqual([]);
  });
});

describe('WorktreeBootstraps: настоящие процессы', () => {
  let logs: string;
  let copy: string;

  beforeEach(() => {
    logs = mkdtempSync(join(tmpdir(), 'cc-boot-logs-'));
    copy = mkdtempSync(join(tmpdir(), 'cc-boot-copy-'));
  });
  afterEach(() => {
    dropTemp(logs);
    dropTemp(copy);
  });

  it('удачная команда: ok, лог на диске, запись переживает новый экземпляр', async () => {
    const boots = new WorktreeBootstraps(logs);
    expect(boots.status(copy)).toBeUndefined();

    const done = await boots.run(copy, `${NODE} -e "console.log('BOOT-OK')"`);
    expect(done.status).toBe('ok');
    expect(done.exitCode).toBe(0);
    expect(done.logTail).toContain('BOOT-OK');
    expect(done.finishedAt).toBeDefined();
    expect(existsSync(boots.logPath(copy))).toBe(true);
    expect(readFileSync(boots.logPath(copy), 'utf8')).toContain('BOOT-OK');
    expect(boots.log(copy)).toContain('BOOT-OK');

    const fresh = new WorktreeBootstraps(logs);
    expect(fresh.status(copy)).toMatchObject({ status: 'ok', exitCode: 0 });
  });

  it('после команды идёт откат lock-файлов: список в состоянии и в логе', async () => {
    const boots = new WorktreeBootstraps(logs, {
      afterRun: async () => ['package-lock.json'],
    });
    const done = await boots.run(copy, `${NODE} -e "process.exit(2)"`);
    expect(done.status).toBe('failed');
    expect(done.reverted).toEqual(['package-lock.json']);
    expect(done.logTail).toContain('lock-файлы откачены: package-lock.json');
    // Перезапуск панели не должен стирать факт, что панель трогала файлы в
    // рабочем дереве: состояние читается с диска, и откат обязан пережить это.
    const restarted = new WorktreeBootstraps(logs);
    expect(restarted.status(copy)?.reverted).toEqual(['package-lock.json']);
    // Отказ отката не портит итог команды.
    const fragile = new WorktreeBootstraps(logs, {
      afterRun: async () => {
        throw new Error('git не ответил');
      },
    });
    const ok = await fragile.run(copy, `${NODE} -e "console.log('fine')"`);
    expect(ok.status).toBe('ok');
    expect(ok.reverted).toBeUndefined();
  });

  it('ненулевой код — failed с кодом, а не исключение', async () => {
    const boots = new WorktreeBootstraps(logs);
    const done = await boots.run(copy, `${NODE} -e "console.error('boom'); process.exit(3)"`);
    expect(done.status).toBe('failed');
    expect(done.exitCode).toBe(3);
    expect(done.logTail).toContain('boom');
  });

  it('потолок времени останавливает процесс и помечает timedOut', async () => {
    const boots = new WorktreeBootstraps(logs, { timeoutMs: 400 });
    const done = await boots.run(copy, `${NODE} -e "setTimeout(() => {}, 20000)"`);
    expect(done.status).toBe('failed');
    expect(done.timedOut).toBe(true);
    expect(done.logTail).toContain('потолок');
  }, 10_000);

  it('повторный запуск поверх идущего возвращает тот же результат', async () => {
    const boots = new WorktreeBootstraps(logs);
    const first = boots.run(copy, `${NODE} -e "setTimeout(() => console.log('one'), 200)"`);
    expect(boots.isRunning(copy)).toBe(true);
    expect(boots.status(copy)?.status).toBe('running');
    const second = boots.run(copy, `${NODE} -e "console.log('two')"`);
    expect(second).toBe(first);
    const done = await first;
    expect(done.logTail).toContain('one');
    expect(done.logTail).not.toContain('two');
    expect(boots.isRunning(copy)).toBe(false);
  });

  it('запись «идёт» без процесса (перезапуск панели) читается как провал', () => {
    const boots = new WorktreeBootstraps(logs);
    const slug = boots.slugFor(copy);
    writeFileSync(
      join(logs, `${slug}.json`),
      JSON.stringify({
        command: 'pnpm install',
        status: 'running',
        startedAt: '2026-09-09T10:00:00.000Z',
        logTail: 'Progress: 10/200',
      }),
    );
    const state = boots.status(copy);
    expect(state?.status).toBe('failed');
    expect(state?.logTail).toContain('перезапущена');
    expect(state?.finishedAt).toBeDefined();
  });

  it('несуществующая команда — failed, а не исключение', async () => {
    const boots = new WorktreeBootstraps(logs);
    const done = await boots.run(copy, 'definitely-no-such-command-xyz');
    expect(done.status).toBe('failed');
  });
});
