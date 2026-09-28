import { describe, expect, it } from 'vitest';
import { applyEvent, getRun, setRun, visibleStatus } from './store';
import type { ChatEvent } from './types';

/**
 * Вопрос, закрытый автономией чата: телефон не должен держать «ждёт вас» над
 * ходом, который идёт дальше сам, — иначе уведомление зовёт человека зря.
 */
const ask = (id: string) =>
  ({ kind: 'tool', name: 'AskUserQuestion', input: { questions: [] }, id }) as const;
const pick = (toolUseId: string): ChatEvent => ({
  kind: 'autoPick',
  toolUseId,
  picks: [{ question: 'Как переносить?', label: 'Партиями (Recommended)' }],
});

describe('store — автовыбор под автономией', () => {
  it('автовыбор снимает «ждёт вас» и оставляет вызову след выбора', () => {
    setRun('m-auto-1', { status: 'running' });
    applyEvent('m-auto-1', ask('t1'));
    expect(visibleStatus(getRun('m-auto-1'))).toBe('waiting');
    applyEvent('m-auto-1', pick('t1'));
    const run = getRun('m-auto-1');
    expect(visibleStatus(run)).toBe('running');
    expect(run.tools[0]?.autoPicks).toEqual([
      { question: 'Как переносить?', label: 'Партиями (Recommended)' },
    ]);
  });

  it('второй, неотвеченный вопрос того же хода по-прежнему ждёт человека', () => {
    setRun('m-auto-2', { status: 'running' });
    applyEvent('m-auto-2', ask('t1'));
    applyEvent('m-auto-2', ask('t2'));
    applyEvent('m-auto-2', pick('t1'));
    const run = getRun('m-auto-2');
    expect(visibleStatus(run)).toBe('waiting');
    expect(run.tools[1]?.autoPicks).toBeUndefined();
  });

  // Ревью 28.09 (F-132): выбор не разобрался (прогон не видел самого вызова), но
  // сервер закрыл вопрос по метке — телефон обязан думать так же.
  it('автовыбор без разобранного выбора (`picks: []`) всё равно закрывает вопрос', () => {
    setRun('m-auto-3', { status: 'running' });
    applyEvent('m-auto-3', ask('t1'));
    applyEvent('m-auto-3', { kind: 'autoPick', toolUseId: 't1', picks: [] });
    const run = getRun('m-auto-3');
    expect(visibleStatus(run)).toBe('running');
    expect(run.askedQuestion).toBe(false);
  });
});
