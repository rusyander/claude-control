import { describe, it, expect } from 'vitest';
import type { ChatSummary } from '@claude-control/contracts';
import type { RunStatus } from '@shared/lib/agent-runs';
import {
  selectAwaitingChats,
  mergeAwaitingStatuses,
  mergeAwaitingProjectStatuses,
} from './awaiting';

/**
 * Сигнал «тебя ждут» собирается из двух источников: живого прогона в памяти
 * вкладки и признака из транскрипта. Проверяем главное — они не дублируют друг
 * друга и не гасят более тревожный цвет.
 */
function chat(id: string, extra: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    title: id,
    project: 'proj',
    projectPath: 'C:/work/app',
    isSandbox: false,
    messageCount: 2,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:05.000Z',
    ...extra,
  };
}

const noRuns = new Map<string, RunStatus>();

describe('selectAwaitingChats', () => {
  it('берёт только те, где вопрос висит без ответа', () => {
    const chats = [chat('a', { awaitingReply: true }), chat('b')];

    expect(selectAwaitingChats(chats, noRuns).map((item) => item.id)).toEqual(['a']);
  });

  it('живой прогон перебивает файл — иначе звонок и точка задвоятся', () => {
    const chats = [chat('a', { awaitingReply: true }), chat('b', { awaitingReply: true })];
    const statuses = new Map<string, RunStatus>([
      ['a', 'waiting'],
      ['b', 'running'],
    ]);

    expect(selectAwaitingChats(chats, statuses)).toEqual([]);
  });

  it('завершённый прогон файлу не мешает: вопрос задан в последнем ходе', () => {
    const chats = [chat('a', { awaitingReply: true })];
    const statuses = new Map<string, RunStatus>([['a', 'idle']]);

    expect(selectAwaitingChats(chats, statuses).map((item) => item.id)).toEqual(['a']);
  });
});

describe('mergeAwaitingStatuses', () => {
  it('ставит жёлтую точку разговору, о котором стор ничего не знает', () => {
    const merged = mergeAwaitingStatuses(noRuns, [chat('a', { awaitingReply: true })]);

    expect(merged.get('a')).toBe('waiting');
  });

  it('исходную карту не портит', () => {
    const statuses = new Map<string, RunStatus>([['x', 'running']]);
    mergeAwaitingStatuses(statuses, [chat('a', { awaitingReply: true })]);

    expect(statuses.has('a')).toBe(false);
  });
});

describe('mergeAwaitingProjectStatuses', () => {
  it('зажигает таб проекта, где разговор ждёт ответа', () => {
    const merged = mergeAwaitingProjectStatuses(noRuns, [
      chat('a', { awaitingReply: true, projectPath: 'C:/work/app' }),
    ]);

    expect(merged.get('C:/work/app')).toBe('waiting');
  });

  it('красную точку не понижает: упавший агент важнее висящего вопроса', () => {
    const statuses = new Map<string, RunStatus>([['C:/work/app', 'error']]);
    const merged = mergeAwaitingProjectStatuses(statuses, [
      chat('a', { awaitingReply: true, projectPath: 'C:/work/app' }),
    ]);

    expect(merged.get('C:/work/app')).toBe('error');
  });

  it('разговор без проекта таб не трогает', () => {
    const merged = mergeAwaitingProjectStatuses(noRuns, [
      chat('a', { awaitingReply: true, projectPath: '' }),
    ]);

    expect(merged.size).toBe(0);
  });
});
