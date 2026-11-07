import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { AllocatorView } from '@agentdeck/contracts/core/records';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { deps, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { ensureCoreHome } from '../platform/core-home.ts';
import { createSessionTokens } from '../policy/session-tokens/session-tokens.ts';
import { WindowBook } from '../economy/window/book.ts';
import { buildCoreApi, type BootApiDeps } from './boot-api.ts';
import type { SessionRuntime } from './session-runtime.ts';
import { buildVerifierWiring } from './verifier-wiring/index.ts';

/**
 * Порты этапа 11 доходят из сборки API ядра (`buildCoreApi`) до маршрутов: распределитель мест
 * (`/v1/allocator`), активность своей модели (`/v1/local/activity`), сброс ключа обучения
 * (`/v1/learned/reset`). Порт не передан — маршрут честно отвечает 501; передан — маршрут
 * говорит с ним. Настоящие сборка API, маршруты и суд токена; порты — записи теста.
 */

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

type Stage11Ports = Pick<BootApiDeps, 'allocator' | 'localActivity' | 'learned'>;

function api(ports: Stage11Ports) {
  const home = ensureCoreHome(join(tempDir('boot-api-s11-'), 'home'));
  const registry = createTaskRegistry(home.tasks, deps());
  const coreToken = randomBytes(24).toString('base64url');
  const note = () => undefined;
  const app = buildCoreApi({
    registry,
    layout: home,
    coreToken,
    sessionTokens: createSessionTokens(coreToken),
    sessions: { permitDeps: () => undefined } as unknown as SessionRuntime,
    health: { build: 'test', bootId: newId(), pid: process.pid, startedAt: 1, home: home.root },
    windows: new WindowBook(),
    note,
    verifier: buildVerifierWiring({ registry, layout: home, note }),
    split: () => undefined,
    ...ports,
  });
  apps.push(app);
  const authorization = `Bearer ${coreToken}`;
  return {
    get: (url: string) => app.inject({ method: 'GET', url, headers: { authorization } }),
    post: (url: string, payload: unknown) =>
      app.inject({ method: 'POST', url, headers: { authorization }, payload: payload as object }),
  };
}

const VIEW = { marker: 'allocator-port' } as unknown as AllocatorView;

describe('buildCoreApi: stage 11 ports reach their routes', () => {
  it('allocator: a passed port answers /v1/allocator, none → 501', async () => {
    const wired = await api({ allocator: () => ({ view: () => VIEW }) }).get('/v1/allocator');
    expect(wired.statusCode).toBe(200);
    expect(wired.json()).toEqual({ marker: 'allocator-port' });
    expect((await api({}).get('/v1/allocator')).statusCode).toBe(501);
  });

  it('local activity: a passed port is asked (its host down → 503), none → 501', async () => {
    const asked: unknown[] = [];
    const wired = await api({
      localActivity: () => ({
        control: async (request) => {
          asked.push(request);
          throw new Error('host down');
        },
      }),
    }).get('/v1/local/activity');
    expect(wired.statusCode).toBe(503);
    expect(asked).toEqual([{ op: 'activity' }]);
    expect((await api({}).get('/v1/local/activity')).statusCode).toBe(501);
  });

  it('learned reset: a passed port reaches body parsing (bad body → 400), none → 501', async () => {
    const port = { reset: () => ({ key: 'k', at: 1 }), refused: () => undefined };
    const wired = await api({ learned: () => port }).post('/v1/learned/reset', {});
    expect(wired.statusCode).toBe(400);
    expect(wired.json()).toMatchObject({ code: 'bad-learned-reset' });
    expect((await api({}).post('/v1/learned/reset', {})).statusCode).toBe(501);
  });
});
