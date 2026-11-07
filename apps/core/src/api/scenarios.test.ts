import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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
    // Пресет может иметь несколько версий (tracker-ticket@1 и @2): список — каждая, ids — по разу.
    expect([...new Set(body.presets.map((p) => p.id))].sort()).toEqual([...PRESET_IDS].sort());
    expect(body.latestPresets.find((p) => p.id === 'tracker-ticket')!.version).toBe(2);
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

describe('POST /v1/scenarios/from-path (stage 10, F1)', () => {
  function post(home: string) {
    const app = Fastify();
    apps.push(app);
    const ctx = {
      env: commandEnv({ home }),
      requireRead: (request, reply) => {
        if (request.headers.authorization === 'Bearer t') return 'core';
        void reply.code(401).send({ code: 'token-required' });
        return undefined;
      },
    } as Pick<RouteContext, 'env' | 'requireRead'> as RouteContext;
    registerScenarios(app, ctx);
    return (payload: unknown, auth = true) =>
      app.inject({
        method: 'POST',
        url: '/v1/scenarios/from-path',
        payload: payload as object,
        headers: auth ? { authorization: 'Bearer t' } : {},
      });
  }

  const pathStep = (id: string, order: number, title: string, prompt: string) => ({
    id,
    anchor: 'work',
    order,
    kind: 'prompt',
    title: { ru: title, en: title },
    prompt: { ru: prompt, en: prompt },
    source: 'en',
    createdAt: '2026-10-01T00:00:00.000Z',
  });

  it('a scenario-flow Path becomes its steps in order, then the core delivery; nothing is written', async () => {
    const home = tempDir('api-scn-fp-');
    const send = post(home);
    const res = await send({
      id: 'group-abc',
      title: 'Группа',
      flow: 'scenario',
      path: {
        steps: [pathStep('b', 1, 'Second', 'do second'), pathStep('a', 0, 'First', 'do first')],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      scenario: {
        id: string;
        steps: { id: string; title: string; knowledge: { text?: string } }[];
      };
      problems: string[];
      ids: Record<string, string>;
    };
    expect(body.problems).toEqual([]);
    expect(body.scenario.id).toBe('group-abc');
    expect(body.scenario.steps.map((s) => s.title)).toEqual([
      'First',
      'Second',
      'Финальная проверка',
      'Публикация',
    ]);
    expect(body.scenario.steps[0]?.knowledge.text).toBe('do first');
    expect(body.ids).toEqual({ a: 'path-1', b: 'path-2' });
    // Только перевод: библиотека пуста — сохраняет человек своим судом.
    const lib = layoutOf(home).scenarios;
    expect(existsSync(lib) ? readdirSync(lib) : []).toEqual([]);
  });

  it('lang from the body names every step in that language; an unknown lang is 400', async () => {
    const send = post(tempDir('api-scn-fp-'));
    const step = {
      ...pathStep('a', 0, '', 'do it'),
      title: { ru: 'Проверить', en: 'Check' },
    };
    const titles = async (lang: 'ru' | 'en'): Promise<string[]> => {
      const res = await send({ id: 'group-l', title: 'Группа', path: { steps: [step] }, lang });
      expect(res.statusCode).toBe(200);
      return (res.json() as { scenario: { steps: { title: string }[] } }).scenario.steps
        .map((s) => s.title)
        .slice(2, 4);
    };
    expect(await titles('en')).toEqual(['Work', 'Check']);
    expect(await titles('ru')).toEqual(['Работа', 'Проверить']);
    expect((await send({ id: 'group-l', title: 'x', lang: 'de' })).statusCode).toBe(400);
  });

  it('problems are a 422 with the list and no scenario; a bad body is 400; no token is 401', async () => {
    const send = post(tempDir('api-scn-fp-'));
    const long = await send({
      id: 'group-long',
      title: 'Группа',
      path: { steps: [pathStep('a', 0, 'x'.repeat(201), 'p')] },
    });
    expect(long.statusCode).toBe(422);
    expect(long.json()).toMatchObject({ scenario: null });
    expect((long.json() as { problems: string[] }).problems.join(' ')).toMatch(/longer than 200/);
    expect((await send({ id: 'Bad Id', title: 'x' })).statusCode).toBe(400);
    expect((await send({ id: 'group-a', title: 'x' }, false)).statusCode).toBe(401);
  });
});
