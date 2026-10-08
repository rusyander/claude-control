import { describe, it, expect } from 'vitest';
import type { SessionWhere } from '@agentdeck/contracts';
import { goPlan, samePath } from './sessionActions';
import { stopPlan } from './stopPlan';
import { stopOutcome } from './stopOutcome';

const ID = 'f104fdda-599b-4973-a272-fe5a515c08b7';
const PROCESS: SessionWhere = {
  kind: 'process',
  pid: 42,
  startedAt: '2026-09-27T10:00:00.000Z',
  host: 'editor',
  editor: 'VS Code',
  command: 'claude.exe --resume=…',
  ownsPanel: true,
};

describe('goPlan — куда ведёт «Перейти»', () => {
  it('чат панели — в его чат, по id прогона', () => {
    expect(goPlan({ sessionId: ID, where: { kind: 'panel', chatId: 'new-1' } })).toEqual({
      kind: 'chat',
      id: 'new-1',
    });
  });

  it('завершённая — в её разговор', () => {
    expect(goPlan({ sessionId: ID, where: { kind: 'finished' } })).toEqual({
      kind: 'chat',
      id: ID,
    });
  });

  it('идущая вне панели — не в чат (второй писатель), а в окно «где идёт»', () => {
    expect(goPlan({ sessionId: ID, where: PROCESS })).toEqual({ kind: 'where' });
    expect(goPlan({ sessionId: ID, where: { kind: 'unidentified' } })).toEqual({ kind: 'where' });
  });
});

describe('stopPlan — что снимет «Остановить»', () => {
  it('чат панели — обычный стоп чата', () => {
    expect(stopPlan({ kind: 'panel', chatId: 'c1' })).toEqual({ kind: 'panel', chatId: 'c1' });
  });

  it('процесс — номер и время создания, показанные человеку, и флаг панели', () => {
    expect(stopPlan(PROCESS)).toEqual({
      kind: 'process',
      pid: 42,
      startedAt: '2026-09-27T10:00:00.000Z',
      ownsPanel: true,
    });
  });

  it('неопознанную и завершённую не снимаем — и говорим почему', () => {
    expect(stopPlan({ kind: 'unidentified' })).toEqual({ kind: 'nothing', reason: 'unidentified' });
    expect(stopPlan({ kind: 'finished' })).toEqual({ kind: 'nothing', reason: 'finished' });
  });
});

describe('stopOutcome — итог словами', () => {
  it('каждый итог — свой ключ и тон, «остановлено» только по факту', () => {
    expect(stopOutcome({ result: 'stopped', pid: 1, killed: 3 })).toEqual({
      key: 'analytics.sessionStopped',
      params: { count: 3 },
      tone: 'success',
    });
    expect(stopOutcome({ result: 'gone', pid: 1 }).key).toBe('analytics.sessionGone');
    expect(stopOutcome({ result: 'reused', pid: 1 }).key).toBe('analytics.sessionReused');
    expect(stopOutcome({ result: 'still-running', pid: 1 })).toMatchObject({
      key: 'analytics.sessionStillRunning',
      tone: 'warning',
    });
    // F-145: номер нечем сверить — «не остановлен», а не «сигнал отправлен».
    expect(stopOutcome({ result: 'unverified', pid: 1 })).toEqual({
      key: 'analytics.sessionUnverified',
      params: { pid: 1 },
      tone: 'warning',
    });
  });
});

describe('samePath', () => {
  it('Windows: слэши, хвост и регистр не в счёт', () => {
    expect(samePath('c:\\work\\agentdeck', 'C:/work/agentdeck/')).toBe(true);
    expect(samePath('c:\\work\\a', 'c:\\work\\b')).toBe(false);
  });

  it('POSIX: регистр различается', () => {
    expect(samePath('/home/me/App', '/home/me/app')).toBe(false);
    expect(samePath('/home/me/app/', '/home/me/app')).toBe(true);
  });
});
