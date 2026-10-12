import { describe, it, expect, beforeEach } from 'vitest';
import { createDraftBox } from './useDraftBox';
import { loadDraft } from './draft-storage';
import { saveDraft } from './saveDraft';

/**
 * Ящик черновика: текст вне состояния React. Держится то же, что у `useDraft`
 * (ключ контекста, запись на диск, пустой ключ — без записи), плюс подписка:
 * будится только подписанный, и только когда текст правда сменился.
 */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => void map.set(key, value),
    removeItem: (key: string): void => void map.delete(key),
  };
}

describe('createDraftBox', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: unknown }).localStorage = fakeStorage();
  });

  it('начинает с черновика своего ключа и пишет правку под него', () => {
    saveDraft('chat:a', 'было');
    const box = createDraftBox('chat:a');
    expect(box.get()).toBe('было');
    box.set('стало');
    expect(box.get()).toBe('стало');
    expect(loadDraft('chat:a')).toBe('стало');
  });

  it('будит подписчиков на правку и молчит, когда текст тот же', () => {
    const box = createDraftBox('chat:a');
    let calls = 0;
    const unsubscribe = box.subscribe(() => (calls += 1));
    box.set('a');
    box.set('a');
    expect(calls).toBe(1);
    unsubscribe();
    box.set('ab');
    expect(calls).toBe(1);
  });

  it('смена ключа показывает черновик нового контекста, прежний остаётся на диске', () => {
    saveDraft('chat:b', 'второй');
    const box = createDraftBox('chat:a');
    box.set('первый');
    let calls = 0;
    box.subscribe(() => (calls += 1));
    box.switchKey('chat:b');
    expect(box.get()).toBe('второй');
    expect(calls).toBe(1);
    expect(loadDraft('chat:a')).toBe('первый');
    box.set('второй+');
    expect(loadDraft('chat:b')).toBe('второй+');
    expect(loadDraft('chat:a')).toBe('первый');
  });

  it('без ключа ничего не пишет на диск', () => {
    const storage = fakeStorage();
    (globalThis as unknown as { localStorage: unknown }).localStorage = storage;
    const box = createDraftBox(undefined);
    box.set('пожелание');
    expect(box.get()).toBe('пожелание');
    expect(storage.map.size).toBe(0);
  });
});
