import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOURNAL_DATA_V1 } from '@agentdeck/contracts/core/journal';
import { startStubForge, type StubForge } from '@agentdeck/stub-forge';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createForgePort } from '../../adapters/forge/index.ts';
import type { AnswerTaskRequest, WatchedMr } from '../../publisher/events/poll.ts';
import { createForgePoller, PENDING_MAX } from './poller.ts';

/**
 * Опрос форжа (05:77, G2): выключен по умолчанию; включённый — только читает, на новую заметку
 * ДРУГОЙ учётки просит одну новую задачу ответов со строками `forge.event {source:'poller'}`;
 * свои заметки публикатора — не повод; перезапуск и повтор опроса задачу второй раз не открывают;
 * сбой чтения — ни одной просьбы и отметка на месте.
 */

/** Исходный репозиторий задачи — по нему человек включает опрос. */
const REPO = join(tmpdir(), 'poller-src', 'App');

const roots: string[] = [];
const stateFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-poller-'));
  roots.push(dir);
  return join(dir, 'forge-poller.json');
};
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

let stub: StubForge | undefined;
afterEach(async () => {
  await stub?.stop();
  stub = undefined;
});

describe.each(['gitlab', 'github'] as const)('forge poller on %s', (kind) => {
  async function world(now?: () => number) {
    stub = await startStubForge(now ? { now } : {});
    const s = stub;
    const url = `${s.url}/acme/app.git`;
    const port = createForgePort({
      project: { kind, ref: 'acme/app', baseUrl: s.url, pushUrl: url },
      token: s.tokens.publisher!,
      fetch: globalThis.fetch,
      timeoutMs: 500,
    });
    const mr = await port.createMr({
      sourceBranch: 'feat',
      targetBranch: 'main',
      title: 't',
      body: 'b',
      draft: false,
    });
    if (!('value' in mr)) throw new Error('stub MR not created');
    const watched: WatchedMr[] = [
      { taskId: 'task-1', unitId: 'u1', repo: REPO, remote: 'origin', url, mrIid: mr.value.iid },
    ];
    const requests: AnswerTaskRequest[] = [];
    return { s, url, port, iid: mr.value.iid, watched, requests };
  }

  it('off by default: nothing is read, no state file, no request', async () => {
    const w = await world();
    const file = stateFile();
    const before = w.s.requests.length;
    const poller = createForgePoller({
      watched: () => w.watched,
      request: (r) => void w.requests.push(r),
      stateFile: file,
      forgeFor: () => w.port,
    });
    w.s.act('reviewer', { type: 'note', mrIid: w.iid, body: 'please fix' });
    expect(await poller.tick()).toEqual({ polled: [], requested: 0, unknown: {} });
    expect(w.s.requests.length).toBe(before);
    expect(existsSync(file)).toBe(false);
    expect(w.requests).toEqual([]);
  });

  it('enabled: a reviewer note opens one request; own notes, repeats and a restart do not', async () => {
    const w = await world();
    const file = stateFile();
    const make = () =>
      createForgePoller({
        enabled: () => ({ repos: [REPO] }),
        watched: () => w.watched,
        request: (r) => void w.requests.push(r),
        stateFile: file,
        forgeFor: () => w.port,
      });
    const poller = make();
    expect((await poller.tick()).polled).toEqual([w.url]);
    expect(w.requests).toEqual([]);
    const writesBefore = w.s.requests.filter((r) => r.method !== 'GET').length;
    await new Promise((r) => setTimeout(r, 5));
    w.s.act('publisher', { type: 'note', mrIid: w.iid, body: 'own note' });
    w.s.act('reviewer', { type: 'note', mrIid: w.iid, body: 'please fix' });
    expect((await poller.tick()).requested).toBe(1);
    expect(w.requests).toHaveLength(1);
    const [req] = w.requests;
    expect(req).toMatchObject({ fromTaskId: 'task-1', url: w.url, mrIid: w.iid });
    expect(req!.events.map((e) => [e.source, e.author, e.type])).toEqual([
      ['poller', 'reviewer', 'note'],
    ]);
    for (const e of req!.events)
      expect(JOURNAL_DATA_V1['forge.event'].safeParse(e).success).toBe(true);

    expect((await poller.tick()).requested).toBe(0);
    expect((await make().tick()).requested).toBe(0);
    await new Promise((r) => setTimeout(r, 5));
    w.s.act('reviewer', { type: 'note', mrIid: w.iid, body: 'one more' });
    expect((await make().tick()).requested).toBe(1);
    expect(w.requests).toHaveLength(2);
    // Опрос только читает: ни одной записи в форж (GraphQL-чтение GitHub тоже не звалось).
    expect(w.s.requests.filter((r) => r.method !== 'GET').length).toBe(writesBefore);
  });

  it('a failed request is asked again next tick; an unreadable forge asks nothing', async () => {
    const w = await world();
    const file = stateFile();
    let refuse = true;
    const poller = createForgePoller({
      enabled: () => ({ repos: [REPO] }),
      watched: () => w.watched,
      request: (r) => {
        if (refuse) throw new Error('task port busy');
        w.requests.push(r);
      },
      stateFile: file,
      forgeFor: () => w.port,
    });
    await poller.tick();
    await new Promise((r) => setTimeout(r, 5));
    w.s.act('reviewer', { type: 'note', mrIid: w.iid, body: 'please fix' });
    expect((await poller.tick()).requested).toBe(0);
    w.s.fault({ kind: 'status', status: 503 });
    refuse = false;
    const down = await poller.tick();
    expect(down.requested).toBe(0);
    expect(down.unknown[w.url]).toMatch(/503|5xx|unknown|status/i);
    w.s.clearFaults();
    expect((await poller.tick()).requested).toBe(1);
    expect(w.requests).toHaveLength(1);
  });

  it('another repo enabled, or a config problem: watched() is not read, nothing asked', async () => {
    const w = await world();
    const logs: string[] = [];
    let reads = 0;
    const make = (repos: string[], problem?: string) =>
      createForgePoller({
        enabled: () => ({ repos, ...(problem ? { problem } : {}) }),
        watched: () => {
          reads += 1;
          return w.watched;
        },
        request: (r) => void w.requests.push(r),
        stateFile: stateFile(),
        forgeFor: () => w.port,
        log: (m) => logs.push(m),
      });
    expect(await make([], 'forgePoll: not an array').tick()).toEqual({
      polled: [],
      requested: 0,
      unknown: {},
    });
    expect(reads).toBe(0);
    expect(logs).toEqual(['forge poller: forgePoll: not an array']);
    expect((await make([join(tmpdir(), 'poller-src', 'Other')]).tick()).polled).toEqual([]);
    expect(reads).toBe(1);
    // Ключ пути, как у readAllow: регистр и разделители не делают репозиторий «другим» там,
    // где файловая система их не различает.
    const alias = process.platform === 'win32' ? REPO.toUpperCase().replaceAll('\\', '/') : REPO;
    expect((await make([alias]).tick()).polled).toEqual([w.url]);
  });

  it('cursor per MR: an old shared-cursor file is read as the fallback; a note on a held MR waits and comes on release while another MR moves on', async () => {
    const w = await world();
    const file = stateFile();
    const second = await w.port.createMr({
      sourceBranch: 'feat-2',
      targetBranch: 'main',
      title: 't2',
      body: 'b2',
      draft: false,
    });
    if (!('value' in second)) throw new Error('stub MR 2 not created');
    const two: WatchedMr = { ...w.watched[0]!, taskId: 'task-2', mrIid: second.value.iid };
    // Файл прежнего вида: одна общая отметка проекта, своих у MR нет.
    writeFileSync(file, JSON.stringify({ [w.url]: { cursor: Date.now() - 1000, seen: [] } }));
    await new Promise((r) => setTimeout(r, 5));
    w.s.act('reviewer', { type: 'note', mrIid: w.iid, body: 'on the held MR' });
    w.s.act('reviewer', { type: 'note', mrIid: two.mrIid, body: 'on the other MR' });
    let held = true;
    const poller = createForgePoller({
      enabled: () => ({ repos: [REPO] }),
      watched: () => [{ ...w.watched[0]!, ...(held ? { held: true } : {}) }, two],
      request: (r) => void w.requests.push(r),
      stateFile: file,
      forgeFor: () => w.port,
    });
    expect((await poller.tick()).requested).toBe(1);
    expect(w.requests.map((r) => r.mrIid)).toEqual([two.mrIid]);
    await new Promise((r) => setTimeout(r, 5));
    w.s.act('reviewer', { type: 'note', mrIid: two.mrIid, body: 'the other MR moves time on' });
    expect((await poller.tick()).requested).toBe(1);
    held = false;
    expect((await poller.tick()).requested).toBe(1);
    expect(w.requests.map((r) => r.mrIid)).toEqual([two.mrIid, two.mrIid, w.iid]);
    expect(w.requests[2]!.events.map((e) => e.author)).toEqual(['reviewer']);
  });

  it('an event a task journal already holds is not asked again (crash before the marks)', async () => {
    const w = await world();
    const file = stateFile();
    const make = (seen: string[]) =>
      createForgePoller({
        enabled: () => ({ repos: [REPO] }),
        watched: () => w.watched.map((m) => ({ ...m, seen })),
        request: (r) => void w.requests.push(r),
        stateFile: file,
        forgeFor: () => w.port,
      });
    await make([]).tick();
    await new Promise((r) => setTimeout(r, 5));
    w.s.act('reviewer', { type: 'note', mrIid: w.iid, body: 'please fix' });
    const probe = createForgePoller({
      enabled: () => ({ repos: [REPO] }),
      watched: () => w.watched,
      request: (r) => void w.requests.push(r),
      stateFile: stateFile(),
      forgeFor: () => w.port,
      now: () => 0,
    });
    await probe.tick();
    const id = w.requests.splice(0)[0]!.events[0]!.forgeEventId;
    expect((await make([id]).tick()).requested).toBe(0);
    expect(w.requests).toEqual([]);
  });

  /** Часы и опросчик над ними: время событий заглушки и «сейчас» опросчика — одни. */
  async function clocked() {
    const clock = { t: Date.UTC(2026, 9, 1, 12) };
    const w = await world(() => clock.t);
    const file = stateFile();
    const logs: string[] = [];
    const make = (watched: () => WatchedMr[], request?: (r: AnswerTaskRequest) => void) =>
      createForgePoller({
        enabled: () => ({ repos: [REPO] }),
        watched,
        request: request ?? ((r) => void w.requests.push(r)),
        stateFile: file,
        forgeFor: () => w.port,
        now: () => clock.t,
        log: (m) => logs.push(m),
      });
    const marks = () =>
      (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>)[w.url]!;
    return { w, clock, file, logs, make, marks };
  }
  const MIN = 60_000;

  it('F7: a note the feed delivers late (older than an event already read) is still asked, once', async () => {
    const { w, clock, make } = await clocked();
    const poller = make(() => w.watched);
    await poller.tick();
    clock.t += 10 * MIN;
    w.s.act('publisher', { type: 'note', mrIid: w.iid, body: 'own note moves the cursor' });
    expect((await poller.tick()).requested).toBe(0);
    // Заметка ревьюера от «8 минут» приходит в ленту после события «10 минут» (задержка ленты).
    clock.t -= 2 * MIN;
    w.s.act('reviewer', { type: 'note', mrIid: w.iid, body: 'late in the feed' });
    clock.t += 3 * MIN;
    expect((await poller.tick()).requested).toBe(1);
    expect(w.requests[0]!.events.map((e) => e.author)).toEqual(['reviewer']);
    // Окно перекрывает прошлое — повтор не открывает её второй раз.
    expect((await poller.tick()).requested).toBe(0);
  });

  it('F8: an MR missing from a round starts from its publication, not from the cursor other MRs moved', async () => {
    const { w, clock, make } = await clocked();
    const second = await w.port.createMr({
      sourceBranch: 'feat-2',
      targetBranch: 'main',
      title: 't2',
      body: 'b2',
      draft: false,
    });
    if (!('value' in second)) throw new Error('stub MR 2 not created');
    const two: WatchedMr = { ...w.watched[0]!, taskId: 'task-2', mrIid: second.value.iid };
    const one: WatchedMr = { ...w.watched[0]!, publishedAt: clock.t + MIN };
    let list: WatchedMr[] = [two];
    const poller = make(() => list);
    await poller.tick();
    // MR one опубликован, но в круг не попал (журнал на миг не прочитался); заметка в него, потом
    // соседний MR уводит отметку проекта на 8 часов вперёд.
    clock.t += 2 * MIN;
    w.s.act('reviewer', { type: 'note', mrIid: one.mrIid, body: 'on the missing MR' });
    clock.t += 8 * 60 * MIN;
    w.s.act('publisher', { type: 'note', mrIid: two.mrIid, body: 'moves time on' });
    expect((await poller.tick()).requested).toBe(0);
    list = [one, two];
    expect((await poller.tick()).requested).toBe(1);
    expect(w.requests.map((r) => r.mrIid)).toEqual([one.mrIid]);
  });

  it('a refused request keeps the note waiting while the MR cursor moves on; opt-in history is never a cause', async () => {
    const { w, clock, make, marks } = await clocked();
    // До включения опроса — история, не повод (даже внутри окна запаса).
    w.s.act('reviewer', { type: 'note', mrIid: w.iid, body: 'before opt-in' });
    clock.t += MIN;
    let refuse = true;
    const poller = make(
      () => w.watched,
      (r) => {
        if (refuse) throw new Error('preflight refused');
        w.requests.push(r);
      },
    );
    await poller.tick();
    const start = marks().start as number;
    expect(start).toBe(clock.t);
    clock.t += MIN;
    w.s.act('reviewer', { type: 'note', mrIid: w.iid, body: 'after opt-in' });
    clock.t += MIN;
    expect((await poller.tick()).requested).toBe(0);
    const held = marks();
    // Отметка MR ушла вперёд, заметка ждёт в `pending` — окно запроса не растёт.
    expect((held.mrs as Record<string, number>)[String(w.iid)]).toBe(start + MIN);
    expect((held.pending as Record<string, unknown[]>)[String(w.iid)]).toHaveLength(1);
    refuse = false;
    clock.t += 30 * MIN;
    expect((await poller.tick()).requested).toBe(1);
    expect(w.requests[0]!.events).toHaveLength(1);
    expect(marks().pending).toBeUndefined();
    expect((await poller.tick()).requested).toBe(0);
  });

  it(`a held MR keeps at most ${PENDING_MAX} waiting notes, says what it dropped, and asks them all on release`, async () => {
    const { w, clock, make, logs, marks } = await clocked();
    let held = true;
    const poller = make(() => w.watched.map((m) => ({ ...m, ...(held ? { held: true } : {}) })));
    await poller.tick();
    clock.t += 1000;
    w.s.act('reviewer', { type: 'note', mrIid: w.iid, body: 'the oldest' });
    // Остальные — позже запаса окна: на отпуске лента старейшую заново не вернёт.
    clock.t += 7 * 60 * MIN;
    for (let i = 0; i < PENDING_MAX; i += 1) {
      clock.t += 1000;
      w.s.act('reviewer', { type: 'note', mrIid: w.iid, body: `note ${i}` });
    }
    expect((await poller.tick()).requested).toBe(0);
    expect((marks().pending as Record<string, unknown[]>)[String(w.iid)]).toHaveLength(PENDING_MAX);
    expect(logs.filter((l) => /1 waiting note\(s\) over \d+ dropped/.test(l))).toHaveLength(1);
    held = false;
    expect((await poller.tick()).requested).toBe(1);
    expect(w.requests[0]!.events).toHaveLength(PENDING_MAX);
  });
});

describe('forge poller timer', () => {
  it('a round slower than the interval is never overlapped; stop() waits for the round in flight', async () => {
    let running = 0;
    let peak = 0;
    let rounds = 0;
    let release: (() => void) | undefined;
    const poller = createForgePoller({
      enabled: () => ({ repos: [REPO] }),
      // Медленный круг: пока он идёт, таймер успевает отсчитать много шагов.
      watched: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((r) => {
          release = r;
          setTimeout(r, 60);
        });
        running -= 1;
        rounds += 1;
        return [];
      },
      request: () => undefined,
      stateFile: stateFile(),
      intervalMs: 5,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 200));
    await poller.stop();
    expect(peak).toBe(1);
    expect(running).toBe(0);
    const after = rounds;
    release?.();
    await new Promise((r) => setTimeout(r, 40));
    expect(rounds).toBe(after);
  });
});
