import { describe, it, expect, beforeEach } from 'vitest';
import { loadDraft, saveDraft, clearDraft, migrateDraft } from './draft-storage';

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

  describe('migrateDraft — перенос черновика при «взрослении» чата', () => {
    it('переносит значение на новый ключ и стирает старый', () => {
      // Оверрайд модели задан под ключом нового чата (`home`); чат получил id.
      saveDraft('chat-model:home', 'opus');
      migrateDraft('chat-model:home', 'chat-model:chat:abc');

      expect(loadDraft('chat-model:chat:abc')).toBe('opus');
      expect(loadDraft('chat-model:home')).toBe('');
      expect([...store.map.keys()]).toEqual(['claude-control:draft:chat-model:chat:abc']);
    });

    it('пустой источник — ничего не создаёт (no-op)', () => {
      migrateDraft('chat-effort:home', 'chat-effort:chat:abc');
      expect(loadDraft('chat-effort:chat:abc')).toBe('');
      expect([...store.map.keys()]).toHaveLength(0);
    });

    it('совпадающие ключи не стирают значение', () => {
      saveDraft('home', 'недописанный текст');
      migrateDraft('home', 'home');
      expect(loadDraft('home')).toBe('недописанный текст');
    });

    it('не затирает уже существующий черновик под целевым ключом, если источник пуст', () => {
      saveDraft('chat:abc', 'уже набранное в реальном чате');
      migrateDraft('home', 'chat:abc'); // источник пуст → цель не трогаем
      expect(loadDraft('chat:abc')).toBe('уже набранное в реальном чате');
    });
  });
});
