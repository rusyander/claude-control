import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeBootstraps, type BootstrapPlan } from './bootstrap.ts';
import type { RuntimeDeps } from './runtimes.ts';

/**
 * Подготовка копии на версии рантайма проекта (T1/T8) и разбор её провала (T1):
 * настоящие процессы `node -e`, версии менеджеров подменены каталогами.
 */

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста не влияет.
  }
}

const NODE = process.execPath.includes(' ') ? `"${process.execPath}"` : process.execPath;

describe('подготовка копии: рантайм проекта и разбор провала', () => {
  let work: string;
  let copy: string;
  let home: string;
  let logs: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'cc-boot-rt-'));
    copy = join(work, 'copy');
    home = join(work, 'home');
    logs = join(work, 'logs');
    mkdirSync(copy);
    mkdirSync(home);
  });
  afterEach(() => dropTemp(work));

  /**
   * Окружение без менеджеров версий этой машины: настоящий nvm у разработчика
   * подмешал бы свои каталоги, и тест зависел бы от того, что у него стоит.
   */
  function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(NVM_|FNM_|VOLTA_|ASDF_|MISE_|NODENV_|N_PREFIX|XDG_DATA_HOME)/i.test(key))
        delete env[key];
    }
    return {
      ...env,
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'fnm-none'),
      ...extra,
    };
  }

  /** Машина «с Node 24 по умолчанию»; нужные версии лежат в каталогах менеджера. */
  function machine(defaultNode: string, env: NodeJS.ProcessEnv = cleanEnv()): RuntimeDeps {
    return {
      exec: async (file) => (file === 'node' ? `v${defaultNode}` : undefined),
      env,
      platform: process.platform,
      home,
    };
  }

  /** Установленная версия Node в каталоге `~/.nvm` (POSIX-раскладка; на Windows — fnm-раскладка). */
  function installNode(version: string): { env: NodeJS.ProcessEnv; dir: string } {
    const win = process.platform === 'win32';
    const dir = win
      ? join(home, 'fnm', 'node-versions', `v${version}`, 'installation')
      : join(home, '.nvm', 'versions', 'node', `v${version}`, 'bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, win ? 'node.exe' : 'node'), '');
    return { env: cleanEnv(win ? { FNM_DIR: join(home, 'fnm') } : {}), dir };
  }

  const FIRST_PATH_ENTRY = `${NODE} -p "process.env.PATH.split(require('path').delimiter)[0]"`;

  it('.nvmrc 22 при Node 24 по умолчанию: подготовка идёт с найденным 22 впереди PATH', async () => {
    writeFileSync(join(copy, '.nvmrc'), '22\n');
    const installed = installNode('22.22.2');
    const boots = new WorktreeBootstraps(logs, {
      runtimes: machine('24.13.0', installed.env),
    });
    const state = await boots.run(copy, FIRST_PATH_ENTRY);
    expect(state.status).toBe('ok');
    // Процесс получил PATH, где первый каталог — установленный Node 22: доказательство в его выводе.
    expect(state.logTail).toContain(installed.dir);
    expect(state.runtimes).toEqual([
      expect.objectContaining({
        tool: 'node',
        status: 'switched',
        used: '22.22.2',
        found: '24.13.0',
        source: '.nvmrc',
      }),
    ]);
    expect(boots.log(copy)).toContain('Node 22.22.2');
  });

  it('нужной версии на машине нет — группа это узнаёт, подготовка идёт на том, что есть', async () => {
    writeFileSync(join(copy, '.nvmrc'), '99\n');
    const boots = new WorktreeBootstraps(logs, { runtimes: machine('24.13.0') });
    const state = await boots.run(copy, `${NODE} -e "console.log('installed')"`);
    expect(state.status).toBe('ok');
    expect(state.runtimes).toEqual([
      expect.objectContaining({ tool: 'node', status: 'missing', wanted: '99', found: '24.13.0' }),
    ]);
    expect(boots.log(copy)).toContain('⚠ Node 99');
  });

  it('проект версий не просит — записи о рантайме нет и PATH не трогается', async () => {
    const boots = new WorktreeBootstraps(logs, { runtimes: machine('24.13.0') });
    const state = await boots.run(copy, `${NODE} -e "console.log('x')"`);
    expect(state.runtimes).toBeUndefined();
  });

  it('провал: в состоянии первая строка ошибки, хвост без предупреждений, полный лог — в файле', async () => {
    const script = [
      "for (let i = 0; i < 60; i++) console.error('npm warn EBAD' + 'ENGINE Unsupported engine ' + i)",
      "console.error('npm error code ELIFECYCLE')",
      'process.exit(2)',
    ].join(';');
    const boots = new WorktreeBootstraps(logs);
    const state = await boots.run(copy, `${NODE} -e "${script}"`);
    expect(state.status).toBe('failed');
    expect(state.exitCode).toBe(2);
    expect(state.firstError).toBe('npm error code ELIFECYCLE');
    expect(state.logTail).not.toContain('EBADENGINE');
    expect(state.logTail).toContain('npm error code ELIFECYCLE');
    expect(state.logFile).toBe(boots.logPath(copy));
    expect(readFileSync(state.logFile as string, 'utf8')).toContain(
      'EBADENGINE Unsupported engine 59',
    );
    // Запись переживает перезапуск панели вместе с новыми полями.
    const again = new WorktreeBootstraps(logs).status(copy);
    expect(again?.firstError).toBe('npm error code ELIFECYCLE');
    expect(again?.logFile).toBe(state.logFile);
  });
});

describe('мягкие цепочки: среда языка не проваливает подготовку', () => {
  let work: string;
  let copy: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'cc-boot-soft-'));
    copy = join(work, 'copy');
    mkdirSync(copy);
  });
  afterEach(() => dropTemp(work));

  const NODE_CMD = `${NODE} -e "console.log('deps ok')"`;
  const failingGo: RuntimeDeps = {
    exec: async (file) => (file === 'go' ? 'go version go1.25.3 linux/amd64' : undefined),
    env: process.env,
    platform: process.platform,
    home: tmpdir(),
  };

  it('провал Go-шага — строка в записи языка, итог подготовки остаётся ok', async () => {
    // go.mod с мусором: `go mod download` падает на любой машине (нет go — тоже падает).
    mkdirSync(join(copy, 'api'));
    writeFileSync(join(copy, 'api', 'go.mod'), 'this is not a go.mod\n');
    const plan: BootstrapPlan = {
      summary: 'npm + go',
      chains: [
        { cwd: '', steps: [{ cwd: '', command: NODE_CMD }], after: [] },
        {
          cwd: 'api',
          soft: true,
          after: [],
          steps: [{ cwd: 'api', command: 'go mod download', lang: 'go-download' }],
        },
      ],
    };
    const state = await new WorktreeBootstraps(join(work, 'logs'), { runtimes: failingGo }).run(
      copy,
      plan,
    );
    expect(state.status).toBe('ok');
    expect(state.exitCode).toBe(0);
    expect(state.runtimes).toEqual([
      expect.objectContaining({ tool: 'go', where: 'api', status: 'failed' }),
    ]);
    expect(state.runtimes?.[0]?.detail).toContain('go mod download');
  });

  it('мягкая цепочка, не уложившаяся в свой потолок, снимается, остальное и итог целы', async () => {
    const plan: BootstrapPlan = {
      summary: 'ok + slow',
      chains: [
        { cwd: '', steps: [{ cwd: '', command: NODE_CMD }], after: [] },
        {
          cwd: 'slow',
          soft: true,
          after: [],
          steps: [{ cwd: '', command: `${NODE} -e "setTimeout(() => {}, 60000)"` }],
        },
      ],
    };
    const boots = new WorktreeBootstraps(join(work, 'logs'), { softTimeoutMs: 600 });
    const started = Date.now();
    const state = await boots.run(copy, plan);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(state.status).toBe('ok');
    expect(state.timedOut).toBeUndefined();
    expect(boots.log(copy)).toContain('потолок');
  });

  it('мягкая цепочка не освобождает ждущего соседа того же каталога', async () => {
    // Хотя бы по логу порядка: сосед `after: ['lib']` ждёт НЕ мягкую цепочку каталога lib.
    const marker = join(work, 'order.txt');
    const append = (text: string): string =>
      `${NODE} -e "require('fs').appendFileSync(String.raw\`${marker}\`, '${text}\\n')"`;
    const plan: BootstrapPlan = {
      summary: 'order',
      chains: [
        {
          cwd: 'lib',
          after: [],
          steps: [
            { cwd: '', command: `${NODE} -e "setTimeout(() => {}, 700)" && ${append('lib')}` },
          ],
        },
        {
          cwd: 'lib',
          soft: true,
          after: [],
          steps: [{ cwd: '', command: append('soft') }],
        },
        { cwd: 'web', after: ['lib'], steps: [{ cwd: '', command: append('web') }] },
      ],
    };
    await new WorktreeBootstraps(join(work, 'logs')).run(copy, plan);
    expect(existsSync(marker)).toBe(true);
    const order = readFileSync(marker, 'utf8').trim().split('\n');
    expect(order.indexOf('lib')).toBeLessThan(order.indexOf('web'));
  });
});
