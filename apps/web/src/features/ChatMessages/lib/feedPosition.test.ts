/**
 * Память места в ленте: ушли из отлистанного родителя к ребёнку и вернулись —
 * лента встаёт туда же, а не в самый низ. Тест держит решение «куда вернуть»:
 * якорь по сообщению переживает новые сообщения и подгрузку ранних, чужое окно
 * (переписка ещё грузится) не становится местом, а разговор, который не
 * листали, не запоминается и открывается у низа, как раньше.
 */
import { describe, expect, it } from 'vitest';
import {
  createFeedMemory,
  feedPositions,
  isPinnedAt,
  pickAnchor,
  recallFeedLimit,
  rememberFeedLimit,
  restoreTarget,
  snapshotOf,
} from './feedPosition';
import type { FeedRow } from './feedPosition.types';

/** Сообщения высотой 100px подряд; `scrolled` — насколько лента отлистана от первого. */
function rows(ids: string[], scrolled: number): FeedRow[] {
  return ids.map((id, index) => ({
    id,
    top: index * 100 - scrolled,
    bottom: index * 100 + 100 - scrolled,
  }));
}

describe('pickAnchor', () => {
  it('якорь — первое сообщение, чей низ виден, со сдвигом его верха', () => {
    expect(pickAnchor(rows(['a', 'b', 'c', 'd'], 150))).toEqual({ id: 'b', offset: -50 });
  });

  it('все сообщения выше видимой части (человек у сводки групп) → последнее, сдвиг меньше нуля', () => {
    expect(pickAnchor(rows(['a', 'b'], 450))).toEqual({ id: 'b', offset: -350 });
  });

  it('пустая лента → якоря нет', () => {
    expect(pickAnchor([])).toBeUndefined();
  });
});

describe('restoreTarget', () => {
  const snapshot = snapshotOf(rows(['a', 'b', 'c', 'd'], 150), 150);

  it('снимок помнит якорь, сырую прокрутку и последнее сообщение', () => {
    expect(snapshot).toEqual({ anchor: { id: 'b', offset: -50 }, scrollTop: 150, lastId: 'd' });
  });

  it('та же переписка → ровно прежнее место', () => {
    expect(
      restoreTarget(snapshot, { anchorTop: 100 - 0, hasLast: true, scrollTop: 0, maxScroll: 2000 }),
    ).toBe(150);
  });

  it('новые сообщения снизу, пока человек был у ребёнка, место не сдвигают', () => {
    // Лента открылась у низа (прокрутка 900), якорь «b» сейчас на 100 − 900.
    expect(
      restoreTarget(snapshot, { anchorTop: -800, hasLast: false, scrollTop: 900, maxScroll: 900 }),
    ).toBe(150);
  });

  it('окно сдвинулось сверху (два новых ранних сообщения) → прокрутка следует за якорем, а не за числом', () => {
    // Над «b» теперь на 200px больше: голая прокрутка 150 поставила бы чужое сообщение.
    expect(
      restoreTarget(snapshot, { anchorTop: 300, hasLast: true, scrollTop: 0, maxScroll: 2000 }),
    ).toBe(350);
  });

  it('якорь выпал из окна, но переписка та же → сырая прокрутка, в пределах ленты', () => {
    expect(restoreTarget(snapshot, { hasLast: true, scrollTop: 0, maxScroll: 2000 })).toBe(150);
    expect(restoreTarget(snapshot, { hasLast: true, scrollTop: 0, maxScroll: 100 })).toBe(100);
  });

  it('на экране чужое окно (переписка ещё грузится) → ждать, а не ставить ленту', () => {
    expect(
      restoreTarget(snapshot, { hasLast: false, scrollTop: 40, maxScroll: 2000 }),
    ).toBeUndefined();
  });

  it('место за пределами ленты прижимается к её краю', () => {
    expect(
      restoreTarget(snapshot, { anchorTop: 900, hasLast: true, scrollTop: 0, maxScroll: 500 }),
    ).toBe(500);
    expect(
      restoreTarget(snapshot, { anchorTop: -400, hasLast: true, scrollTop: 0, maxScroll: 500 }),
    ).toBe(0);
  });
});

describe('isPinnedAt', () => {
  it('у низа (ближе 160px) лента держится низа, дальше — отпущена', () => {
    expect(isPinnedAt({ scrollHeight: 2000, clientHeight: 500, scrollTop: 1400 })).toBe(true);
    expect(isPinnedAt({ scrollHeight: 2000, clientHeight: 500, scrollTop: 1300 })).toBe(false);
  });
});

describe('createFeedMemory', () => {
  it('сверх предела выпадает самый давний по последней записи', () => {
    const memory = createFeedMemory<number>(2);
    memory.set('a', 1);
    memory.set('b', 2);
    memory.set('a', 3);
    memory.set('c', 4);
    expect(memory.get('b')).toBeUndefined();
    expect(memory.get('a')).toBe(3);
    expect(memory.get('c')).toBe(4);
    expect(memory.size()).toBe(2);
  });

  // Владелец 20.10: место в ленте родителя терялось при перезагрузке страницы.
  it('с хранилищем место переживает перезагрузку: новая память читает записанное', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    };
    const before = createFeedMemory<number>(2, { key: 'k', storage });
    before.set('parent', 7482);
    before.set('other', 1);
    before.delete('other');
    const after = createFeedMemory<number>(2, { key: 'k', storage });
    expect(after.get('parent')).toBe(7482);
    expect(after.get('other')).toBeUndefined();
  });

  it('битая или чужая запись в хранилище — пустая память, не сбой', () => {
    for (const raw of ['{', '{"a":1}', '[["a"],[1,2]]']) {
      const storage = { getItem: () => raw, setItem: () => undefined };
      expect(createFeedMemory<number>(2, { key: 'k', storage }).size()).toBe(0);
    }
  });
});

describe('окно ленты при возврате', () => {
  it('окно «Загрузить ещё» возвращается только с запомненным местом', () => {
    rememberFeedLimit('limit-parent', 800);
    expect(recallFeedLimit('limit-parent')).toBeUndefined();
    feedPositions.set('limit-parent', { scrollTop: 10 });
    expect(recallFeedLimit('limit-parent')).toBe(800);
    feedPositions.delete('limit-parent');
    expect(recallFeedLimit('limit-parent')).toBeUndefined();
  });

  it('нет разговора — нет окна', () => {
    rememberFeedLimit(undefined, 800);
    expect(recallFeedLimit(undefined)).toBeUndefined();
  });
});
