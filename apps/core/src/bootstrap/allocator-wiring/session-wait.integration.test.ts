import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EstimateReply } from '@agentdeck/contracts/core/estimate';
import type { SessionTicket } from '@agentdeck/contracts/core/records';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStand, TOKENS, type Stand } from '../../api/__fixtures__/api-harness.ts';
import { SESSION_WAIT_SIGNAL } from '../../conductor/intake/index.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import {
  estimateBody,
  gitRepo,
  testEnv,
  type TestEnv,
} from '../../conductor/split/__fixtures__/split-stand.ts';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { ensureDir } from '../../platform/safe-io/files.ts';
import type { RouteRegistry } from '../../routes/registry.ts';
import { seatsDirOf } from '../../verifier/queue/session.ts';
import type { SeatFile } from '../../verifier/queue/session.types.ts';
import { createAllocatorWiring, type AllocatorWiring } from './index.ts';

/**
 * Ожидание места первого сеанса на оценке ведущего (W3-16): настоящая ручка `POST /v1/estimate`
 * (Fastify, суд полномочий, git), настоящая проводка распределителя над файлами мест машины,
 * настоящее выученное (`readLearned` над законченными журналами дома стенда). Подменены только
 * пробы дорог предпроверки (стенд D). Ёмкость — `parallelism(task)` проводки: профиль
 * «Сбалансировано» (4) под `sessionSlots` по умолчанию (6).
 */

let root: string;
let stand: Stand;
let env: TestEnv;
let wiring: AllocatorWiring;
let queueDir: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'core-wait-'));
  stand = await startStand();
  queueDir = tempDir('wait-machine-');
  wiring = createAllocatorWiring({
    layout: stand.layout,
    note: () => undefined,
    registry: () => stand.registry,
    routes: () => ({}) as RouteRegistry,
    queueDir,
  });
  const conductor = wiring.conductor();
  env = {
    ...testEnv(stand.layout.scenarios),
    capacity: (task) => ({ slots: conductor.parallelism(task), minutes: null }),
    sessionOccupancy: conductor.occupancy,
  };
  stand.setSplit(env);
});
afterAll(async () => {
  await wiring.stop();
  await stand.close();
  for (const dir of [root, queueDir])
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Место машины: держит (`holder`) или ждёт с причиной (`slot` / `route`); чат — вне счёта. */
function seat(kind: 'holder' | 'slot' | 'route' | 'chat'): void {
  const ticketId = newId();
  const held = kind === 'holder' || kind === 'chat';
  const ticket: SessionTicket = {
    ticketId,
    kind: 'session',
    class: 'work' as SessionTicket['class'],
    project: 'other',
    taskId: newId(),
    key: null,
    enqueuedAt: 1,
    build: 'test',
    started: false,
    remainingMs: null,
    learnedMs: null,
    waitingSince: 1,
    holder: held ? { pid: 1, start: 's', sessionId: newId() } : null,
  };
  const file: SeatFile = {
    ticket,
    stepId: newId(),
    unitId: newId(),
    stepKind: kind === 'chat' ? 'chat' : 'work',
    routeId: 'stub-1',
    routeCap: null,
    limit: 4,
    interactive: kind === 'chat',
    core: { pid: 1, start: 's', bootId: newId() },
    beatAt: Date.now(),
    grantedAt: held ? 1 : null,
    reason: held ? null : kind,
  };
  const dir = seatsDirOf(queueDir);
  ensureDir(dir);
  writeFileSync(join(dir, `${ticketId}.json`), JSON.stringify(file));
}

function clearSeats(): void {
  rmSync(seatsDirOf(queueDir), { recursive: true, force: true });
}

/** Законченная задача дома стенда с сеансами названных длительностей (часы журнала стенда). */
async function finishedTask(
  sessions: { ms: number; kind?: 'chat' | 'unstarted' }[],
): Promise<void> {
  const task = await stand.registry.create({
    ...stand.registry.live(stand.taskId)!.state.created!,
  });
  for (const { ms, kind } of sessions) {
    const { sessionId } = seedSession(task, { stepKind: kind === 'chat' ? 'chat' : 'work' });
    if (kind !== 'unstarted')
      task.append({
        kind: 'session.transition',
        actor: 'core',
        sessionId,
        data: { sessionId, event: 'spawned', from: 'starting', to: 'live' },
      });
    stand.clock.advance(ms);
    task.append({
      kind: 'session.transition',
      actor: 'core',
      sessionId,
      data: {
        sessionId,
        event: 'exited',
        from: kind === 'unstarted' ? 'starting' : 'live',
        to: 'ended',
      },
    });
  }
  task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
}

async function estimate(cmdId = newId(), name = `wait-${cmdId.slice(-8)}`) {
  const repo = gitRepo(root, name, { 'README.md': 'wait\n' });
  const { nonce, page } = await stand.nonce();
  const res = await fetch(`${stand.url}/v1/estimate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKENS.core}` },
    body: JSON.stringify({
      ...estimateBody([repo], { scenario: { preset: 'lead' } }, cmdId),
      proof: { nonce, page },
    }),
  });
  const body = (await res.json()) as EstimateReply;
  if (res.status !== 202 && res.status !== 200)
    throw new Error(`estimate ${res.status}: ${JSON.stringify(body)}`);
  return { status: res.status, reply: body, repo };
}

const waitOf = (reply: EstimateReply) => reply.lead?.sessionWaitMs;

describe('stage 11 W3-16 lead estimate: expected session wait from allocator occupancy and session history', () => {
  it('a free seat → 0, even with no session history', async () => {
    clearSeats();
    seat('holder');
    seat('chat');
    const { reply } = await estimate();
    expect(reply.lead?.parallelism).toBe(4);
    expect(waitOf(reply)).toBe(0);
  });

  it('every seat taken and no finished session in history → null (not estimated), the reason journaled', async () => {
    clearSeats();
    for (let i = 0; i < 4; i += 1) seat('holder');
    const { reply } = await estimate();
    expect(waitOf(reply)).toBeNull();
    const lines = readJournalLines(stand.registry.live(reply.taskId)!.dir, reply.taskId).lines;
    const row = lines.find(
      (l) => l.kind === 'signal' && (l.data as { signal: string }).signal === SESSION_WAIT_SIGNAL,
    );
    expect(JSON.parse((row?.data as { detail: string }).detail)).toMatchObject({
      waitMs: null,
      capacity: 4,
      holders: 4,
      slotWaiters: 0,
      medianMs: null,
      samples: 0,
    });
  });

  it('seats taken with recorded history → ⌈(n − c + 1) / c⌉ × median of finished sessions; route waiters and chats are not ahead; a replay answers the journaled number', async () => {
    // Медиана трёх законченных сеансов (1, 2, 3 мин) — 2 мин; не стартовавший и чат не входят.
    // Войди они в счёт, медиана пяти была бы 3 мин.
    await finishedTask([
      { ms: 60_000 },
      { ms: 36_000_000, kind: 'chat' },
      { ms: 120_000 },
      { ms: 9_000_000, kind: 'unstarted' },
      { ms: 180_000 },
    ]);
    clearSeats();
    // Пять держащих при ёмкости 4: одному сеансу надо кончиться — одна волна, 2 мин.
    for (let i = 0; i < 5; i += 1) seat('holder');
    seat('route');
    seat('chat');
    const first = await estimate();
    expect(waitOf(first.reply)).toBe(120_000);

    // Четыре держащих и четыре ждущих места: n = 8, кончиться должны 5, по 4 сразу — две волны.
    clearSeats();
    for (let i = 0; i < 4; i += 1) seat('holder');
    for (let i = 0; i < 4; i += 1) seat('slot');
    const cmdId = newId();
    const busy = await estimate(cmdId);
    expect(busy.status).toBe(202);
    expect(waitOf(busy.reply)).toBe(240_000);

    // Повтор того же cmdId после того, как места освободились, — то же записанное число.
    clearSeats();
    const { nonce, page } = await stand.nonce();
    const res = await fetch(`${stand.url}/v1/estimate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKENS.core}` },
      body: JSON.stringify({
        ...estimateBody([busy.repo], { scenario: { preset: 'lead' } }, cmdId),
        proof: { nonce, page },
      }),
    });
    expect(res.status).toBe(200);
    expect(waitOf((await res.json()) as EstimateReply)).toBe(240_000);
  });
});
