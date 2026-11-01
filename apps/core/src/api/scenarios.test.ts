import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { PRESET_IDS } from '@agentdeck/contracts/core/scenario';
import type { TaskRegistry } from '../conductor/tasks.ts';
import { writeLibraryScenario } from '../conductor/scenario/index.ts';
import { forkOfFeature } from '../conductor/scenario/__fixtures__/scenario-harness.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { commandEnv } from '../conductor/commands/__fixtures__/command-env.ts';
import { layoutOf } from '../platform/core-home.ts';
import type { RouteContext } from './route-context.types.ts';
import { registerScenarios } from './scenarios.ts';

/**
 * `GET /v1/scenarios[/:id@v]` (07 §API): пресеты и библиотека дома ядра; негодный файл назван в
 * `problems`, нечитаемая библиотека — 503, без токена — 401 от общей проверки чтения.
 */

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

function api(home: string) {
  const app = Fastify();
  apps.push(app);
  const ctx = {
    // Каталог задач — в другом доме: библиотека берётся из среды ручек, не рядом с `tasks/`.
    registry: { tasksDir: layoutOf(tempDir('api-scn-tasks-')).tasks } as TaskRegistry,
    env: commandEnv({ home }),
    requireRead: (request, reply) => {
      if (request.headers.authorization === 'Bearer t') return 'core';
      void reply.code(401).send({ code: 'token-required' });
      return undefined;
    },
  } as Pick<RouteContext, 'registry' | 'env' | 'requireRead'> as RouteContext;
  registerScenarios(app, ctx);
  return (url: string, auth = true) =>
    app.inject({ method: 'GET', url, headers: auth ? { authorization: 'Bearer t' } : {} });
}

describe('GET /v1/scenarios', () => {
  it('lists the five presets and the library; a bad library file is named in problems', async () => {
    const home = tempDir('api-scn-');
    const lib = layoutOf(home).scenarios;
    await writeLibraryScenario(lib, forkOfFeature('team-flow', 1));
    writeFileSync(join(lib, 'bad@1.json'), '{');
    const get = api(home);
    const res = await get('/v1/scenarios');
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      presets: { id: string }[];
      latestPresets: { id: string; version: number }[];
      library: { id: string; version: number }[];
      problems: { file: string }[];
    };
    expect(body.presets.map((p) => p.id).sort()).toEqual([...PRESET_IDS].sort());
    expect(body.library.map((s) => `${s.id}@${s.version}`)).toEqual(['team-flow@1']);
    expect(body.problems.map((p) => p.file)).toEqual(['bad@1.json']);
    expect((await get('/v1/scenarios', false)).statusCode).toBe(401);
  });

  it('one version by id@v: preset, library, 404, 400 on a bad ref, 422 on a bad file', async () => {
    const home = tempDir('api-scn-');
    const lib = layoutOf(home).scenarios;
    await writeLibraryScenario(lib, forkOfFeature('team-flow', 1));
    writeFileSync(join(lib, 'bad@1.json'), '{');
    const get = api(home);
    expect((await get('/v1/scenarios/feature@1')).json()).toMatchObject({
      source: 'preset',
      scenario: { id: 'feature' },
    });
    expect((await get('/v1/scenarios/team-flow@1')).json()).toMatchObject({ source: 'library' });
    expect((await get('/v1/scenarios/team-flow@2')).statusCode).toBe(404);
    expect((await get('/v1/scenarios/feature@9')).statusCode).toBe(404);
    expect((await get('/v1/scenarios/Bad@x')).statusCode).toBe(400);
    expect((await get('/v1/scenarios/bad@1')).statusCode).toBe(422);
  });

  it('P44: a library path that cannot be listed is 503 with the reason, never an empty list', async () => {
    const home = tempDir('api-scn-');
    mkdirSync(home, { recursive: true });
    // Файл на месте каталога: listDir не читается — это «не знаю», а не «сценариев нет».
    writeFileSync(layoutOf(home).scenarios, 'not a dir');
    const res = await api(home)('/v1/scenarios');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'library-unreadable' });
  });
});
