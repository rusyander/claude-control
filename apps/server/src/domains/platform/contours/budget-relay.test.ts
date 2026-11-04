import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HopBudgetNotice } from '@agentdeck/contracts/core/hops';
import { BUDGET_RELAY_FILE, createBudgetRelay } from './budget-relay.ts';

/**
 * Пороги бюджета — каналам панели (C3b): звено ядра кладёт извещения с растущим `seq`, панель
 * отдаёт каждое один раз и помнит курсор в своём доме. Ядро здесь — список извещений (граница
 * панель/ядро); настоящий путь звено → API ядра → клиент панели —
 * `tools/qa/check-core-contours.mjs`.
 */

const notice = (seq: number, level: 'near' | 'over' = 'near'): HopBudgetNotice => ({
  seq,
  at: '2026-11-02T10:00:00.000Z',
  platformId: 'dev',
  platformTitle: 'Dev',
  level,
  share: level === 'near' ? 0.9 : 1.1,
});

let dir: string;
let statePath: string;
let stored: HopBudgetNotice[];
let down: string | undefined;
let delivered: number[];
let logs: string[];

const relay = () =>
  createBudgetRelay({
    contours: {
      notices: async () => {
        if (down) throw new Error(down);
        return stored;
      },
    },
    statePath,
    deliver: (item) => delivered.push(item.seq),
    log: (line) => logs.push(line),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-budget-relay-'));
  statePath = join(dir, BUDGET_RELAY_FILE);
  stored = [];
  down = undefined;
  delivered = [];
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('пересылка порогов бюджета', () => {
  it('каждое извещение — один раз; курсор переживает перезапуск панели', async () => {
    stored = [notice(1)];
    const first = relay();
    await first.tick();
    await first.tick();
    expect(delivered).toEqual([1]);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({ v: 1, seq: 1 });

    stored = [notice(1), notice(2, 'over')];
    await relay().tick();
    expect(delivered).toEqual([1, 2]);
  });

  it('учёт звена начат заново (seq ниже курсора) — пересылка не молчит вечно', async () => {
    stored = [notice(1), notice(2), notice(3)];
    await relay().tick();
    stored = [notice(1)];
    await relay().tick();
    expect(delivered).toEqual([1, 2, 3, 1]);
  });

  it('ядро недоступно — одна строка на причину, курсор не двигается', async () => {
    down = 'core down';
    const instance = relay();
    await instance.tick();
    await instance.tick();
    expect(logs).toEqual(['budget-relay: notices not read: core down']);
    expect(existsSync(statePath)).toBe(false);

    down = undefined;
    stored = [notice(1)];
    await instance.tick();
    expect(delivered).toEqual([1]);
  });
});
