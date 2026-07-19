import { describe, it, expect, beforeEach } from 'vitest';
import { loadDraft, saveDraft, clearDraft } from './draft-storage';

/**
 * Черновики форм. Ключевое: непустой текст переживает «перезагрузку» (чтение из
 * того же хранилища), а пустое значение не оставляет мусорного ключа. Тесты
 * гоняются в node-окружении, где localStorage нет, поэтому подставляем свой.
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

describe('draft-storage', () => {
  let store: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    store = fakeStorage();
    (globalThis as unknown as { localStorage: unknown }).localStorage = store;
  });

  it('сохранённый черновик читается обратно', () => {
    saveDraft('chat:1', 'недописанный вопрос');
    expect(loadDraft('chat:1')).toBe('недописанный вопрос');
  });

  it('у разных ключей — свои черновики', () => {
    saveDraft('chat:a', 'текст А');
    saveDraft('chat:b', 'текст Б');
    expect(loadDraft('chat:a')).toBe('текст А');
    expect(loadDraft('chat:b')).toBe('текст Б');
  });

  it('пустое значение стирает ключ, а не хранит пустоту', () => {
    saveDraft('chat:1', 'что-то');
    saveDraft('chat:1', '');
    expect(loadDraft('chat:1')).toBe('');
    expect([...store.map.keys()]).toHaveLength(0);
  });

  it('clearDraft убирает черновик', () => {
    saveDraft('form:settings', 'черновик формы');
    clearDraft('form:settings');
    expect(loadDraft('form:settings')).toBe('');
  });

  it('отсутствующий ключ — пустая строка', () => {
    expect(loadDraft('нет-такого')).toBe('');
  });
});
