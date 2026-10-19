import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendLimitRun,
  createLimitShareReader,
  limitJournalPath,
  limitSampleOf,
  limitSharesByChat,
  readLimitRuns,
  type LimitRunRecord,
} from './limit-journal.ts';

const DAY = 24 * 60 * 60 * 1000;

const record = (over: Partial<LimitRunRecord> & Pick<LimitRunRecord, 'id'>): LimitRunRecord => ({
  chatId: over.id,
  startedAt: 0,
  endedAt: 1000,
  tokens: 100,
  samples: [],
  ...over,
});

describe('limitSampleOf — замер из rate_limit_event', () => {
  it('берёт оба окна с загрузкой и сбросом', () => {
    expect(
      limitSampleOf(
        {
          unifiedWindows: {
            five_hour: { utilization: 0.4, resetsAt: 10 },
            seven_day: { utilization: 0.1, resetsAt: 20 },
          },
        },
        5,
      ),
    ).toEqual({
      at: 5,
      fiveHour: { utilization: 0.4, resetsAt: 10 },
      sevenDay: { utilization: 0.1, resetsAt: 20 },
    });
  });

  it('окно без сброса или без загрузки — не замер; ни одного окна — undefined', () => {
    expect(
      limitSampleOf(
        {
          unifiedWindows: {
            five_hour: { utilization: 0.4 },
            seven_day: { utilization: 0.1, resetsAt: 2 },
          },
        },
        5,
      ),
    ).toEqual({ at: 5, sevenDay: { utilization: 0.1, resetsAt: 2 } });
    expect(limitSampleOf({ unifiedWindows: { five_hour: { resetsAt: 3 } } }, 5)).toBeUndefined();
    expect(limitSampleOf({ resetsAt: 3, status: 'allowed' }, 5)).toBeUndefined();
  });
});

describe('журнал доли лимита на диске', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-limit-journal-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('дописывает и снимает записи старше недели', () => {
    const now = 30 * DAY;
    appendLimitRun(dir, record({ id: 'old', endedAt: now - 9 * DAY }), now);
    appendLimitRun(dir, record({ id: 'fresh', endedAt: now - DAY }), now);
    appendLimitRun(dir, record({ id: 'new', endedAt: now }), now);
    expect(readLimitRuns(dir).map((entry) => entry.id)).toEqual(['fresh', 'new']);
  });

  it('битый файл и чужие строки — пустой журнал без исключения', () => {
    writeFileSync(limitJournalPath(dir), '{не json');
    expect(readLimitRuns(dir)).toEqual([]);
    writeFileSync(limitJournalPath(dir), JSON.stringify([{ id: 'x' }, record({ id: 'ok' })]));
    expect(readLimitRuns(dir).map((entry) => entry.id)).toEqual(['ok']);
  });

  it('читатель пересчитывает доли, когда файл изменился', () => {
    const read = createLimitShareReader(dir);
    expect(read().size).toBe(0);
    const sample = (at: number, utilization: number) => ({
      at,
      fiveHour: { utilization, resetsAt: 99 },
    });
    appendLimitRun(
      dir,
      record({ id: 'r1', sessionId: 's1', samples: [sample(0, 0.1), sample(1000, 0.3)] }),
      1000,
    );
    expect(read().get('s1')?.fiveHour).toBeCloseTo(0.2, 9);
    // Вторая запись меняет файл — читатель обязан не отдать прежний расчёт.
    appendLimitRun(
      dir,
      record({
        id: 'r2',
        sessionId: 's2',
        startedAt: 2000,
        endedAt: 3000,
        samples: [sample(2000, 0.3), sample(3000, 0.4)],
      }),
      3000,
    );
    expect(read().get('s2')?.fiveHour).toBeCloseTo(0.1, 9);
  });
});

describe('limitSharesByChat — доли по разговорам', () => {
  const sample = (at: number, utilization: number) => ({
    at,
    fiveHour: { utilization, resetsAt: 99 },
  });

  it('прогоны одного разговора складываются, ключ — сессия, без неё — ключ чата', () => {
    const shares = limitSharesByChat([
      record({
        id: 'a1',
        chatId: 'new-1',
        sessionId: 's',
        startedAt: 0,
        endedAt: 100,
        samples: [sample(0, 0), sample(100, 0.1)],
      }),
      record({
        id: 'a2',
        chatId: 's',
        sessionId: 's',
        startedAt: 200,
        endedAt: 300,
        samples: [sample(200, 0.1), sample(300, 0.3)],
      }),
      record({
        id: 'b1',
        chatId: 'new-2',
        startedAt: 400,
        endedAt: 500,
        samples: [sample(400, 0.3), sample(500, 0.35)],
      }),
    ]);
    expect(shares.get('s')?.fiveHour).toBeCloseTo(0.3, 9);
    expect(shares.get('new-2')?.fiveHour).toBeCloseTo(0.05, 9);
    expect(shares.size).toBe(2);
  });
});
