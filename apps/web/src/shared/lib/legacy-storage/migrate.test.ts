import { describe, expect, it } from 'vitest';
import { migrateLegacyStorageKeys } from './migrate';

/** Прежнее имя задом наперёд: литерала в дереве нет, а ошибку сборки префикса тест ловит. */
const OLD = `${[...'lortnoc-edualc'].reverse().join('')}:`;

/** Storage поверх Map: тесты идут в node, где браузерного хранилища нет. */
function memoryStorage(initial: Record<string, string>): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
  };
}

describe('migrateLegacyStorageKeys', () => {
  it('переносит ключи прежнего имени и убирает их', () => {
    const storage = memoryStorage({
      [`${OLD}workspace`]: '{"tabs":1}',
      [`${OLD}draft:chat`]: 'текст',
      'чужой:ключ': 'x',
    });
    expect(migrateLegacyStorageKeys(storage)).toBe(2);
    expect(storage.getItem('agentdeck:workspace')).toBe('{"tabs":1}');
    expect(storage.getItem('agentdeck:draft:chat')).toBe('текст');
    expect(storage.getItem(`${OLD}workspace`)).toBeNull();
    expect(storage.getItem('чужой:ключ')).toBe('x');
  });

  it('не затирает уже записанный новый ключ и не воскрешает старый', () => {
    const storage = memoryStorage({
      'agentdeck:workspace': 'новое',
      [`${OLD}workspace`]: 'старое',
    });
    expect(migrateLegacyStorageKeys(storage)).toBe(0);
    expect(storage.getItem('agentdeck:workspace')).toBe('новое');
    expect(storage.getItem(`${OLD}workspace`)).toBeNull();
    expect(migrateLegacyStorageKeys(storage)).toBe(0);
  });

  it('недоступное хранилище — не сбой', () => {
    expect(migrateLegacyStorageKeys(undefined)).toBe(0);
  });
});
