import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, createConnection, type Server } from 'node:net';
import {
  detectPackageManager,
  detectRunScript,
  resolveRunCommand,
  describeRunner,
  tokenize,
  findFreePort,
  RunnerError,
  ProjectRunnerRegistry,
  type LaunchSpec,
} from './project-runner.ts';

/** Временный каталог проекта; чистится после теста. */
function makeProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'cc-runner-'));
}

describe('detectPackageManager: по lock-файлу', () => {
  let dir: string;
  beforeEach(() => (dir = makeProjectDir()));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
});

describe('detectRunScript / resolveRunCommand: выбор команды (dev>start>оверрайд>нет)', () => {
  let dir: string;
  beforeEach(() => (dir = makeProjectDir()));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writePkg = (scripts: Record<string, string>): void =>
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));

  it('dev приоритетнее start', () => {
    writePkg({ dev: 'vite', start: 'node .' });
    expect(detectRunScript(dir)).toBe('dev');
    expect(resolveRunCommand(dir).display).toBe('npm run dev');
  });

  it('start, если dev нет', () => {
    writePkg({ start: 'node .' });
    expect(detectRunScript(dir)).toBe('start');
    expect(resolveRunCommand(dir).display).toBe('npm run start');
  });

  it('оверрайд перекрывает dev/start', () => {
    writePkg({ dev: 'vite' });
    const spec = resolveRunCommand(dir, 'node server.mjs --port 1');
    expect(spec.file).toBe('node');
    expect(spec.args).toEqual(['server.mjs', '--port', '1']);
    expect(spec.display).toBe('node server.mjs --port 1');
  });

  it('нет dev/start и нет оверрайда → RunnerError(no-script)', () => {
    writePkg({ build: 'tsc' });
    expect(() => resolveRunCommand(dir)).toThrow(RunnerError);
    expect(describeRunner(dir).runnable).toBe(false);
  });

  it('оверрайд делает проект без скриптов запускаемым', () => {
    writePkg({ build: 'tsc' });
    const info = describeRunner(dir, 'node server.mjs');
    expect(info.runnable).toBe(true);
    expect(info.command).toBe('node server.mjs');
  });

  it('пакетный менеджер попадает в команду по lock-файлу', () => {
    writePkg({ dev: 'vite' });
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

describe('findFreePort: занятый порт → следующий', () => {
  let server: Server;
  let busy: number;

  beforeEach(async () => {
    // Занимаем порт живым слушателем — findFreePort должен его пропустить.
    busy = await findFreePort(4600);
    await new Promise<void>((r) => {
      server = createServer();
      server.listen(busy, '127.0.0.1', r);
    });
  });

  afterEach(() => server.close());

  it('пропускает занятый порт и берёт следующий свободный', async () => {
    const port = await findFreePort(busy);
    expect(port).toBeGreaterThan(busy);
  });

  it('пропускает порт из набора taken', async () => {
    const port = await findFreePort(busy + 1, new Set([busy + 1]));
    expect(port).not.toBe(busy + 1);
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

describe('ProjectRunnerRegistry: старт/стоп через инъекцию (браузер не открываем)', () => {
  let dir: string;
  const opened: string[] = [];

  beforeEach(() => {
    dir = makeProjectDir();
    // Крошечный http-сервер на process.env.PORT — как в реальном dev-скрипте.
    writeFileSync(
      join(dir, 'server.mjs'),
      "import http from 'node:http';\n" +
        "http.createServer((_, res) => res.end('ok')).listen(process.env.PORT);\n",
    );
    opened.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Запуск node напрямую — без npm, чтобы тест был быстрым и надёжным. */
  const launch = (): LaunchSpec => ({
    file: process.execPath,
    args: [join(dir, 'server.mjs')],
    display: 'node server.mjs',
  });

  it('старт → порт слушается → running → браузер открыт', async () => {
    const registry = new ProjectRunnerRegistry({
      openBrowser: (url) => opened.push(url),
      resolveLaunch: launch,
    });

    const started = await registry.start(dir);
    expect(started.status).toBe('starting');
    expect(started.port).toBeGreaterThan(0);

    const ready = await until(() => registry.get(dir)?.status === 'running');
    expect(ready).toBe(true);
    expect(await isListening(started.port)).toBe(true);
    expect(opened).toEqual([started.url]);

    registry.stop(dir);
  });

  it('второй проект получает свой, отличный порт', async () => {
    const dir2 = makeProjectDir();
    writeFileSync(
      join(dir2, 'server.mjs'),
      "import http from 'node:http';\nhttp.createServer((_,r)=>r.end('ok')).listen(process.env.PORT);\n",
    );
    const registry = new ProjectRunnerRegistry({
      openBrowser: () => {},
      resolveLaunch: (d) => ({
        file: process.execPath,
        args: [join(d, 'server.mjs')],
        display: 'node',
      }),
    });
    try {
      const a = await registry.start(dir);
      const b = await registry.start(dir2);
      expect(b.port).not.toBe(a.port);
      registry.stopAll();
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('стоп → процесс мёртв (порт больше не слушается)', async () => {
    const registry = new ProjectRunnerRegistry({
      openBrowser: () => {},
      resolveLaunch: launch,
    });
    const started = await registry.start(dir);
    await until(() => registry.get(dir)?.status === 'running');

    expect(registry.stop(dir)).toBe(true);
    expect(registry.get(dir)).toBeUndefined();

    const dead = await until(async () => !(await isListening(started.port)), 8_000);
    expect(dead).toBe(true);
  });

  it('path-safety: несуществующий каталог → RunnerError(bad-path)', async () => {
    const registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });
    await expect(registry.start(join(dir, 'nope'))).rejects.toBeInstanceOf(RunnerError);
  });

  it('path-safety: файл вместо каталога → RunnerError(bad-path)', async () => {
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'x');
    const registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });
    await expect(registry.start(file)).rejects.toBeInstanceOf(RunnerError);
  });

  it('повторный старт запущенного не плодит второй процесс', async () => {
    const registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });
    const first = await registry.start(dir);
    const second = await registry.start(dir);
    expect(second.port).toBe(first.port);
    registry.stop(dir);
  });
});
