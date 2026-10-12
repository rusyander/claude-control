import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { ProjectRunnerRegistry } from './registry.ts';
import { resolveRunCommand } from './stack.ts';
import type { LaunchSpec } from './project-runner.types.ts';

/**
 * Что реестр передаёт НАСТОЯЩЕМУ процессу: каталог запуска (`cwd` спеки — Go
 * запускается из корня модуля, а не из `cmd/api`), закреплённый порт так, как
 * его ждёт стек (аргумент uvicorn, переменная Spring), и PYTHONUNBUFFERED.
 * Доказательство — файл, который процесс пишет о себе сам: argv, env, cwd.
 */

const DUMP_SERVER = `
const http = require('node:http');
const fs = require('node:fs');
const portArg = process.argv.indexOf('--port');
const port = Number(portArg > 0 ? process.argv[portArg + 1] : 0);
fs.writeFileSync(process.env.DUMP_TO, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  serverPort: process.env.SERVER_PORT,
  port: process.env.PORT,
  unbuffered: process.env.PYTHONUNBUFFERED,
}));
const server = http.createServer((req, res) => res.end('ok'));
server.listen(port, '127.0.0.1', () => console.log('listening on :' + server.address().port));
`;

interface Dump {
  argv: string[];
  cwd: string;
  serverPort?: string;
  port?: string;
  unbuffered?: string;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const address = probe.address();
  await new Promise((done) => probe.close(done));
  return typeof address === 'object' && address ? address.port : 0;
}

async function until(predicate: () => boolean, totalMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((sleep) => setTimeout(sleep, 100));
  }
  return false;
}

describe('ProjectRunnerRegistry: что доходит до процесса', { timeout: 30_000 }, () => {
  let root: string;
  let registry: ProjectRunnerRegistry;
  let dumpTo: string;
  const previousDump = process.env.DUMP_TO;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-runner-launch-')));
    writeFileSync(join(root, 'server.cjs'), DUMP_SERVER);
    dumpTo = join(root, 'dump.json');
    process.env.DUMP_TO = dumpTo;
  });

  afterEach(() => {
    registry?.stopAll();
    if (previousDump === undefined) delete process.env.DUMP_TO;
    else process.env.DUMP_TO = previousDump;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // temp уйдёт с ОС
    }
  });

  const readDump = (): Dump => JSON.parse(readFileSync(dumpTo, 'utf8')) as Dump;

  it('cwd спеки и закреплённый порт по правилам стека доходят до процесса', async () => {
    const target = join(root, 'cmd', 'api');
    mkdirSync(target, { recursive: true });
    const port = await freePort();
    const launch = (): LaunchSpec => ({
      file: process.execPath,
      args: [join(root, 'server.cjs')],
      display: 'node server.cjs',
      cwd: root,
      pinPort: (pinned) => ({
        args: ['--port', String(pinned)],
        env: { SERVER_PORT: String(pinned) },
      }),
    });
    registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });

    await registry.start({ projectPath: root, dir: 'cmd/api' }, { port });
    expect(
      await until(() => registry.get({ projectPath: root, dir: 'cmd/api' })?.status === 'running'),
    ).toBe(true);

    const dump = readDump();
    expect(dump.argv).toEqual(['--port', String(port)]);
    expect(realpathSync.native(dump.cwd)).toBe(root);
    expect(dump.serverPort).toBe(String(port));
    expect(dump.port).toBe(String(port));
    expect(dump.unbuffered).toBe('1');
    expect(registry.get({ projectPath: root, dir: 'cmd/api' })?.port).toBe(port);
  });

  it('негатив: без закреплённого порта стековых аргументов и PORT нет, cwd — каталог цели', async () => {
    const target = join(root, 'cmd', 'api');
    mkdirSync(target, { recursive: true });
    const launch = (): LaunchSpec => ({
      file: process.execPath,
      args: [join(root, 'server.cjs')],
      display: 'node server.cjs',
      pinPort: (pinned) => ({ args: ['--port', String(pinned)] }),
    });
    registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });

    await registry.start({ projectPath: root, dir: 'cmd/api' });
    expect(
      await until(() => registry.get({ projectPath: root, dir: 'cmd/api' })?.status === 'running'),
    ).toBe(true);

    const dump = readDump();
    expect(dump.argv).toEqual([]);
    expect(dump.port).toBeUndefined();
    expect(realpathSync.native(dump.cwd)).toBe(target);
  });

  it('бэкенд (browser: false) браузер не открывает, фронтенд — открывает', async () => {
    const opened: string[] = [];
    const api = join(root, 'api');
    const web = join(root, 'web');
    mkdirSync(api);
    mkdirSync(web);
    const launch = (target: string): LaunchSpec => ({
      file: process.execPath,
      args: [join(root, 'server.cjs')],
      display: 'node server.cjs',
      ...(target === api ? { browser: false } : {}),
    });
    registry = new ProjectRunnerRegistry({
      openBrowser: (url) => opened.push(url),
      resolveLaunch: launch,
    });

    await registry.start({ projectPath: root, dir: 'api' });
    expect(
      await until(() => registry.get({ projectPath: root, dir: 'api' })?.status === 'running'),
    ).toBe(true);
    await registry.start({ projectPath: root, dir: 'web' });
    expect(await until(() => opened.length === 1)).toBe(true);
    const webPort = registry.get({ projectPath: root, dir: 'web' })?.port;
    expect(opened).toEqual([`http://localhost:${webPort}`]);
  });

  it('resolveRunCommand: Go — без браузера, Node — с ним', () => {
    const goDir = join(root, 'go-svc');
    mkdirSync(goDir);
    writeFileSync(join(goDir, 'go.mod'), 'module x\n');
    writeFileSync(join(goDir, 'main.go'), 'package main\n\nfunc main() {}\n');
    expect(resolveRunCommand(goDir, undefined, goDir, () => true).browser).toBe(false);
    const nodeDir = join(root, 'web-app');
    mkdirSync(nodeDir);
    writeFileSync(join(nodeDir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    expect(resolveRunCommand(nodeDir, undefined, nodeDir, () => true).browser).toBeUndefined();
  });

  it('stopProject гасит цели своего проекта и не трогает чужой', async () => {
    const other = join(root, 'other');
    mkdirSync(join(root, 'apps', 'api'), { recursive: true });
    mkdirSync(other);
    const launch = (): LaunchSpec => ({
      file: process.execPath,
      args: [join(root, 'server.cjs')],
      display: 'node server.cjs',
    });
    registry = new ProjectRunnerRegistry({ openBrowser: () => {}, resolveLaunch: launch });

    await registry.start({ projectPath: root });
    await registry.start({ projectPath: root, dir: 'apps/api' });
    await registry.start({ projectPath: other });

    expect(registry.stopProject(root)).toBe(2);
    expect(registry.list().map((run) => run.projectPath)).toEqual([other]);
    expect(registry.stopProject(join(root, 'nothing-here'))).toBe(0);
  });
});
