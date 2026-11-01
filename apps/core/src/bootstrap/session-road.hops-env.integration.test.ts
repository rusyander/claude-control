import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RouteEndpoint } from '@agentdeck/contracts/core/routes';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { startStubModel, type RouteRequest, type StubModel } from '@agentdeck/stub-model';
import type { StepCtx } from '../conductor/run/run.types.ts';
import { liveRoot, type LiveRoot } from '../adapters/conformance/__fixtures__/live.ts';
import {
  fixturePath,
  installReplay,
  readDump,
} from '../adapters/conformance/__fixtures__/replay.ts';
import { anthropicBody, filesContaining } from '../hop-host/__fixtures__/hop-stand.ts';
import { startHopHost, type RunningHopHost } from '../hop-host/host.ts';
import { CREATED, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../journal/resume.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { createApiKeyRoute } from '../routes/api-key/api-key.ts';
import { createRouteRegistry } from '../routes/registry.ts';
import { roadStart } from './__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from './boot.ts';
import { createSessionKeyBook } from './session-keys.ts';

/**
 * Ключ маршрута из ПИНА задачи (`keyRef: env`) на настоящей загрузке ядра (W2b, follow-up):
 * 1. Маршрут, которому нужно звено (Claude → openai-chat, перевод мостом), больше не отказывает:
 *    значение уходит хосту звеньев при регистрации и живёт в памяти метки; в окружении CLI, в
 *    argv, в доме ядра (и в файле меток хоста) его нет — CLI видит только заглушку.
 * 2. Любой ключ `env`, прочитанный дорогой, попадает в маску `known` (P61) — даже под именем,
 *    которое секретом не выглядит (`LLAMA_ACCESS`): бриф первого хода (сток модели) его прячет.
 * Хост звеньев настоящий (в процессе теста, строка `procs.json` дома ядра), верх — подставная
 * модель, CLI — запись живого Claude (сохраняет argv и окружение).
 */

const j = (...parts: string[]): string => parts.join('');
// Значения собираются из кусков: целым литералом они попали бы в сканер секретов репозитория.
const HOP_KEY = j('llama', '-access-', 'w2b-0123456789');
const DIRECT_KEY = j('plain', '-direct-', 'w2b-9876543210');
const HOP_VAR = 'LLAMA_ACCESS';
const DIRECT_VAR = 'MODEL_ACCESS';

let stub: StubModel;
let core: BootedCore;
let host: RunningHopHost;
let live: LiveRoot;
let bin: string;
const seen: RouteRequest[] = [];

function envRoute(
  routeId: string,
  apiKind: 'openai-compat' | 'anthropic',
  endpoint: () => RouteEndpoint,
) {
  return createApiKeyRoute({
    profile: {
      routeId,
      baseUrl: 'http://127.0.0.1:9',
      apiKind,
      storeId: routeId,
      keyChannel: 'hop-injected',
    },
    credentialPresent: () => true,
    hopEndpoint: async () => endpoint(),
  });
}

beforeAll(async () => {
  stub = await startStubModel({
    script: ['bridged env answer', 'direct env answer'],
    route: (request) => {
      seen.push(request);
      return undefined;
    },
  });
  core = await bootCore({
    home: join(tempDir('road-hops-env-'), 'core'),
    build: 'road-hops-env-test',
    panelAppData: null,
    loop: false,
    routes: createRouteRegistry([
      // Claude говорит Anthropic, верх — openai-chat: перевод — только звеном.
      envRoute('api-key:endpoint:llama-env', 'openai-compat', () => ({
        baseUrl: stub.baseUrl,
        dialect: 'openai-chat',
        keyRef: { kind: 'env', name: HOP_VAR },
      })),
      // Тот же диалект, звено не нужно: ключ `env` идёт в окружение CLI (так задумано).
      envRoute('api-key:endpoint:direct-env', 'anthropic', () => ({
        baseUrl: stub.baseUrl,
        dialect: 'anthropic-messages',
        keyRef: { kind: 'env', name: DIRECT_VAR },
      })),
    ]),
  });
  host = await startHopHost({ home: core.layout.root, retryPauseMs: 10 });
  live = liveRoot('road-hops-env-');
  bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  installReplay(bin, claudeRunFacts.binary.command);
}, 60_000);

afterAll(async () => {
  await core?.stop();
  await host?.close();
  await stub?.close();
});

async function prepareOn(routeId: string) {
  const task: LiveTask = await core.registry.create({
    ...CREATED,
    allowedRoutes: [
      { adapter: claudeRunFacts.id, route: { kind: 'api-key', id: routeId }, modelPattern: '*' },
    ],
  });
  const dump = join(live.root, `dump-${newId()}.json`);
  const base = roadStart({
    live,
    bin,
    task,
    adapterId: claudeRunFacts.id,
    fixture: fixturePath(claudeRunFacts.id, 'permit'),
    dump,
  });
  const start = {
    ...base,
    routeId,
    pin: { ...base.pin, [HOP_VAR]: HOP_KEY, [DIRECT_VAR]: DIRECT_KEY },
  };
  const prepared = await core.road.prepare(start);
  if (!prepared.ok) throw new Error(prepared.reason);
  return { task, p: prepared.prepared, dump };
}

async function launchAndRead(p: Awaited<ReturnType<typeof prepareOn>>['p'], dump: string) {
  const launched = await core.road.launch(p);
  if (!launched.ok) throw new Error(launched.reason);
  core.road.started(p, launched.handle, launched.layer);
  const session = core.road.attach({
    task: p.start.task,
    sessionId: p.start.sessionId,
    adapter: p.adapter,
    handle: launched.handle,
    context: p.context,
    cwd: p.start.cwd,
  });
  for (let i = 0; i < 1200 && !readDump(dump); i += 1) await new Promise((r) => setTimeout(r, 25));
  const got = readDump(dump);
  if (!got) throw new Error('no CLI dump');
  return { session, got, dumpText: readFileSync(dump, 'utf8') };
}

const envOf = (env: Record<string, string>, name: string): string | undefined =>
  Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];

/** Бриф первого хода — сток модели; секреты сеанса маскирует `known` загрузки. */
async function briefWith(
  task: LiveTask,
  p: { start: { sessionId: string; stepId: string } },
  text: string,
) {
  const ctx = {
    stepId: p.start.stepId,
    unitId: null,
    def: { kind: 'work' },
    round: 0,
  } as unknown as StepCtx;
  return core.economy.opening!(task, ctx, p.start.sessionId, [{ id: 'task', text, from: 'test' }]);
}

describe('env keyRef on the session road (W2b follow-up)', () => {
  it('a hop-needing route with a pin key goes through the hop: placeholder in the CLI, the key only upstream, never in env, argv or files', async () => {
    const before = seen.length;
    const { task, p, dump } = await prepareOn('api-key:endpoint:llama-env');
    expect(p.credentialKind).toBe('hop-injected');
    expect(p.compat).toMatchObject({ kind: 'via-gateway', to: 'openai-chat' });
    const { session, got, dumpText } = await launchAndRead(p, dump);
    // Переменная пина с ключом вычищена из окружения сеанса; CLI видит звено и заглушку.
    expect(envOf(got.env, HOP_VAR)).toBeUndefined();
    expect(envOf(got.env, 'ANTHROPIC_AUTH_TOKEN')).toMatch(/^adk-hop-/);
    expect(dumpText).not.toContain(HOP_KEY);
    // Дом ядра (там же файл меток хоста звеньев и книга имён ключей) значения не держит.
    expect(filesContaining(core.layout.root, HOP_KEY)).toEqual([]);
    expect(filesContaining(core.layout.root, HOP_VAR).length).toBeGreaterThan(0);

    const response = await fetch(`${envOf(got.env, 'ANTHROPIC_BASE_URL')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${envOf(got.env, 'ANTHROPIC_AUTH_TOKEN')}`,
      },
      body: JSON.stringify(anthropicBody('hi')),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('bridged env answer');
    const upstream = seen.slice(before).at(-1);
    expect(upstream?.path).toBe('/v1/chat/completions');
    expect(upstream?.headers.authorization).toBe(`Bearer ${HOP_KEY}`);

    // Маска `known`: имя `LLAMA_ACCESS` секретом не выглядит, но значение прочитала дорога.
    const brief = await briefWith(task, p, `ключ в тексте задачи: ${HOP_KEY}`);
    expect(brief).not.toBeNull();
    expect(brief).not.toContain(HOP_KEY);
    await session.end('tree');
  }, 120_000);

  it('a direct env route records its key too: the brief masks it although the name is not secret-looking', async () => {
    const { task, p, dump } = await prepareOn('api-key:endpoint:direct-env');
    // Звено не нужно: ключ `env` остаётся в пине сеанса (так задумано), но маске он известен.
    expect(p.hops).toEqual([]);
    const { session, got } = await launchAndRead(p, dump);
    expect(envOf(got.env, DIRECT_VAR)).toBe(DIRECT_KEY);
    const brief = await briefWith(task, p, `ключ в тексте задачи: ${DIRECT_KEY}`);
    expect(brief).not.toContain(DIRECT_KEY);
    await session.end('tree');
  }, 120_000);

  it('the key book keeps only names on disk: after a restart the value comes back from the pin', () => {
    const dir = tempDir('key-book-');
    const sessionId = newId();
    createSessionKeyBook(dir).record(sessionId, HOP_VAR, HOP_KEY);
    expect(filesContaining(dir, HOP_KEY)).toEqual([]);
    const reborn = createSessionKeyBook(dir);
    expect(reborn.valuesOf(sessionId, { [HOP_VAR]: HOP_KEY })).toEqual([HOP_KEY]);
    expect(reborn.valuesOf(sessionId, {})).toEqual([]);
    expect(reborn.valuesOf(newId(), { [HOP_VAR]: HOP_KEY })).toEqual([]);
  });
});
