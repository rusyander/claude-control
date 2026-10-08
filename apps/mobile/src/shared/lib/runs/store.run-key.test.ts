import { describe, expect, it } from 'vitest';
import { EMPTY_RUN, type AgentRun } from './types';
import { runNamed, setRun, runKeyFor, forgetRun } from './store';

/**
 * Ход со стола идёт под временным `new-…`, а телефон открывает разговор по
 * сессии (живой прогон 28.09, 1b): экран обязан найти идущий прогон под любым
 * его именем, иначе у работающего агента «молчит», нет «Стоп» и опроса.
 */
describe('runKeyFor — прогон разговора под любым именем', () => {
  it('разговор, открытый по сессии, видит прогон под new-…', () => {
    setRun('new-desk-1', { status: 'running', sessionId: 'sess-desk-1' });
    expect(runKeyFor('sess-desk-1')).toBe('new-desk-1');
    forgetRun('new-desk-1');
  });

  it('идущий прогон важнее законченной записи под тем же именем', () => {
    setRun('sess-desk-2', { status: 'done', sessionId: 'sess-desk-2' });
    setRun('new-desk-2', { status: 'running', sessionId: 'sess-desk-2' });
    expect(runKeyFor('sess-desk-2')).toBe('new-desk-2');
    forgetRun('sess-desk-2');
    forgetRun('new-desk-2');
  });

  it('без идущего — точный ключ, а незнакомое имя остаётся собой', () => {
    setRun('sess-desk-3', { status: 'done' });
    setRun('new-desk-3', { status: 'done', sessionId: 'sess-desk-3' });
    expect(runKeyFor('sess-desk-3')).toBe('sess-desk-3');
    expect(runKeyFor('unknown')).toBe('unknown');
    forgetRun('sess-desk-3');
    forgetRun('new-desk-3');
  });

  it('по серверному ключу прогона тоже находит', () => {
    setRun('new-desk-4', { status: 'running', serverRunId: 'srv-4' });
    expect(runKeyFor('srv-4')).toBe('new-desk-4');
    forgetRun('new-desk-4');
  });
});

describe('runNamed — точка в списке разговоров', () => {
  const run = (over: Partial<AgentRun>): AgentRun => ({ ...EMPTY_RUN, ...over });

  it('строка списка (по сессии) получает идущий прогон под new-…', () => {
    const list = [
      run({ id: 'sess-a', status: 'done' }),
      run({ id: 'new-a', status: 'running', sessionId: 'sess-a' }),
    ];
    expect(runNamed(list, 'sess-a')?.id).toBe('new-a');
  });

  it('пустые имена ничего не находят', () => {
    expect(runNamed([run({ id: 'x' })], undefined, '')).toBeUndefined();
  });
});
