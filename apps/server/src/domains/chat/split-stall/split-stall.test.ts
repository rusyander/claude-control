import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../lib/app-store/app-store.types.ts';
import {
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
  const notices: { minutes: number; resumed: boolean }[] = [];
  let activity = 'lastActivity' in options ? options.lastActivity : now;
  const deps: SplitStallDeps = {
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
    notify: (_parent, _group, silentMs, resumed) =>
      notices.push({ minutes: Math.round(silentMs / MIN), resumed }),
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
  it('молчание дольше порога: процесс снят, группа прервана, родителю сказано', () => {
    const h = harness();
    expect(h.tick()).toEqual([]);
    h.advance(STALL_SILENT_MS - MIN);
    expect(h.tick()).toEqual([]);
    expect(h.stops).toEqual([]);

    h.advance(2 * MIN);
    expect(h.tick()).toEqual(['родитель#0']);
    expect(h.stops).toEqual(['chat-a', 'session-a']);
    expect(h.interrupts).toEqual([0]);
    expect(h.notices).toEqual([{ minutes: 61, resumed: true }]);
    // Сработал один раз: группа больше не «работает».
    h.advance(STALL_SILENT_MS);
    expect(h.tick()).toEqual([]);
    expect(h.interrupts).toEqual([0]);
  });

  it('транскрипт пишется — не трогает, сколько бы ни шло', () => {
    const h = harness();
    h.tick();
    for (let step = 0; step < 6; step += 1) {
      h.advance(40 * MIN);
      h.touch();
      expect(h.tick()).toEqual([]);
    }
    expect(h.stops).toEqual([]);
  });

  it('старый транскрипт у только что увиденной группы — отсчёт от момента, когда сторож её увидел', () => {
    const h = harness({ lastActivity: 0 });
    expect(h.tick()).toEqual([]);
    h.advance(10 * MIN);
    expect(h.tick()).toEqual([]);
    h.advance(STALL_SILENT_MS);
    expect(h.tick()).toEqual(['родитель#0']);
  });

  it('фон с живым процессом сторож не трогает; без процесса пробуждения не будет — обрыв', () => {
    const alive = harness({ status: 'background', alive: true });
    alive.tick();
    alive.advance(3 * STALL_SILENT_MS);
    expect(alive.tick()).toEqual([]);

    const dead = harness({ status: 'background', alive: false });
    dead.tick();
    dead.advance(STALL_SILENT_MS + MIN);
    expect(dead.tick()).toEqual(['родитель#0']);
  });

  it('висит запрос прав человеку — молчание его, не группы', () => {
    const h = harness({ pending: true });
    h.tick();
    h.advance(2 * STALL_SILENT_MS);
    expect(h.tick()).toEqual([]);
    expect(h.stops).toEqual([]);
  });

  it('процесс не снят (номер не сверить) — группа не прерывается: второй CLI в ту же копию не пойдёт', () => {
    const h = harness({ stop: 'unconfirmed' });
    h.tick();
    h.advance(STALL_SILENT_MS + MIN);
    expect(h.tick()).toEqual([]);
    expect(h.interrupts).toEqual([]);
  });

  it('транскрипта нет (чужой CLI) — судить не по чему', () => {
    const h = harness({ lastActivity: undefined });
    h.tick();
    h.advance(5 * STALL_SILENT_MS);
    expect(h.tick()).toEqual([]);
  });

  it('продолжение не ушло — родитель узнаёт и это', () => {
    const h = harness({ resumed: false });
    h.tick();
    h.advance(STALL_SILENT_MS + MIN);
    h.tick();
    expect(h.notices).toEqual([{ minutes: 61, resumed: false }]);
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
