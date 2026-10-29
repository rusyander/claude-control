import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../lib/ids/uuidv7.ts';
import { startStand, TOKENS, type Stand } from './__fixtures__/api-harness.ts';

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

/**
 * Читатель потока SSE, который ждёт сами события, а не время. Прежний вариант гонял
 * `reader.read()` наперегонки с тиком в 200 мс и бросал проигравшее чтение: кусок, пришедший
 * после паузы длиннее тика (параллельная нагрузка), доставался брошенному чтению и терялся —
 * отсюда `[3,4,5]` вместо `[3..7]`. Здесь одно незавершённое чтение живёт между ожиданиями, а
 * срок — только щедрая защита от зависания.
 */
function sseReader(res: Response): {
  until: (count: number, ms?: number) => Promise<number[]>;
  cancel: () => Promise<void>;
  ended: () => boolean;
} {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no body');
  const ids: number[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  let pending: ReturnType<typeof reader.read> | undefined;
  let ended = false;
  const until = async (count: number, ms = 30_000): Promise<number[]> => {
    const deadline = Date.now() + ms;
    while (ids.length < count && !ended) {
      pending ??= reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const left = Math.max(0, deadline - Date.now());
      const chunk = await Promise.race([
        pending,
        new Promise<'deadline'>((r) => (timer = setTimeout(() => r('deadline'), left))),
      ]);
      clearTimeout(timer);
      if (chunk === 'deadline') break;
      pending = undefined;
      if (chunk.done) ended = true;
      else buffer += decoder.decode(chunk.value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const id = /^id: (\d+)$/m.exec(frame)?.[1];
        if (id) ids.push(Number(id));
      }
    }
    return [...ids];
  };
  return { until, cancel: () => reader.cancel(), ended: () => ended };
}

describe('core API reads', () => {
  it('reads need the core token or the panel Bearer; a session token and no token are 401', async () => {
    stand = await startStand();
    expect((await stand.get('/v1/health', '')).status).toBe(401);
    expect((await stand.get('/v1/health', TOKENS.session)).status).toBe(401);
    expect((await stand.get('/v1/health', TOKENS.panel)).status).toBe(200);
    const health = (await (await stand.get('/v1/health')).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ ok: true, build: 'test', liveTasks: 1 });
    const tasks = (await (await stand.get('/v1/tasks')).json()) as { tasks: { taskId: string }[] };
    expect(tasks.tasks.map((t) => t.taskId)).toEqual([stand.taskId]);
    expect((await stand.get(`/v1/tasks/${stand.taskId}`)).status).toBe(200);
    expect((await stand.get(`/v1/tasks/${newId()}`)).status).toBe(404);
    expect((await stand.get('/v1/tasks/not-an-id')).status).toBe(400);
    expect((await stand.get('/v1/routes')).status).toBe(501);
    expect((await stand.get('/v1/nonce?page=x')).status).toBe(400);
    expect((await stand.get('/v1/nonce', TOKENS.session)).status).toBe(401);
  });

  it('m6 health carries queue depth, the window and journal lag (07)', async () => {
    stand = await startStand();
    const task = stand.registry.live(stand.taskId);
    if (!task) throw new Error('task not live');
    const health = async () =>
      (await (await stand!.get('/v1/health')).json()) as Record<string, unknown>;
    expect(await health()).toMatchObject({
      queue: { commandsInFlight: 0, commandsPending: 0 },
      window: { unknown: expect.stringContaining('economy/window') },
      journalLagMs: 0,
    });
    // Телеметрия ждёт пачечного fsync — отставание видно, пока он не прошёл.
    task.append({
      kind: 'tool.event',
      actor: 'core',
      data: { sessionId: newId(), effectClass: 'read', target: 'f', ms: 1 },
    });
    stand.clock.advance(700);
    expect((await health()).journalLagMs).toBe(700);
    // Решение синхронизирует файл целиком — отставание обнуляется.
    task.append({ kind: 'error', actor: 'core', data: { code: 'x', detail: '' } });
    expect((await health()).journalLagMs).toBe(0);
    // Команда, ждущая доказательства, — в очереди.
    const { nonce, page } = await stand.nonce();
    stand.peer.delayMs = 400;
    const sent = stand.command(stand.envelope('launch', {}, { proof: { nonce, page } }));
    await new Promise((r) => setTimeout(r, 100));
    expect((await health()).queue).toEqual({ commandsInFlight: 1, commandsPending: 0 });
    expect((await sent).status).toBe(200);
    expect((await health()).queue).toEqual({ commandsInFlight: 0, commandsPending: 0 });
  });

  it('SSE: Last-Event-ID replays only what was missed, then live events follow, no seq twice', async () => {
    stand = await startStand();
    const task = stand.registry.live(stand.taskId);
    if (!task) throw new Error('task not live');
    for (let i = 0; i < 3; i += 1) {
      task.append({ kind: 'error', actor: 'core', data: { code: `e${i}`, detail: '' } });
    }
    const total = task.state.seq;
    const res = await stand.get(`/v1/tasks/${stand.taskId}/events`, TOKENS.core, {
      'last-event-id': '2',
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const stream = sseReader(res);
    // Сначала дождаться самого повтора пропущенного — живые события пишутся уже после него.
    const replayed = Array.from({ length: total - 2 }, (_, i) => i + 3);
    expect(await stream.until(replayed.length)).toEqual(replayed);
    // Пауза длиннее любого тика опроса — то, что под нагрузкой и теряло живые события.
    await new Promise((r) => setTimeout(r, 400));
    task.append({ kind: 'error', actor: 'core', data: { code: 'live-1', detail: '' } });
    task.append({ kind: 'error', actor: 'core', data: { code: 'live-2', detail: '' } });
    const ids = await stream.until(replayed.length + 2);
    await stream.cancel();
    expect(ids).toEqual([...replayed, total + 1, total + 2]);
  });

  it('M2 SSE on a task not live at subscribe: replay first, then live events once a command opens it', async () => {
    stand = await startStand();
    stand.registry.drop(stand.taskId);
    expect(stand.registry.live(stand.taskId)).toBeUndefined();
    const res = await stand.get(`/v1/tasks/${stand.taskId}/events`, TOKENS.core);
    const stream = sseReader(res);
    const onDisk = stand.registry.view(stand.taskId)?.seq ?? 0;
    expect(await stream.until(onDisk)).toEqual(Array.from({ length: onDisk }, (_, i) => i + 1));
    const { nonce, page } = await stand.nonce();
    const cmd = await stand.command(stand.envelope('launch', {}, { proof: { nonce, page } }));
    expect(cmd.status).toBe(200);
    const applied = cmd.body.seq as number;
    const ids = await stream.until(applied);
    await stream.cancel();
    expect(ids).toEqual(Array.from({ length: applied }, (_, i) => i + 1));
  });

  it('M2 SSE closes the stream when the task leaves the live set (lease lost), never pings forever', async () => {
    stand = await startStand();
    const res = await stand.get(`/v1/tasks/${stand.taskId}/events`, TOKENS.core);
    const stream = sseReader(res);
    const seq = stand.registry.live(stand.taskId)?.state.seq ?? 0;
    await stream.until(seq);
    stand.registry.drop(stand.taskId);
    await stream.until(Number.MAX_SAFE_INTEGER, 5_000);
    expect(stream.ended()).toBe(true);
  });

  it('m2 ?from=<seq> starts AT that seq; a reconnect Last-Event-ID header wins over the URL', async () => {
    stand = await startStand();
    const task = stand.registry.live(stand.taskId);
    if (!task) throw new Error('task not live');
    for (let i = 0; i < 3; i += 1) {
      task.append({ kind: 'error', actor: 'core', data: { code: `e${i}`, detail: '' } });
    }
    const seq = task.state.seq;
    const fromTwo = sseReader(
      await stand.get(`/v1/tasks/${stand.taskId}/events?from=2`, TOKENS.core),
    );
    const got = await fromTwo.until(seq - 1);
    await fromTwo.cancel();
    expect(got[0]).toBe(2);
    const reconnect = sseReader(
      await stand.get(`/v1/tasks/${stand.taskId}/events?from=2`, TOKENS.core, {
        'last-event-id': '2',
      }),
    );
    const again = await reconnect.until(seq - 2);
    await reconnect.cancel();
    expect(again[0]).toBe(3);
  });
});
