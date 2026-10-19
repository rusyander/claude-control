import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../lib/app-store/app-store.types.ts';
import {
  STALL_POLL_MS,
  STALL_SILENT_MS,
  createSplitStallWatch,
  transcriptActivity,
  type SplitStallDeps,
  type StallStopOutcome,
} from './split-stall.ts';

const MIN = 60_000;

/**
 * Сторож повисших групп (строка 8 плана скорости гейтов). Журнал 19.10: две группы
 * стояли «работает» 4 ч после того, как перезапуск панели снял процесс их проверки, —
 * CLI ждал итога вызова, которого уже не было. Часы и транскрипт подменены, решение
 * сторожа — настоящее.
 */
function harness(
  options: {
    status?: SplitPlanGroupRecord['status'];
    lastActivity?: number | undefined;
    alive?: boolean;
    pending?: boolean;
    stop?: StallStopOutcome;
    resumed?: boolean;
    diagnose?: SplitStallDeps['diagnose'];
  } = {},
) {
  let now = 1_000_000_000;
  const group = {
    index: 0,
    title: 'Группа А',
    branch: 'feat/a',
    after: [],
    status: options.status ?? 'started',
    chatId: 'chat-a',
  } as unknown as SplitPlanGroupRecord;
  const record = { parentChatId: 'родитель', groups: [group] } as unknown as SplitPlanRecord;
  const stops: string[] = [];
  const interrupts: number[] = [];
  const notices: { minutes: number; resumed: boolean; logPath?: string }[] = [];
  let activity = 'lastActivity' in options ? options.lastActivity : now;
  const deps: SplitStallDeps = {
    ...(options.diagnose ? { diagnose: options.diagnose } : {}),
    plans: () => [record],
    chatIdsOf: () => ['chat-a', 'session-a'],
    lastActivity: () => activity,
    processAlive: () => options.alive ?? false,
    waitingOnHuman: () => options.pending ?? false,
    stop: (chatId) => {
      stops.push(chatId);
      return options.stop ?? 'stopped';
    },
    interrupt: (_parent, index) => {
      interrupts.push(index);
      group.status = 'awaiting';
      return { resumed: options.resumed ?? true };
    },
    notify: (_parent, _group, silentMs, resumed, logPath) =>
      notices.push({
        minutes: Math.round(silentMs / MIN),
        resumed,
        ...(logPath ? { logPath } : {}),
      }),
    log: () => undefined,
    now: () => now,
  };
  const tick = createSplitStallWatch(deps);
  return {
    tick,
    group,
    stops,
    interrupts,
    notices,
    advance: (ms: number) => {
      now += ms;
    },
    touch: () => {
      activity = now;
    },
    at: () => now,
  };
}

describe('сторож повисших групп', () => {
  it('молчание дольше порога: процесс снят, группа прервана, родителю сказано', async () => {
    const h = harness();
    expect(await h.tick()).toEqual([]);
    h.advance(STALL_SILENT_MS - MIN);
    expect(await h.tick()).toEqual([]);
    expect(h.stops).toEqual([]);

    h.advance(2 * MIN);
    expect(await h.tick()).toEqual(['родитель#0']);
    expect(h.stops).toEqual(['chat-a', 'session-a']);
    expect(h.interrupts).toEqual([0]);
    expect(h.notices).toEqual([{ minutes: 61, resumed: true }]);
    // Сработал один раз: группа больше не «работает».
    h.advance(STALL_SILENT_MS);
    expect(await h.tick()).toEqual([]);
    expect(h.interrupts).toEqual([0]);
  });

  it('транскрипт пишется — не трогает, сколько бы ни шло', async () => {
    const h = harness();
    await h.tick();
    for (let step = 0; step < 6; step += 1) {
      h.advance(40 * MIN);
      h.touch();
      expect(await h.tick()).toEqual([]);
    }
    expect(h.stops).toEqual([]);
  });

  it('старый транскрипт у только что увиденной группы — отсчёт от момента, когда сторож её увидел', async () => {
    const h = harness({ lastActivity: 0 });
    expect(await h.tick()).toEqual([]);
    h.advance(10 * MIN);
    expect(await h.tick()).toEqual([]);
    h.advance(STALL_SILENT_MS);
    expect(await h.tick()).toEqual(['родитель#0']);
  });

  it('фон с живым процессом сторож не трогает; без процесса пробуждения не будет — обрыв', async () => {
    const alive = harness({ status: 'background', alive: true });
    await alive.tick();
    alive.advance(3 * STALL_SILENT_MS);
    expect(await alive.tick()).toEqual([]);

    const dead = harness({ status: 'background', alive: false });
    await dead.tick();
    dead.advance(STALL_SILENT_MS + MIN);
    expect(await dead.tick()).toEqual(['родитель#0']);
  });

  it('висит запрос прав человеку — молчание его, не группы', async () => {
    const h = harness({ pending: true });
    await h.tick();
    h.advance(2 * STALL_SILENT_MS);
    expect(await h.tick()).toEqual([]);
    expect(h.stops).toEqual([]);
  });

  it('процесс не снят (номер не сверить) — группа не прерывается: второй CLI в ту же копию не пойдёт', async () => {
    const h = harness({ stop: 'unconfirmed' });
    await h.tick();
    h.advance(STALL_SILENT_MS + MIN);
    expect(await h.tick()).toEqual([]);
    expect(h.interrupts).toEqual([]);
  });

  it('транскрипта нет (чужой CLI) — судить не по чему', async () => {
    const h = harness({ lastActivity: undefined });
    await h.tick();
    h.advance(5 * STALL_SILENT_MS);
    expect(await h.tick()).toEqual([]);
  });

  it('продолжение не ушло — родитель узнаёт и это', async () => {
    const h = harness({ resumed: false });
    await h.tick();
    h.advance(STALL_SILENT_MS + MIN);
    await h.tick();
    expect(h.notices).toEqual([{ minutes: 61, resumed: false }]);
  });
});

describe('сторож повисших групп: журнал того, что держало вызов', () => {
  it('журнал снимается ДО снятия процесса, путь — в заметку родителю, один раз на обрыв', async () => {
    const order: string[] = [];
    // Исход снятия читается при каждом вызове: сначала «не снят», потом снят.
    const options: Parameters<typeof harness>[0] = {
      stop: 'unconfirmed',
      diagnose: async ({ key, chatIds, silentMs }) => {
        order.push(`diagnose ${key} ${chatIds.join(',')} ${Math.round(silentMs / MIN)}`);
        // Процессы ещё живы, пока снимается журнал.
        expect(h.stops).toEqual([]);
        return `/app/split-stall/stall-${order.length}.log`;
      },
    };
    const h = harness(options);
    await h.tick();
    h.advance(STALL_SILENT_MS + MIN);
    // Первый проход: процесс не снят — журнал есть, прерывания нет.
    expect(await h.tick()).toEqual([]);
    expect(order).toEqual(['diagnose родитель#0 chat-a,session-a 61']);
    expect(h.interrupts).toEqual([]);

    options.stop = 'stopped';
    h.advance(STALL_POLL_MS);
    expect(await h.tick()).toEqual(['родитель#0']);
    expect(order).toHaveLength(1);
    expect(h.notices).toEqual([
      { minutes: 66, resumed: true, logPath: '/app/split-stall/stall-1.log' },
    ]);
  });

  it('журнал не снялся — группа всё равно снимается, заметка без пути', async () => {
    const h = harness({
      diagnose: async () => {
        throw new Error('CIM timeout');
      },
    });
    await h.tick();
    h.advance(STALL_SILENT_MS + MIN);
    expect(await h.tick()).toEqual(['родитель#0']);
    expect(h.notices).toEqual([{ minutes: 61, resumed: true }]);
  });

  it('группа ожила, пока снимался журнал, — не снимается', async () => {
    const h = harness({
      diagnose: async () => {
        h.advance(1_000);
        h.touch();
        return '/x.log';
      },
    });
    await h.tick();
    h.advance(STALL_SILENT_MS + MIN);
    expect(await h.tick()).toEqual([]);
    expect(h.stops).toEqual([]);
    expect(h.interrupts).toEqual([]);
  });

  it('проходы не накладываются: второй во время снимка журнала ничего не делает', async () => {
    let release: (() => void) | undefined;
    const h = harness({
      diagnose: () =>
        new Promise<string>((resolve) => {
          release = () => resolve('/x.log');
        }),
    });
    await h.tick();
    h.advance(STALL_SILENT_MS + MIN);
    const first = h.tick();
    await Promise.resolve();
    expect(await h.tick()).toEqual([]);
    release?.();
    expect(await first).toEqual(['родитель#0']);
    expect(h.interrupts).toEqual([0]);
  });
});

describe('последняя запись транскриптов', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('берёт самый свежий файл, включая транскрипты субагентов', () => {
    dir = mkdtempSync(join(tmpdir(), 'split-stall-'));
    const project = join(dir, 'C--work-proj');
    mkdirSync(join(project, 'sess-1', 'subagents'), { recursive: true });
    const main = join(project, 'sess-1.jsonl');
    const sub = join(project, 'sess-1', 'subagents', 'agent-x.jsonl');
    writeFileSync(main, '{}\n');
    writeFileSync(sub, '{}\n');
    const old = new Date('2026-10-19T08:00:00Z');
    const fresh = new Date('2026-10-19T09:30:00Z');
    utimesSync(main, old, old);
    utimesSync(sub, fresh, fresh);

    expect(transcriptActivity(dir, ['sess-1'])).toBe(fresh.getTime());
    // Главный свежее субагента — берётся он.
    utimesSync(main, fresh, new Date('2026-10-19T10:00:00Z'));
    expect(transcriptActivity(dir, ['sess-1', 'нет-такого'])).toBe(
      new Date('2026-10-19T10:00:00Z').getTime(),
    );
    expect(transcriptActivity(dir, ['нет-такого'])).toBeUndefined();
  });
});
