import { describe, expect, it } from 'vitest';
import {
  GROUP_WATCH_DEFAULTS,
  GROUP_WATCH_RULES,
  GROUP_WATCH_SEVERITY,
  groupWatchChanges,
  groupWatchPatchSchema,
  groupWatchSchema,
  groupWatchSnapshotSchema,
  groupWatchWithDefaults,
} from '@agentdeck/contracts/group-watch';
import { GROUP_LEVEL, SINGLE_RULES } from './rules.ts';

/**
 * Пороги правил R22–R33 и сторож одиночных чатов (`singleChats`) — в контракте настроек:
 * заводские значения из плана (`watch-coverage-plan` §3), PATCH без умолчаний, снимок с
 * другой версии панели не отвергается из-за одного порога.
 */
describe('настройки сторожа: пороги R22–R33', () => {
  it('заводские значения плана', () => {
    expect(GROUP_WATCH_DEFAULTS).toMatchObject({
      singleChats: true,
      silentStopMinutes: 20,
      crossGroupCount: 2,
      crossGroupMinutes: 60,
      errorRepeats: 3,
      errorMinutes: 30,
      bypassMinutes: 30,
      proseWaitMinutes: 10,
      nudgeRepeats: 2,
      missingToolRepeats: 2,
      outageRepeats: 3,
      outageMinutes: 15,
      insertChars: 20_000,
      insertMinutes: 15,
      askAlertMinutes: 60,
    });
  });

  it('PATCH знает ровно ключи схемы — в обе стороны', () => {
    const schemaKeys = Object.keys(groupWatchSchema.shape).sort();
    expect(Object.keys(groupWatchPatchSchema.shape).sort()).toEqual(schemaKeys);
    expect(Object.keys(GROUP_WATCH_DEFAULTS).sort()).toEqual(schemaKeys);
  });

  it('правка одного порога не подставляет умолчания остальных', () => {
    expect(groupWatchPatchSchema.parse({ errorRepeats: 4 })).toEqual({ errorRepeats: 4 });
    expect(groupWatchPatchSchema.parse({ singleChats: false })).toEqual({ singleChats: false });
  });

  it('границы: вне них PATCH отвергнут, снимок и чтение с диска роняют только этот ключ', () => {
    expect(groupWatchPatchSchema.safeParse({ missingToolRepeats: 0 }).success).toBe(false);
    expect(groupWatchPatchSchema.safeParse({ insertChars: 4_999 }).success).toBe(false);
    expect(groupWatchPatchSchema.safeParse({ askAlertMinutes: 14 }).success).toBe(false);
    expect(groupWatchPatchSchema.safeParse({ errorRepeats: 2.5 }).success).toBe(false);
    expect(groupWatchSnapshotSchema.parse({ insertChars: 1, outageRepeats: 5 })).toEqual({
      outageRepeats: 5,
    });
    expect(groupWatchWithDefaults({ insertChars: 1 }).insertChars).toBe(20_000);
    expect(groupWatchChanges({ errorRepeats: 3, outageRepeats: 5, insertMinutes: 0 })).toEqual({
      outageRepeats: 5,
    });
  });
});

describe('правила R22–R33: важность и область', () => {
  it('у каждого правила есть базовая важность; тревога — обход отказа и беда в нескольких группах', () => {
    for (const rule of GROUP_WATCH_RULES) expect(GROUP_WATCH_SEVERITY[rule]).toBeDefined();
    expect(GROUP_WATCH_SEVERITY.R25).toBe('alert');
    expect(GROUP_WATCH_SEVERITY.R23).toBe('alert');
    expect(GROUP_WATCH_SEVERITY.R32).toBe('info');
  });

  it('одиночный чат не видит правил группы, плана, своей копии и стадии ревью', () => {
    expect([...GROUP_LEVEL].sort()).toEqual(['R22', 'R23', 'R28']);
    const absent = GROUP_WATCH_RULES.filter((rule) => !SINGLE_RULES.has(rule));
    expect(absent).toEqual([
      'R1b',
      'R5',
      'R6',
      'R7',
      'R8',
      'R9',
      'R20',
      // F-78: тяжёлые проверки считает только группа — у одиночного чата R21 нет.
      'R21',
      'R22',
      'R23',
      'R28',
      'R31',
      'R33',
      // Новый разговор группы, коммиты её стадии, пауза группы — у одиночного чата их нет.
      'R34',
      'R35',
      'R36',
    ]);
  });
});
