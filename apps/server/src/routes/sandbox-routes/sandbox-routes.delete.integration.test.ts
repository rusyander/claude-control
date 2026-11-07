import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerContext } from '../../context.ts';
import {
  markSandboxBusy,
  markSandboxFree,
  sandboxPaths,
} from '../../domains/sandbox/SandboxConfig.ts';
import { registerSandboxRoutes } from './sandbox-routes.ts';

/**
 * Кнопка «Удалить» сразу после прогона (`DELETE /api/sandbox/:id`). CLI ещё выходит и держит
 * рабочую папку: маршрут ждёт его в сроке успокоения и стирает папку, а не отвечает отказом с
 * советом стереть её вручную. Маршрут настоящий, удаление настоящее; «CLI» — живой процесс с
 * рабочим каталогом внутри песочницы. Домашний каталог подменён: песочницы панели лежат в нём,
 * а настоящие (с копией доступа) тест не трогает. Занятость папки процессом — свойство Windows.
 */

const id = `qa-delete-${process.pid}`;
let home: string;
let saved: { USERPROFILE?: string; HOME?: string };
let app: FastifyInstance;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-sandbox-delete-'));
  saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  const ctx = {
    location: { paths: { root: home, appData: join(home, 'agentdeck') } },
    store: { getSettings: () => ({ provider: 'claude' }) },
  } as unknown as ServerContext;
  app = Fastify();
  registerSandboxRoutes(app, ctx);
});

afterEach(async () => {
  await app.close();
  for (const key of ['USERPROFILE', 'HOME'] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(home, { recursive: true, force: true });
});

async function holdWorkDir(ms: number): Promise<ChildProcess> {
  const { workDir } = sandboxPaths(id);
  mkdirSync(workDir, { recursive: true });
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], {
    cwd: workDir,
    stdio: 'ignore',
  });
  await new Promise((ready) => child.once('spawn', ready));
  return child;
}

const exited = (child: ChildProcess) =>
  child.exitCode !== null ? Promise.resolve() : new Promise((done) => child.once('exit', done));

describe('DELETE /api/sandbox/:id сразу после прогона', () => {
  it.runIf(process.platform === 'win32')(
    'ждёт выхода CLI, держащего папку, и стирает песочницу',
    async () => {
      const cli = await holdWorkDir(1_500);
      try {
        // Прогон только что кончился: идёт срок успокоения.
        markSandboxBusy(id);
        markSandboxFree(id);
        expect(sandboxPaths(id).root.startsWith(home)).toBe(true);

        const response = await app.inject({ method: 'DELETE', url: `/api/sandbox/${id}` });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
        expect(existsSync(sandboxPaths(id).root)).toBe(false);
      } finally {
        cli.kill();
        await exited(cli);
      }
    },
  );
});
