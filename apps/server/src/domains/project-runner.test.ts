import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection, createServer, type Server } from 'node:net';
import {
  detectPackageManager,
  extractBusyPort,
  findPortHolders,
  freePort,
  isPortBusy,
  detectRunScript,
  resolveRunCommand,
  describeRunner,
  listRunnerTargets,
  expandWorkspacePattern,
  extractServerPort,
  resolveTargetDir,
  tokenize,
  RunnerError,
  ProjectRunnerRegistry,
  autostartProjects,
  type LaunchSpec,
} from './project-runner.ts';

/**
 * Снос временного каталога. На Windows git и запущенные процессы держат хендлы
 * дольше, чем живёт тест, поэтому неудача уборки — не провал проверки: каталог
 * лежит в temp и уйдёт с ОС.
 */
function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

/** Первый элемент списка: в этих проверках он всегда есть, но tsc об этом не знает. */
function first<T>(list: T[]): T {
  const [item] = list;
  if (item === undefined) throw new Error('Список пуст');
  return item;
}

/** Временный каталог проекта; чистится после теста. */
function makeProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'cc-runner-'));
}

/** package.json в произвольном каталоге. */
function writePkg(dir: string, pkg: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
}

describe('detectPackageManager: по lock-файлу', () => {
  let dir: string;
  beforeEach(() => (dir = makeProjectDir()));
  afterEach(() => dropTemp(dir));

  it('pnpm-lock.yaml → pnpm', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    expect(detectPackageManager(dir)).toBe('pnpm');
  });

  it('yarn.lock → yarn', () => {
    writeFileSync(join(dir, 'yarn.lock'), '');
    expect(detectPackageManager(dir)).toBe('yarn');
  });

  it('без lock-файла → npm', () => {
    expect(detectPackageManager(dir)).toBe('npm');
  });

  it('pnpm приоритетнее yarn при обоих lock-файлах', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    writeFileSync(join(dir, 'yarn.lock'), '');
    expect(detectPackageManager(dir)).toBe('pnpm');
  });

  it('pnpm-workspace.yaml — тоже признак pnpm: lock-файл в git попадает не всегда', () => {
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
    expect(detectPackageManager(dir)).toBe('pnpm');
  });

  it('поле packageManager сильнее lock-файла: автор проекта сказал прямо', () => {
    writeFileSync(join(dir, 'package-lock.json'), '');
    writePkg(dir, { packageManager: 'yarn@4.1.0' });
    expect(detectPackageManager(dir)).toBe('yarn');
  });

  it('packageManager из корня действует и для пакета монорепы', () => {
    writePkg(dir, { packageManager: 'pnpm@9.1.0' });
    const target = join(dir, 'apps', 'web');
    writePkg(target, { name: 'web', scripts: { dev: 'vite' } });
    expect(detectPackageManager(target, dir)).toBe('pnpm');
  });

  it('в монорепе lock ищется вверх до корня проекта', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    const target = join(dir, 'apps', 'web');
    mkdirSync(target, { recursive: true });
    expect(detectPackageManager(target, dir)).toBe('pnpm');
    // Без корня подъёма нет: смотрим только в самом каталоге.
    expect(detectPackageManager(target)).toBe('npm');
  });
});

describe('detectRunScript / resolveRunCommand: выбор команды (dev>start>оверрайд>нет)', () => {
  let dir: string;
  beforeEach(() => (dir = makeProjectDir()));
  afterEach(() => dropTemp(dir));

  const scripts = (value: Record<string, string>): void => writePkg(dir, { scripts: value });

  it('dev приоритетнее start', () => {
    scripts({ dev: 'vite', start: 'node .' });
    expect(detectRunScript(dir)).toBe('dev');
    expect(resolveRunCommand(dir).display).toBe('npm run dev');
  });

  it('start, если dev нет', () => {
    scripts({ start: 'node .' });
    expect(detectRunScript(dir)).toBe('start');
    expect(resolveRunCommand(dir).display).toBe('npm run start');
  });

  it('оверрайд перекрывает dev/start', () => {
    scripts({ dev: 'vite' });
    const spec = resolveRunCommand(dir, 'node server.mjs --port 1');
    expect(spec.file).toBe('node');
    expect(spec.args).toEqual(['server.mjs', '--port', '1']);
    expect(spec.display).toBe('node server.mjs --port 1');
  });

  it('нет dev/start и нет оверрайда → RunnerError(no-script)', () => {
    scripts({ build: 'tsc' });
    expect(() => resolveRunCommand(dir)).toThrow(RunnerError);
    expect(first(describeRunner(dir).targets).runnable).toBe(false);
  });

  it('оверрайд делает проект без скриптов запускаемым', () => {
    scripts({ build: 'tsc' });
    const info = describeRunner(dir, () => ({ command: 'node server.mjs' }));
    expect(first(info.targets).runnable).toBe(true);
    expect(first(info.targets).command).toBe('node server.mjs');
    expect(first(info.targets).commandOverride).toBe('node server.mjs');
  });

  it('пакетный менеджер попадает в команду по lock-файлу', () => {
    scripts({ dev: 'vite' });
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    expect(resolveRunCommand(dir).display).toBe('pnpm run dev');
  });
});

describe('tokenize: разбор строки с кавычками', () => {
  it('уважает кавычки вокруг пути с пробелом', () => {
    expect(tokenize('node "my server.mjs" --port 3000')).toEqual([
      'node',
      'my server.mjs',
      '--port',
      '3000',
    ]);
  });
});

describe('extractServerPort: адрес читается из вывода dev-сервера', () => {
  it('строка Vite', () => {
    expect(extractServerPort('  ➜  Local:   http://localhost:5173/')).toBe(5173);
  });

  it('строка Next c 127.0.0.1', () => {
    expect(extractServerPort('- Local:        http://127.0.0.1:3000')).toBe(3000);
  });

  it('IPv6-петля', () => {
    expect(extractServerPort('listening on http://[::1]:4200')).toBe(4200);
  });

  it('цветовые коды не мешают', () => {
    expect(extractServerPort('\u001B[32m➜\u001B[39m  http://localhost:8888/\u001B[0m')).toBe(8888);
  });

  it('внешний адрес не берём: панель ведёт на localhost и его же проверяет', () => {
    expect(extractServerPort('Network: http://192.168.1.5:5173/')).toBeUndefined();
  });

  it('адреса ещё нет → undefined', () => {
    expect(extractServerPort('vite v5 building for development...')).toBeUndefined();
  });

  it('берёт первый адрес, а не последний', () => {
    const output = 'Local: http://localhost:5173/\nDocs: http://localhost:9999/';
    expect(extractServerPort(output)).toBe(5173);
  });
});

describe('extractBusyPort: сервер сам жалуется на занятый порт', () => {
  it('строгий порт Vite', () => {
    expect(extractBusyPort('error when starting dev server:\nError: Port 8888 is already in use')) //
      .toBe(8888);
  });

  it('EADDRINUSE от Node', () => {
    expect(extractBusyPort('Error: listen EADDRINUSE: address already in use 127.0.0.1:5178')).toBe(
      5178,
    );
  });

  it('«занят, беру следующий» — НЕ отказ: сервер поднялся, убивать нечего', () => {
    expect(extractBusyPort('Port 5173 is in use, trying another one...')).toBeUndefined();
  });

  it('обычный вывод → ничего', () => {
    expect(extractBusyPort('  ➜  Local:   http://localhost:5173/')).toBeUndefined();
  });
});

describe('порт проверяется по обеим семьям адресов', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise((done) => server?.close(() => done(undefined)));
    server = undefined;
  });

  /**
   * Сервер, слушающий ТОЛЬКО IPv6-петлю, — ровно то, что делает Vite на Windows
   * (`localhost` там разрешается в `::1`). Проба лишь по 127.0.0.1 объявляла бы
   * такой сервер мёртвым, и ссылки «Перейти» пользователь не получал.
   */
  it('слушает только ::1 — порт всё равно считается занятым', async () => {
    server = createServer();
    const port = await new Promise<number>((ready, fail) => {
      server?.once('error', fail);
      server?.listen(0, '::1', () => {
        const address = server?.address();
        ready(typeof address === 'object' && address ? address.port : 0);
      });
    });

    expect(port).toBeGreaterThan(0);
    expect(await isPortBusy(port)).toBe(true);
  });

  it('свободный порт свободен', async () => {
    // Занимаем и тут же отпускаем — так номер точно ничей.
    const probe = createServer();
    const port = await new Promise<number>((ready) => {
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        ready(typeof address === 'object' && address ? address.port : 0);
      });
    });
    await new Promise((done) => probe.close(() => done(undefined)));

    expect(await isPortBusy(port)).toBe(false);
    // Освобождать нечего: список держателей пуст, никого не убили.
    const freed = await freePort(port, () => false);
    expect(freed.busy).toBe(false);
    expect(freed.killed).toEqual([]);
  });

  it('свой процесс в держателях порта не показываем — панель себя не убивает', async () => {
    server = createServer();
    const port = await new Promise<number>((ready) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        ready(typeof address === 'object' && address ? address.port : 0);
      });
    });

    expect(findPortHolders(port)).not.toContain(process.pid);
  });
});

describe('resolveTargetDir: подпапка обязана лежать внутри проекта', () => {
  const root = process.platform === 'win32' ? 'C:\\work\\demo' : '/work/demo';

  it('пусто → сам корень', () => {
    expect(resolveTargetDir(root).dir).toBe('');
    expect(resolveTargetDir(root, '  ').dir).toBe('');
  });

  it('обратные слэши и хвостовой слэш приводятся к одному виду', () => {
    expect(resolveTargetDir(root, 'apps\\web\\').dir).toBe('apps/web');
  });

  it('выход наверх запрещён', () => {
    expect(() => resolveTargetDir(root, '../secrets')).toThrow(RunnerError);
    expect(() => resolveTargetDir(root, 'apps/../../etc')).toThrow(RunnerError);
  });

  it('абсолютный путь запрещён', () => {
    expect(() => resolveTargetDir(root, '/etc')).toThrow(RunnerError);
    expect(() => resolveTargetDir(root, 'D:/other')).toThrow(RunnerError);
  });
});

describe('listRunnerTargets: корень и пакеты монорепозитория', () => {
  let dir: string;
  beforeEach(() => (dir = makeProjectDir()));
  afterEach(() => dropTemp(dir));

  it('обычный проект — одна цель, сам корень', () => {
    writePkg(dir, { name: 'solo', scripts: { dev: 'vite' } });
    const found = listRunnerTargets(dir);
    expect(found.targets).toHaveLength(1);
    expect(first(found.targets).dir).toBe('');
    expect(first(found.targets).name).toBe('solo');
    expect(found.source).toBeUndefined();
  });

  it('корень остаётся в списке даже без скрипта — есть куда вписать команду', () => {
    writePkg(dir, { name: 'empty', scripts: { build: 'tsc' } });
    expect(first(listRunnerTargets(dir).targets).dir).toBe('');
  });

  it('pnpm-workspace.yaml → пакеты со скриптом запуска', () => {
    writePkg(dir, { name: 'mono' });
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
    writePkg(join(dir, 'apps', 'web'), { name: '@mono/web', scripts: { dev: 'vite' } });
    writePkg(join(dir, 'apps', 'api'), { name: '@mono/api', scripts: { start: 'node .' } });
    // Библиотека без dev/start в списке «что запустить» не нужна.
    writePkg(join(dir, 'packages', 'ui'), { name: '@mono/ui', scripts: { build: 'tsc' } });

    const found = listRunnerTargets(dir);
    expect(found.source).toBe('pnpm');
    expect(found.targets.map((target) => target.dir).sort()).toEqual(['', 'apps/api', 'apps/web']);
    expect(found.targets.find((target) => target.dir === 'apps/web')?.name).toBe('@mono/web');
  });

  it('workspaces в package.json тоже читаются', () => {
    writePkg(dir, { name: 'mono', workspaces: ['packages/*'] });
    writePkg(join(dir, 'packages', 'app'), { name: 'app', scripts: { dev: 'next' } });
    const found = listRunnerTargets(dir);
    expect(found.source).toBe('npm');
    expect(found.targets.map((target) => target.dir)).toContain('packages/app');
  });

  it('без файла воркспейсов смотрим в apps/ и packages/ — источник назван честно', () => {
    writePkg(dir, { name: 'mono' });
    writePkg(join(dir, 'apps', 'web'), { name: 'web', scripts: { dev: 'vite' } });
    const found = listRunnerTargets(dir);
    expect(found.source).toBe('scan');
    expect(found.targets.map((target) => target.dir)).toContain('apps/web');
  });

  it('исключающий шаблон (!) выкидывает пакет из списка', () => {
    writePkg(dir, { name: 'mono' });
    writeFileSync(
      join(dir, 'pnpm-workspace.yaml'),
      "packages:\n  - 'apps/*'\n  - '!apps/legacy'\n",
    );
    writePkg(join(dir, 'apps', 'web'), { name: 'web', scripts: { dev: 'vite' } });
    writePkg(join(dir, 'apps', 'legacy'), { name: 'legacy', scripts: { dev: 'vite' } });

    const dirs = listRunnerTargets(dir).targets.map((target) => target.dir);
    expect(dirs).toContain('apps/web');
    expect(dirs).not.toContain('apps/legacy');
  });

  it('битый pnpm-workspace.yaml не роняет разбор — остаётся скан папок', () => {
    writePkg(dir, { name: 'mono' });
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: [ unclosed\n');
    writePkg(join(dir, 'apps', 'web'), { name: 'web', scripts: { dev: 'vite' } });
    expect(listRunnerTargets(dir).source).toBe('scan');
  });
});

describe('expandWorkspacePattern: звёздочки в шаблонах', () => {
  let dir: string;
  beforeEach(() => (dir = makeProjectDir()));
  afterEach(() => dropTemp(dir));

  it('* — один уровень', () => {
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    mkdirSync(join(dir, 'apps', 'api'), { recursive: true });
    expect(expandWorkspacePattern(dir, 'apps/*').sort()).toEqual(['apps/api', 'apps/web']);
  });

  it('** — вглубь', () => {
    mkdirSync(join(dir, 'packages', 'group', 'inner'), { recursive: true });
    const found = expandWorkspacePattern(dir, 'packages/**');
    expect(found).toContain('packages/group');
    expect(found).toContain('packages/group/inner');
  });

  it('node_modules и скрытые каталоги в обход не попадают', () => {
    mkdirSync(join(dir, 'apps', 'node_modules'), { recursive: true });
    mkdirSync(join(dir, 'apps', '.cache'), { recursive: true });
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    expect(expandWorkspacePattern(dir, 'apps/*')).toEqual(['apps/web']);
  });

  it('несуществующий путь → пусто, без исключения', () => {
    expect(expandWorkspacePattern(dir, 'nope/*')).toEqual([]);
  });
});

/** Проверить, слушает ли кто-то порт (для утверждений теста). */
function isListening(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolvePort(true);
    });
    socket.once('error', () => resolvePort(false));
    socket.setTimeout(800, () => {
      socket.destroy();
      resolvePort(false);
    });
  });
}

/** Ждать условия с опросом (готовность/смерть процесса). */
async function until(
  predicate: () => Promise<boolean> | boolean,
  totalMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/**
 * Подопытный «dev-сервер»: слушает СВОЙ порт (как Vite с портом в конфиге) и
 * печатает адрес — ровно так панель его теперь и узнаёт. `PORT` уважает, если
 * передан: это случай закреплённого порта.
 */
const DEV_SERVER =
  "import http from 'node:http';\n" +
  "const server = http.createServer((_, res) => res.end('ok'));\n" +
  "server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {\n" +
  '  console.log(`  ➜  Local:   http://localhost:${server.address().port}/`);\n' +
  '});\n';

/** Тот же сервер, но молчаливый: адрес не печатает (бэкенд, воркер). */
const QUIET_SERVER =
  "import http from 'node:http';\n" +
  "http.createServer((_, res) => res.end('ok')).listen(0, '127.0.0.1');\n" +
  'setInterval(() => {}, 1000);\n';

// Здесь спавнятся настоящие процессы и ожидается настоящий TCP-порт: под полной
// нагрузкой набора старт node на Windows не укладывается в дефолтные 5 секунд.
describe(
  'ProjectRunnerRegistry: порт читается из вывода, а не назначается',
  { timeout: 30_000 },
  () => {
    let dir: string;
    const opened: string[] = [];

    beforeEach(() => {
      dir = makeProjectDir();
      writeFileSync(join(dir, 'server.mjs'), DEV_SERVER);
      opened.length = 0;
    });
    afterEach(() => dropTemp(dir));

    /** Запуск node напрямую — без npm, чтобы тест был быстрым и надёжным. */
    const launch = (target: string): LaunchSpec => ({
      file: process.execPath,
      args: [join(target, 'server.mjs')],
      display: 'node server.mjs',
    });

    it('старт → адрес из вывода → running → браузер открыт на нём же', async () => {
      const registry = new ProjectRunnerRegistry({
        openBrowser: (url) => opened.push(url),
        resolveLaunch: launch,
      });

      const started = await registry.start({ projectPath: dir });
      expect(started.status).toBe('starting');
      // Порт панель не выдумывает: на старте он ещё неизвестен.
      expect(started.port).toBeUndefined();

      const ready = await until(() => registry.get({ projectPath: dir })?.status === 'running');
      expect(ready).toBe(true);

      const view = registry.get({ projectPath: dir });
      expect(view?.port).toBeGreaterThan(0);
      expect(await isListening(view!.port!)).toBe(true);
      expect(opened).toEqual([`http://localhost:${view!.port}`]);

      registry.stop({ projectPath: dir });
    });

    it('найденный порт уходит в память панели через колбэк', async () => {
      const remembered: { projectPath: string; dir: string; port: number }[] = [];
      const registry = new ProjectRunnerRegistry({
        openBrowser: () => {},
        resolveLaunch: launch,
        onPortDiscovered: (run) => remembered.push(run),
      });

      await registry.start({ projectPath: dir });
      await until(() => remembered.length > 0);

      expect(remembered).toHaveLength(1);
      expect(first(remembered).projectPath).toBe(dir);
      expect(first(remembered).dir).toBe('');
      expect(first(remembered).port).toBeGreaterThan(0);
      registry.stop({ projectPath: dir });
    });

    it('две цели одного проекта работают одновременно и на разных портах', async () => {
      const web = join(dir, 'apps', 'web');
      const api = join(dir, 'apps', 'api');
      mkdirSync(web, { recursive: true });
      mkdirSync(api, { recursive: true });
      writeFileSync(join(web, 'server.mjs'), DEV_SERVER);
      writeFileSync(join(api, 'server.mjs'), DEV_SERVER);

      const registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });
      try {
        await registry.start({ projectPath: dir, dir: 'apps/web' });
        await registry.start({ projectPath: dir, dir: 'apps/api' });

        const ready = await until(
          () => registry.list().filter((run) => run.status === 'running').length === 2,
        );
        expect(ready).toBe(true);

        const runs = registry.list();
        expect(runs.map((run) => run.dir).sort()).toEqual(['apps/api', 'apps/web']);
        expect(new Set(runs.map((run) => run.port)).size).toBe(2);
        expect(runs.every((run) => run.projectPath === dir)).toBe(true);
      } finally {
        registry.stopAll();
      }
    });

    it('стоп цели не трогает соседнюю цель того же проекта', async () => {
      const web = join(dir, 'apps', 'web');
      mkdirSync(web, { recursive: true });
      writeFileSync(join(web, 'server.mjs'), DEV_SERVER);

      const registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });
      try {
        await registry.start({ projectPath: dir });
        await registry.start({ projectPath: dir, dir: 'apps/web' });
        await until(() => registry.list().filter((run) => run.status === 'running').length === 2);

        expect(registry.stop({ projectPath: dir, dir: 'apps/web' })).toBe(true);
        expect(registry.get({ projectPath: dir, dir: 'apps/web' })).toBeUndefined();
        expect(registry.get({ projectPath: dir })?.status).toBe('running');
      } finally {
        registry.stopAll();
      }
    });

    it('стоп → процесс мёртв (порт больше не слушается)', async () => {
      const registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });
      await registry.start({ projectPath: dir });
      await until(() => registry.get({ projectPath: dir })?.status === 'running');
      const port = registry.get({ projectPath: dir })!.port!;

      expect(registry.stop({ projectPath: dir })).toBe(true);
      expect(registry.get({ projectPath: dir })).toBeUndefined();

      expect(await until(async () => !(await isListening(port)), 8_000)).toBe(true);
    });

    it('закреплённый порт уходит в PORT и там же ждём', async () => {
      const registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });
      const wanted = 4737;
      const started = await registry.start({ projectPath: dir }, { port: wanted });
      expect(started.port).toBe(wanted);

      expect(await until(() => registry.get({ projectPath: dir })?.status === 'running')).toBe(
        true,
      );
      expect(await isListening(wanted)).toBe(true);
      registry.stop({ projectPath: dir });
    });

    it('закреплённый порт уже занят → RunnerError(port-busy), а не ложное «работает»', async () => {
      const registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });
      const wanted = 4738;
      await registry.start({ projectPath: dir }, { port: wanted });
      expect(await until(() => registry.get({ projectPath: dir })?.status === 'running')).toBe(
        true,
      );

      const other = makeProjectDir();
      writeFileSync(join(other, 'server.mjs'), DEV_SERVER);
      try {
        await expect(
          registry.start({ projectPath: other }, { port: wanted }),
        ).rejects.toBeInstanceOf(RunnerError);
      } finally {
        registry.stopAll();
        dropTemp(other);
      }
    });

    it('сервер молчит про адрес, но жив → running без ссылки, процесс не убит', async () => {
      writeFileSync(join(dir, 'server.mjs'), QUIET_SERVER);
      const registry = new ProjectRunnerRegistry({
        openBrowser: (url) => opened.push(url),
        resolveLaunch: launch,
        readyTimeoutMs: 1_200,
      });

      await registry.start({ projectPath: dir });
      expect(
        await until(() => registry.get({ projectPath: dir })?.status === 'running', 8_000),
      ).toBe(true);

      const view = registry.get({ projectPath: dir });
      expect(view?.url).toBeUndefined();
      expect(view?.port).toBeUndefined();
      expect(opened).toEqual([]);
      registry.stop({ projectPath: dir });
    });

    it('path-safety: несуществующий каталог → RunnerError(bad-path)', async () => {
      const registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });
      await expect(registry.start({ projectPath: dir, dir: 'nope' })).rejects.toBeInstanceOf(
        RunnerError,
      );
    });

    it('path-safety: подпапка вне проекта → RunnerError(bad-path)', async () => {
      const registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });
      await expect(
        registry.start({ projectPath: dir, dir: '../elsewhere' }),
      ).rejects.toBeInstanceOf(RunnerError);
    });

    it('повторный старт запущенного не плодит второй процесс', async () => {
      const registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });
      const first = await registry.start({ projectPath: dir });
      const second = await registry.start({ projectPath: dir });
      expect(second.startedAt).toBe(first.startedAt);
      registry.stop({ projectPath: dir });
    });

    it('openBrowser:false — сервер поднялся, окно браузера не открылось', async () => {
      const registry = new ProjectRunnerRegistry({
        openBrowser: (url) => opened.push(url),
        resolveLaunch: launch,
      });
      await registry.start({ projectPath: dir }, { openBrowser: false });
      expect(await until(() => registry.get({ projectPath: dir })?.status === 'running')).toBe(
        true,
      );
      expect(opened).toEqual([]);
      registry.stop({ projectPath: dir });
    });

    it('процесс упал сам → error с хвостом вывода', async () => {
      writeFileSync(
        join(dir, 'server.mjs'),
        "console.error('EADDRINUSE: порт занят');\nprocess.exit(1);\n",
      );
      const registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });
      await registry.start({ projectPath: dir });

      expect(await until(() => registry.get({ projectPath: dir })?.status === 'error')).toBe(true);
      expect(registry.get({ projectPath: dir })?.error).toContain('EADDRINUSE');
    });
  },
);

describe(
  'autostartProjects: подъём отмеченных целей при старте панели',
  { timeout: 30_000 },
  () => {
    let dir: string;
    const opened: string[] = [];

    beforeEach(() => {
      dir = makeProjectDir();
      writeFileSync(join(dir, 'server.mjs'), DEV_SERVER);
      opened.length = 0;
    });
    afterEach(() => dropTemp(dir));

    const launch = (target: string): LaunchSpec => ({
      file: process.execPath,
      args: [join(target, 'server.mjs')],
      display: 'node server.mjs',
    });

    it('поднимает цель и НЕ открывает браузер', async () => {
      const registry = new ProjectRunnerRegistry({
        openBrowser: (url) => opened.push(url),
        resolveLaunch: launch,
      });

      const report = await autostartProjects(registry, {
        listAutostartProjects: () => [{ path: dir }],
      });
      expect(report.failed).toEqual([]);
      expect(report.started.map((item) => item.path)).toEqual([dir]);

      expect(await until(() => registry.get({ projectPath: dir })?.status === 'running')).toBe(
        true,
      );
      expect(opened).toEqual([]);
      registry.stopAll();
    });

    it('поднимает подпапку монорепы по запомненной цели', async () => {
      const web = join(dir, 'apps', 'web');
      mkdirSync(web, { recursive: true });
      writeFileSync(join(web, 'server.mjs'), DEV_SERVER);

      const registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });
      const report = await autostartProjects(registry, {
        listAutostartProjects: () => [{ path: web, projectPath: dir, dir: 'apps/web' }],
      });

      expect(report.failed).toEqual([]);
      expect(registry.get({ projectPath: dir, dir: 'apps/web' })?.status).toBe('starting');
      registry.stopAll();
    });

    it('неудача одной цели не роняет остальные и попадает в отчёт', async () => {
      const registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });
      const missing = join(dir, 'nope');
      const report = await autostartProjects(registry, {
        listAutostartProjects: () => [{ path: missing }, { path: dir }],
      });

      expect(report.failed.map((item) => item.path)).toEqual([missing]);
      expect(report.started.map((item) => item.path)).toEqual([dir]);
      registry.stopAll();
    });
  },
);
