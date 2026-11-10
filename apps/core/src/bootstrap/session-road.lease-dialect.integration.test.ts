import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { codexRunFacts } from '@agentdeck/providers/codex';
import { liveRoot, type LiveRoot } from '../adapters/conformance/__fixtures__/live.ts';
import { fixturePath, installReplay } from '../adapters/conformance/__fixtures__/replay.ts';
import { CREATED, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../journal/resume.ts';
import { roadStart } from './__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from './boot.ts';
import { journaledLease } from './conductor-wiring/session-start.ts';
import type { Prepared } from './session-road.ts';

/**
 * Одна задача, один маршрут на несколько диалектов (заглушка, шлюз), два CLI на нём: «Максимум
 * качества» ведёт второе ревью на codex (`openai-responses`), работу — на claude
 * (`anthropic-messages`). Аренда маршрута живёт до конца задачи, и запуск берёт из журнала прежнюю
 * аренду того же маршрута и модели — но только того диалекта, на котором заговорит ЭТА сессия:
 * сервер, поднятый под claude, codex не прочтёт (`no_channel` при запуске, шаг уходит в отказы).
 */

const ROUTE = 'stub:two';
let core: BootedCore;
let live: LiveRoot;
let bin: string;
let task: LiveTask;

beforeAll(async () => {
  core = await bootCore({
    home: join(tempDir('road-lease-dialect-'), 'core'),
    build: 'road-lease-dialect-test',
    loop: false,
    routeConfig: { stub: [{ name: 'two', models: ['stub-model'], script: ['ok'] }] },
  });
  live = liveRoot('road-lease-dialect-');
  bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  installReplay(bin, claudeRunFacts.binary.command);
  task = await core.registry.create({
    ...CREATED,
    allowedRoutes: [claudeRunFacts.id, codexRunFacts.id].map((adapter) => ({
      adapter,
      route: { kind: 'stub' as const, id: ROUTE },
      modelPattern: '*',
    })),
  });
}, 60_000);

afterAll(async () => {
  await core?.stop();
}, 60_000);

/** Подготовка сессии так, как её зовёт запуск шага: аренда — из журнала задачи (`session-start`). */
async function prepareOn(adapterId: string): Promise<Prepared> {
  const lease = journaledLease(task, ROUTE, 'stub-model');
  const start = {
    ...roadStart({
      live,
      bin,
      task,
      adapterId,
      fixture: fixturePath(claudeRunFacts.id, 'permit'),
      dump: join(live.root, `dump-${adapterId}.json`),
    }),
    routeId: ROUTE,
    ...(lease ? { lease } : {}),
  };
  const got = await core.road.prepare(start);
  if (!got.ok) throw new Error(got.reason);
  return got.prepared;
}

describe('session road: a journaled route lease is reused only in the dialect the session speaks', () => {
  it('claude then codex then claude on one stub route: codex gets an openai-responses server, claude gets its first server back', async () => {
    const first = await prepareOn(claudeRunFacts.id);
    expect(first.spec.endpoint?.endpoint.dialect).toBe('anthropic-messages');

    const cross = await prepareOn(codexRunFacts.id);
    expect(cross.spec.endpoint?.channel.dialect).toBe('openai-responses');
    expect(cross.spec.endpoint?.endpoint.dialect).toBe('openai-responses');
    expect(cross.spec.endpoint?.endpoint.baseUrl).not.toBe(first.spec.endpoint?.endpoint.baseUrl);

    const again = await prepareOn(claudeRunFacts.id);
    expect(again.spec.endpoint?.endpoint.dialect).toBe('anthropic-messages');
    expect(again.spec.endpoint?.endpoint.baseUrl).toBe(first.spec.endpoint?.endpoint.baseUrl);
  }, 60_000);
});
