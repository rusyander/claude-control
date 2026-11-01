import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { startStubModel, type RouteRequest, type StubModel } from '@agentdeck/stub-model';
import { liveRoot, type LiveRoot } from '../adapters/conformance/__fixtures__/live.ts';
import {
  fixturePath,
  installReplay,
  readDump,
} from '../adapters/conformance/__fixtures__/replay.ts';
import { anthropicBody, filesContaining } from '../hop-host/__fixtures__/hop-stand.ts';
import { startHopHost, type RunningHopHost } from '../hop-host/host.ts';
import { CREATED, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import type { LiveTask } from '../journal/resume.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { roadStart } from './__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from './boot.ts';
import { linkHop } from './session-road/hop-link.ts';
import type { RoadStart } from './session-road.ts';

/**
 * Дорога сессии через хост звеньев (W2b, 11 §Hop chain, G4/G5) на НАСТОЯЩЕЙ загрузке ядра:
 * профили — из каталога данных панели (временный), ключ — в её настоящем зашифрованном
 * хранилище, хост звеньев настоящий (в процессе теста, строка в `procs.json` дома ядра — его
 * находит тот же `ensureHopHost`, что у загрузки), верх — подставная модель `@agentdeck/stub-model`.
 * CLI — подставной (запись живого Claude): он сохраняет argv и окружение, в которых ключа быть
 * не должно, а запрос модели этим окружением шлёт тест — так, как его послал бы CLI.
 */

const j = (...parts: string[]): string => parts.join('');
// Ключи собираются из кусков: целым литералом они попали бы в сканер секретов репозитория.
const OWN_KEY = j('sk-', 'own', '-w2b-0123456789');
const OAI_KEY = j('sk-', 'oai', '-w2b-0123456789');
const GOOGLE_KEY = j('AIza', 'w2b', '-0123456789abcdef');
const CONTOUR_KEY = j('sk-', 'contour', '-w2b-0123456789');

let stub: StubModel;
let core: BootedCore;
let host: RunningHopHost;
let appData: string;
let live: LiveRoot;
let bin: string;
const seen: RouteRequest[] = [];
const catalogs: RouteRequest[] = [];

beforeAll(async () => {
  stub = await startStubModel({
    script: ['own answer', 'bridged answer', 'contour answer', 'after end'],
    route: (request) => {
      if (request.path.endsWith('/models')) {
        catalogs.push(request);
        return request.path.includes('/v1beta/')
          ? { body: { models: [{ name: 'models/stub-gemini' }] } }
          : { body: { data: [{ id: 'stub-model' }] } };
      }
      seen.push(request);
      return undefined;
    },
  });
  appData = tempDir('road-hops-panel-');
  writeFileSync(
    join(appData, 'state.json'),
    JSON.stringify({
      settings: {
        dlp: { enabled: false },
        endpointProfiles: [
          { id: 'own', name: 'Свой', baseUrl: stub.baseUrl, apiKind: 'anthropic' },
          { id: 'oai', name: 'Llama', baseUrl: `${stub.baseUrl}/v1`, apiKind: 'openai-compat' },
          { id: 'gem', name: 'Gemini', baseUrl: stub.baseUrl, apiKind: 'google' },
        ],
        platforms: [
          { id: 'c1', title: 'Контур', driver: 'litellm', baseUrl: stub.baseUrl, enabled: true },
          // Карточка поверх пресета: свой путь родной ручки — его знает только драйвер звена.
          {
            id: 'c2',
            title: 'Свой путь',
            driver: 'litellm',
            baseUrl: stub.baseUrl,
            enabled: true,
            manifest: { anthropicMessages: 'anthropic/messages' },
          },
          // Карточка снимает ручку пресета: мост в openai-chat.
          {
            id: 'c3',
            title: 'Без ручки',
            driver: 'litellm',
            baseUrl: stub.baseUrl,
            enabled: true,
            manifest: { anthropicMessages: '' },
          },
          // Прослойка инструментов карточки сильнее родной ручки пресета: мост + `tool-shim`.
          {
            id: 'c4',
            title: 'Прослойка',
            driver: 'litellm',
            baseUrl: stub.baseUrl,
            enabled: true,
            toolShim: true,
          },
        ],
      },
    }),
  );
  setStoredKey(appData, 'endpoint:own', OWN_KEY);
  setStoredKey(appData, 'endpoint:oai', OAI_KEY);
  setStoredKey(appData, 'endpoint:gem', GOOGLE_KEY);
  setStoredKey(appData, 'platform:c1', CONTOUR_KEY);
  setStoredKey(appData, 'platform:c2', CONTOUR_KEY);
  setStoredKey(appData, 'platform:c3', CONTOUR_KEY);
  setStoredKey(appData, 'platform:c4', CONTOUR_KEY);
  core = await bootCore({
    home: join(tempDir('road-hops-'), 'core'),
    build: 'road-hops-test',
    panelAppData: appData,
    loop: false,
  });
  // Хост звеньев этого дома — в процессе теста: ядро найдёт его по строке `procs.json`.
  host = await startHopHost({ home: core.layout.root, panelAppData: appData, retryPauseMs: 10 });
  live = liveRoot('road-hops-');
  bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  installReplay(bin, claudeRunFacts.binary.command);
}, 60_000);

afterAll(async () => {
  await core?.stop();
  await host?.close();
  await stub?.close();
});

const lines = (t: LiveTask): JournalLine[] => readJournalLines(t.dir, t.taskId).lines;

async function taskFor(routeId: string, kind: 'api-key' | 'gateway'): Promise<LiveTask> {
  return core.registry.create({
    ...CREATED,
    allowedRoutes: [
      { adapter: claudeRunFacts.id, route: { kind, id: routeId }, modelPattern: '*' },
    ],
  });
}

function startOn(task: LiveTask, routeId: string, dump: string): RoadStart {
  return {
    ...roadStart({
      live,
      bin,
      task,
      adapterId: claudeRunFacts.id,
      fixture: fixturePath(claudeRunFacts.id, 'permit'),
      dump,
    }),
    routeId,
  };
}

async function until<T>(probe: () => T | null | undefined, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Полный ход сеанса дорогой: подготовка → запуск → прикрепление; конец — по зову теста. */
async function runSession(routeId: string, kind: 'api-key' | 'gateway') {
  const task = await taskFor(routeId, kind);
  const dump = join(live.root, `dump-${newId()}.json`);
  const prepared = await core.road.prepare(startOn(task, routeId, dump));
  if (!prepared.ok) throw new Error(prepared.reason);
  const p = prepared.prepared;
  const launched = await core.road.launch(p);
  if (!launched.ok) throw new Error(launched.reason);
  core.road.started(p, launched.handle, launched.layer);
  const session = core.road.attach({
    task,
    sessionId: p.start.sessionId,
    adapter: p.adapter,
    handle: launched.handle,
    context: p.context,
    cwd: p.start.cwd,
  });
  const got = await until(() => readDump(dump));
  return { task, p, session, got, dumpText: readFileSync(dump, 'utf8') };
}

const envOf = (env: Record<string, string>, name: string): string | undefined =>
  Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];

/**
 * Запрос модели так, как его шлёт Claude Code окружением сеанса: `ANTHROPIC_BASE_URL` +
 * `/v1/messages`, заглушка из `ANTHROPIC_AUTH_TOKEN` — заголовком `Authorization: Bearer`.
 */
async function askAsClaude(env: Record<string, string>, text: string) {
  const response = await fetch(`${envOf(env, 'ANTHROPIC_BASE_URL')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      authorization: `Bearer ${envOf(env, 'ANTHROPIC_AUTH_TOKEN')}`,
    },
    body: JSON.stringify(anthropicBody(text)),
  });
  return { status: response.status, text: await response.text() };
}

describe('session road through the hop host (W2b)', () => {
  it('api-key panel-store route: the CLI gets the hop port and a placeholder, the key reaches only the upstream; session.started.hops; tag gone after end', async () => {
    const before = seen.length;
    const { task, p, session, got, dumpText } = await runSession('api-key:endpoint:own', 'api-key');
    expect(p.credentialKind).toBe('hop-injected');
    expect(p.hops).toEqual([
      { kind: expect.stringMatching(/^(dlp|gateway)$/), port: expect.any(Number) },
    ]);
    expect(envOf(got.env, 'ANTHROPIC_BASE_URL')).toBe(`http://127.0.0.1:${p.hops[0]!.port}`);
    expect(envOf(got.env, 'ANTHROPIC_AUTH_TOKEN')).toMatch(/^adk-hop-/);
    expect(envOf(got.env, 'ANTHROPIC_API_KEY') ?? '').toBe('');
    // P112: ключа нет ни в argv, ни в окружении CLI, ни в доме ядра.
    expect(dumpText).not.toContain(OWN_KEY);
    expect(filesContaining(core.layout.root, OWN_KEY)).toEqual([]);
    const started = lines(task).find((l) => l.kind === 'session.started');
    expect((started?.data as { hops: unknown[] }).hops).toEqual(p.hops);

    // Запрос CLI окружением сеанса: звено подставило настоящий ключ наверх.
    const answer = await askAsClaude(got.env, 'hi');
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('own answer');
    expect(seen.slice(before).at(-1)?.headers['x-api-key']).toBe(OWN_KEY);

    // Конец сеанса снимает метку: та же заглушка больше не открывает звено.
    await session.end('tree');
    const after = await askAsClaude(got.env, 'again');
    expect(after.status).not.toBe(200);
    expect(seen.slice(before)).toHaveLength(1);
  }, 120_000);

  it('Claude × openai-chat endpoint (llama-style): compat via-gateway is accepted, the hop translates, Bearer key upstream', async () => {
    const before = seen.length;
    const { p, session, got, dumpText } = await runSession('api-key:endpoint:oai', 'api-key');
    expect(p.compat).toMatchObject({
      kind: 'via-gateway',
      from: 'anthropic-messages',
      to: 'openai-chat',
    });
    expect(p.hops).toEqual([{ kind: 'gateway', port: host.ports.gateway }]);
    expect(dumpText).not.toContain(OAI_KEY);
    const answer = await askAsClaude(got.env, 'hi');
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('bridged answer');
    const upstream = seen.slice(before).at(-1);
    expect(upstream?.path).toBe('/v1/chat/completions');
    expect(upstream?.headers.authorization).toBe(`Bearer ${OAI_KEY}`);
    await session.end('tree');
  }, 120_000);

  it('Claude × contour gateway route: always through the hop; contour key only upstream', async () => {
    const before = seen.length;
    const { p, session, got, dumpText } = await runSession('gateway:c1', 'gateway');
    expect(p.routeKind).toBe('gateway');
    expect(p.hops).toHaveLength(1);
    expect(dumpText).not.toContain(CONTOUR_KEY);
    const answer = await askAsClaude(got.env, 'hi');
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('contour answer');
    expect(seen.slice(before).at(-1)?.headers.authorization).toBe(`Bearer ${CONTOUR_KEY}`);
    // Пресет LiteLLM объявил родную ручку Anthropic: без моста, на `…/messages` контура.
    expect(seen.slice(before).at(-1)?.path).toMatch(/\/v1\/messages$/);
    await session.end('tree');
  }, 120_000);

  it('preset manifest ⊕ card overrides reach the hop driver: a card path for the native endpoint, an emptied one bridges to chat/completions', async () => {
    const custom = seen.length;
    const a = await runSession('gateway:c2', 'gateway');
    const viaCard = await askAsClaude(a.got.env, 'hi');
    expect(viaCard.status).toBe(200);
    expect(viaCard.text).toContain('"type":"message"');
    expect(seen.slice(custom).at(-1)?.path).toMatch(/\/v1\/anthropic\/messages$/);
    await a.session.end('tree');

    const bridged = seen.length;
    const b = await runSession('gateway:c3', 'gateway');
    const viaBridge = await askAsClaude(b.got.env, 'hi');
    expect(viaBridge.status).toBe(200);
    expect(viaBridge.text).toContain('"type":"message"');
    expect(seen.slice(bridged).at(-1)?.path).toMatch(/\/chat\/completions$/);
    await b.session.end('tree');
  }, 120_000);

  it('card tool shim reaches the hop as feature tool-shim: bridged, no tools field upstream, tools travel as protocol text', async () => {
    const before = seen.length;
    const s = await runSession('gateway:c4', 'gateway');
    const response = await fetch(`${envOf(s.got.env, 'ANTHROPIC_BASE_URL')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${envOf(s.got.env, 'ANTHROPIC_AUTH_TOKEN')}`,
      },
      body: JSON.stringify({
        ...anthropicBody('hi'),
        tools: [
          {
            name: 'Read',
            description: 'read a file',
            input_schema: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const upstream = seen.slice(before).at(-1);
    expect(upstream?.path).toMatch(/\/chat\/completions$/);
    const body = upstream?.body as { tools?: unknown; messages: { content: unknown }[] };
    expect(body.tools).toBeUndefined();
    const text = JSON.stringify(body.messages);
    expect(text).toContain('<tool_call>');
    expect(text).toContain('Read');
    await s.session.end('tree');
  }, 120_000);

  it('keyed catalog probe of R goes through the hop op probe: the key in the vendor header, Google in x-goog-api-key, never in the URL', async () => {
    catalogs.length = 0;
    const own = await core.routes.get('api-key:endpoint:own')!.read.models();
    expect(own).toEqual({ value: [{ id: 'stub-model' }] });
    expect(catalogs.at(-1)?.headers['x-api-key']).toBe(OWN_KEY);
    const gem = await core.routes.get('api-key:endpoint:gem')!.read.models();
    expect(gem).toEqual({ value: [{ id: 'stub-gemini' }] });
    const google = catalogs.at(-1)!;
    expect(google.path).toBe('/v1beta/models');
    expect(google.headers['x-goog-api-key']).toBe(GOOGLE_KEY);
    expect(JSON.stringify(google.query ?? {})).not.toContain(GOOGLE_KEY);
    expect(filesContaining(core.layout.root, GOOGLE_KEY)).toEqual([]);
  }, 60_000);

  it('a hop-needing env key missing from the task pin is refused before the hop is called (the positive path: session-road.hops-env)', async () => {
    const route = core.routes.get('api-key:endpoint:own')!;
    const refused = await linkHop({
      hops: {
        handle: () => Promise.reject(new Error('must not be called')),
        factsOf: () => ({
          driver: null,
          dlpRequired: true,
          upstreamAuth: null,
          upstreamHeaders: {},
          upstreamQuery: {},
          upstreamRooted: false,
        }),
      },
      reason: 'policy requires DLP',
      sessionId: newId(),
      route,
      endpoint: {
        baseUrl: stub.baseUrl,
        dialect: 'anthropic-messages',
        keyRef: { kind: 'env', name: 'MY_KEY' },
      },
      channel: { kind: 'endpoint', dialect: 'anthropic-messages' } as never,
      compat: { kind: 'direct' } as never,
      pin: { OTHER: OWN_KEY },
    });
    expect(refused).toEqual({
      refused: expect.stringMatching(/key variable MY_KEY not in the task pin/),
    });
  });
});
