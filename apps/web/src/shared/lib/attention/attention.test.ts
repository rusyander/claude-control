import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import { runKeyPrefix } from './runKeyPrefix';
import { quietRunIds } from './quietRunIds';
import { isLookingAt } from './isLookingAt';
import { attentionTitle } from './attentionTitle';
import { attentionReasons } from './attentionReasons';
import { selectAttention } from './selectAttention';

/**
 * Метка в браузере зовёт человека за НОВЫЙ повод и гаснет, как только он его
 * увидел (владелец 28.09: точка горела всегда). Ошибиться здесь значит либо
 * звать вечно, либо не позвать.
 */

const run = (id: string, status: ActiveRunView['status'], sessionId?: string): ActiveRunView => ({
  id,
  status,
  ...(sessionId ? { sessionId } : {}),
});
const none = new Set<string>();

describe('attentionReasons + selectAttention', () => {
  it('работающий агент не зовёт: он занят, а не ждёт', () => {
    expect(selectAttention(attentionReasons([run('a', 'running')]), none)).toEqual({ count: 0 });
  });

  it('ждущий зовёт жёлтым, упавший — красным, и красный сильнее', () => {
    expect(selectAttention(attentionReasons([run('a', 'waiting')]), none)).toEqual({
      count: 1,
      tone: 'warning',
    });
    expect(
      selectAttention(attentionReasons([run('a', 'waiting'), run('b', 'error')]), none),
    ).toEqual({ count: 2, tone: 'danger' });
  });

  it('увиденный повод не зовёт снова', () => {
    const reasons = attentionReasons([run('a', 'waiting')]);
    const seen = new Set(reasons.map((reason) => reason.key));
    expect(selectAttention(reasons, seen)).toEqual({ count: 0 });
  });

  it('новый повод у того же прогона зовёт заново', () => {
    // Человек увидел «ждёт», агент поработал и упал — это уже другой повод.
    const seen = new Set(attentionReasons([run('a', 'waiting')]).map((reason) => reason.key));
    expect(selectAttention(attentionReasons([run('a', 'error')]), seen)).toEqual({
      count: 1,
      tone: 'danger',
    });
  });

  it('разговор с вопросом без прогона зовёт наравне с прогоном', () => {
    // Агента запустили в терминале — в памяти вкладки его нет, а ждут всё равно.
    const reasons = attentionReasons([], [{ id: 'chat-1', since: 't1' }]);
    expect(selectAttention(reasons, none)).toEqual({ count: 1, tone: 'warning' });
  });

  it('тот же разговор дважды не считается', () => {
    const reasons = attentionReasons(
      [run('r1', 'waiting', 'chat-1')],
      [{ id: 'chat-1', since: 't1' }],
    );
    expect(selectAttention(reasons, none)).toEqual({ count: 1, tone: 'warning' });
  });

  it('вопрос не понижает красный тон упавшего агента', () => {
    const reasons = attentionReasons([run('a', 'error')], [{ id: 'chat-1', since: 't1' }]);
    expect(selectAttention(reasons, none)).toEqual({ count: 2, tone: 'danger' });
  });

  it('увиденный вопрос разговора не зовёт, новый вопрос того же разговора — зовёт', () => {
    // Четыре брошенных вопроса владельца: увидены — больше не зовут никогда.
    const old = attentionReasons([], [{ id: 'chat-1', since: '2026-09-25T10:00:00Z' }]);
    const seen = new Set(old.map((reason) => reason.key));
    expect(selectAttention(old, seen)).toEqual({ count: 0 });
    // Ответили, агент спросил снова — запись новее, повод новый.
    const again = attentionReasons([], [{ id: 'chat-1', since: '2026-09-28T09:00:00Z' }]);
    expect(selectAttention(again, seen)).toEqual({ count: 1, tone: 'warning' });
  });

  it('старый увиденный и новый неувиденный: счёт только за новый', () => {
    const reasons = attentionReasons(
      [],
      [
        { id: 'old', since: 't1' },
        { id: 'new', since: 't2' },
      ],
    );
    expect(selectAttention(reasons, new Set(['chat:old:t1']))).toEqual({
      count: 1,
      tone: 'warning',
    });
  });
});

describe('quietRunIds', () => {
  it('забывается прошлый повод только живого прогона, который больше не зовёт', () => {
    expect(quietRunIds([run('a', 'running'), run('b', 'waiting'), run('c', 'error')])).toEqual([
      'a',
    ]);
    expect(runKeyPrefix('a')).toBe('run:a:');
  });
});

describe('isLookingAt', () => {
  it('смотрит — только когда окно на виду и в фокусе', () => {
    expect(isLookingAt({ visibilityState: 'visible', hasFocus: () => true })).toBe(true);
    expect(isLookingAt({ visibilityState: 'visible', hasFocus: () => false })).toBe(false);
    expect(isLookingAt({ visibilityState: 'hidden', hasFocus: () => true })).toBe(false);
  });
});

describe('attentionTitle', () => {
  it('без поводов заголовок не трогается', () => {
    expect(attentionTitle('AgentDeck', 0)).toBe('AgentDeck');
  });

  it('один повод — точка, несколько — точка со счётом', () => {
    expect(attentionTitle('AgentDeck', 1)).toBe('● AgentDeck');
    expect(attentionTitle('AgentDeck', 3)).toBe('● 3 · AgentDeck');
  });
});

describe('attentionStore', () => {
  const memory = new Map<string, string>();
  beforeEach(() => {
    memory.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
    });
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('увиденное переживает перезагрузку страницы', async () => {
    const first = await import('./attentionStore');
    first.markSeen(['chat:a:t1']);
    vi.resetModules();
    const reloaded = await import('./attentionStore');
    expect(reloaded.getSeen().has('chat:a:t1')).toBe(true);
  });

  it('forgetSeen снимает только ключи своего прогона', async () => {
    const store = await import('./attentionStore');
    store.markSeen(['run:a:waiting', 'run:ab:waiting', 'chat:a:t1']);
    store.forgetSeen([runKeyPrefix('a')]);
    expect([...store.getSeen()].sort()).toEqual(['chat:a:t1', 'run:ab:waiting']);
  });

  it('записи старше двух недель и битое хранилище не мешают', async () => {
    const old = Date.now() - 15 * 24 * 60 * 60 * 1000;
    memory.set('agentdeck:attention-seen', JSON.stringify({ 'chat:x:1': old, 'chat:y:1': 'bad' }));
    const store = await import('./attentionStore');
    expect(store.getSeen().size).toBe(0);
    memory.set('agentdeck:attention-seen', '{не json');
    vi.resetModules();
    const again = await import('./attentionStore');
    expect(again.getSeen().size).toBe(0);
  });

  it('dismissAttention помечает повод прогона в его статусе', async () => {
    const store = await import('./attentionStore');
    store.dismissAttention('r1', 'waiting');
    store.dismissAttention(undefined, 'waiting');
    expect([...store.getSeen()]).toEqual(['run:r1:waiting']);
  });
});
