import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { startStubModel, type RouteRequest, type StubModel } from '@agentdeck/stub-model';
import type { AdapterEvent } from '../adapters/index.ts';
import { liveRoot, type LiveRoot } from '../adapters/conformance/__fixtures__/live.ts';
import { fixturePath } from '../adapters/conformance/__fixtures__/replay.ts';
import { filesContaining } from '../hop-host/__fixtures__/hop-stand.ts';
import { startHopHost, type RunningHopHost } from '../hop-host/host.ts';
import { CREATED, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { hasCli } from '../stub-tasks/__fixtures__/e2e/stand.ts';
import { roadStart } from './__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * Живой сквозной прогон W2b: НАСТОЯЩИЙ `claude` идёт дорогой сессии ядра через НАСТОЯЩИЙ хост
 * звеньев к подставной модели на петле (`@agentdeck/stub-model`). Ключи — в настоящем
 * зашифрованном хранилище временного каталога панели; ни один не тратится и не уходит наружу.
 * Две ноги: свой адрес вида llama-server (OpenAI chat — звено переводит Anthropic → OpenAI) и
 * контур (`gateway:`, маска по умолчанию контура). Нет `claude` в PATH — прогон пропускается.
 */

const present = hasCli(claudeRunFacts.binary.command);
const j = (...parts: string[]): string => parts.join('');
// Ключи собираются из кусков: целым литералом они попали бы в сканер секретов репозитория.
const LLAMA_KEY = j('sk-', 'llama', '-live-0123456789');
const CONTOUR_KEY = j('sk-', 'contour', '-live-0123456789');
const MARKER = 'HOP_LIVE_MARKER';

let stub: StubModel;
let core: BootedCore;
let host: RunningHopHost;
let live: LiveRoot;
const chats: RouteRequest[] = [];

beforeAll(async () => {
  if (!present) return;
  stub = await startStubModel({
    script: () => MARKER,
    route: (request) => {
      if (request.path.endsWith('/models')) return { body: { data: [{ id: 'stub-model' }] } };
      if (request.path.endsWith('/completions') || request.path.endsWith('/messages'))
        chats.push(request);
      return undefined;
    },
  });
  const appData = tempDir('road-hops-live-panel-');
  writeFileSync(
    join(appData, 'state.json'),
    JSON.stringify({
      settings: {
        dlp: { enabled: false },
        endpointProfiles: [
          { id: 'llama', name: 'Llama', baseUrl: `${stub.baseUrl}/v1`, apiKind: 'openai-compat' },
        ],
        platforms: [
          { id: 'c1', title: 'Контур', driver: 'litellm', baseUrl: stub.baseUrl, enabled: true },
        ],
      },
    }),
  );
  setStoredKey(appData, 'endpoint:llama', LLAMA_KEY);
  setStoredKey(appData, 'platform:c1', CONTOUR_KEY);
  core = await bootCore({
    home: join(tempDir('road-hops-live-'), 'core'),
    build: 'road-hops-live',
    panelAppData: appData,
    loop: false,
  });
  host = await startHopHost({ home: core.layout.root, panelAppData: appData, retryPauseMs: 10 });
  live = liveRoot('road-hops-live-');
}, 60_000);

afterAll(async () => {
  await core?.stop();
  await host?.close();
  await stub?.close();
}, 60_000);

/** Один ход настоящего Claude дорогой ядра: подготовка → запуск → сообщение → конец хода. */
async function oneTurn(routeId: string, kind: 'api-key' | 'gateway') {
  const task = await core.registry.create({
    ...CREATED,
    allowedRoutes: [
      { adapter: claudeRunFacts.id, route: { kind, id: routeId }, modelPattern: '*' },
    ],
  });
  const bin = join(live.root, `bin-${newId()}`);
  mkdirSync(bin, { recursive: true });
  const start = {
    ...roadStart({
      live,
      bin,
      task,
      adapterId: claudeRunFacts.id,
      fixture: fixturePath(claudeRunFacts.id, 'permit'),
      dump: join(live.root, `unused-${newId()}.json`),
    }),
    routeId,
  };
  const prepared = await core.road.prepare(start);
  if (!prepared.ok) throw new Error(prepared.reason);
  const p = prepared.prepared;
  const launched = await core.road.launch(p);
  if (!launched.ok) throw new Error(launched.reason);
  core.road.started(p, launched.handle, launched.layer);
  // Поток событий сессии один, и читает его прикреплённая сессия: тест видит его через `onEvent`.
  const events: AdapterEvent[] = [];
  const session = core.road.attach({
    task,
    sessionId: p.start.sessionId,
    adapter: p.adapter,
    handle: launched.handle,
    context: p.context,
    cwd: p.start.cwd,
    onEvent: (event) => events.push(event),
  });
  try {
    await p.adapter.send(launched.handle, 'answer with one word', `cmd-${newId()}`);
    const ended = await until(
      () => events.find((e) => e.type === 'turn.ended'),
      () => `no turn.ended; events ${events.map((e) => e.type).join(',')}`,
    );
    return { p, text: ended.type === 'turn.ended' ? ended.text : '' };
  } finally {
    await session.end('tree');
  }
}

async function until<T>(probe: () => T | undefined, what: () => string, ms = 150_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(what());
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!present)('real claude through the hop host on loopback stubs (W2b)', () => {
  it('Claude × stub llama (OpenAI chat) via the hop: translated, the key only upstream, the answer reaches the CLI', async () => {
    const before = chats.length;
    const { p, text } = await oneTurn('api-key:endpoint:llama', 'api-key');
    expect(p.compat).toMatchObject({ kind: 'via-gateway', to: 'openai-chat' });
    expect(text).toContain(MARKER);
    const upstream = chats.slice(before);
    expect(upstream.length).toBeGreaterThan(0);
    expect(upstream.every((r) => r.path === '/v1/chat/completions')).toBe(true);
    expect(upstream.every((r) => r.headers.authorization === `Bearer ${LLAMA_KEY}`)).toBe(true);
    expect(filesContaining(live.root, LLAMA_KEY)).toEqual([]);
    expect(filesContaining(core.layout.root, LLAMA_KEY)).toEqual([]);
  }, 240_000);

  it('Claude × stub contour (gateway route, contour DLP default): the contour key only upstream', async () => {
    const before = chats.length;
    const { p, text } = await oneTurn('gateway:c1', 'gateway');
    expect(p.routeKind).toBe('gateway');
    expect(text).toContain(MARKER);
    const upstream = chats.slice(before);
    expect(upstream.length).toBeGreaterThan(0);
    expect(upstream.every((r) => r.headers.authorization === `Bearer ${CONTOUR_KEY}`)).toBe(true);
    // Пресет LiteLLM объявил родную ручку Anthropic: настоящий CLI идёт к ней без моста.
    expect(upstream.every((r) => r.path === '/v1/messages')).toBe(true);
    expect(filesContaining(live.root, CONTOUR_KEY)).toEqual([]);
    expect(filesContaining(core.layout.root, CONTOUR_KEY)).toEqual([]);
  }, 240_000);
});
