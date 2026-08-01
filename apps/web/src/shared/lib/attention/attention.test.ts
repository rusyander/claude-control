import { describe, it, expect } from 'vitest';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import { selectAttention, attentionTitle } from './attention';

/**
 * Метка в браузере зовёт человека, когда агент ждёт ответа или упал, и гаснет
 * не по таймеру, а по действию: увидел — сняли. Здесь проверяется именно эта
 * связка, потому что ошибиться в ней значит либо звать вечно, либо не позвать.
 */

const run = (id: string, status: ActiveRunView['status']): ActiveRunView => ({ id, status });

describe('selectAttention', () => {
  it('работающий агент не зовёт: он занят, а не ждёт', () => {
    expect(selectAttention([run('a', 'running')], new Map())).toEqual({ count: 0 });
  });

  it('ждущий зовёт жёлтым, упавший — красным, и красный сильнее', () => {
    expect(selectAttention([run('a', 'waiting')], new Map())).toEqual({
      count: 1,
      tone: 'warning',
    });
    expect(selectAttention([run('a', 'waiting'), run('b', 'error')], new Map())).toEqual({
      count: 2,
      tone: 'danger',
    });
  });

  it('увиденный повод не зовёт снова', () => {
    const dismissed = new Map([['a', 'waiting']]);
    expect(selectAttention([run('a', 'waiting')], dismissed)).toEqual({ count: 0 });
  });

  it('новый повод у того же прогона зовёт заново', () => {
    // Человек закрыл «ждёт», агент поработал и упал — это уже другой повод.
    const dismissed = new Map([['a', 'waiting']]);
    expect(selectAttention([run('a', 'error')], dismissed)).toEqual({ count: 1, tone: 'danger' });
  });
});

describe('attentionTitle', () => {
  it('без поводов заголовок не трогается', () => {
    expect(attentionTitle('Claude Control', 0)).toBe('Claude Control');
  });

  it('один повод — точка, несколько — точка со счётом', () => {
    expect(attentionTitle('Claude Control', 1)).toBe('● Claude Control');
    expect(attentionTitle('Claude Control', 3)).toBe('● 3 · Claude Control');
  });
});
