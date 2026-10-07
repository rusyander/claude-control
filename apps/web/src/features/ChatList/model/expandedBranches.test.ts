import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXPANDED_BRANCHES_KEY,
  readExpandedBranches,
  writeExpandedBranches,
} from './expandedBranches';

/**
 * Память раскрытых ветвей (G1): переживает перезагрузку, а испорченное или
 * недоступное хранилище даёт «всё свёрнуто», а не падение списка.
 */

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('память раскрытых ветвей списка чатов', () => {
  it('записанное читается обратно тем же набором', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    writeExpandedBranches(new Set(['родитель-1', 'родитель-2']));

    expect([...readExpandedBranches()].sort()).toEqual(['родитель-1', 'родитель-2']);
    expect(JSON.parse(localStorage.getItem(EXPANDED_BRANCHES_KEY) ?? '')).toEqual([
      'родитель-1',
      'родитель-2',
    ]);
  });

  it('пусто, битый JSON, не массив, чужие значения — свёрнуто, без падения', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(readExpandedBranches().size).toBe(0);

    vi.stubGlobal('localStorage', fakeStorage({ [EXPANDED_BRANCHES_KEY]: '{не json' }));
    expect(readExpandedBranches().size).toBe(0);

    vi.stubGlobal('localStorage', fakeStorage({ [EXPANDED_BRANCHES_KEY]: '{"a":1}' }));
    expect(readExpandedBranches().size).toBe(0);

    vi.stubGlobal('localStorage', fakeStorage({ [EXPANDED_BRANCHES_KEY]: '["р", 7, null]' }));
    expect([...readExpandedBranches()]).toEqual(['р']);
  });

  it('хранилище бросает (приватное окно) — чтение пустое, запись молчит', () => {
    const throwing = fakeStorage();
    throwing.getItem = () => {
      throw new Error('SecurityError');
    };
    throwing.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    vi.stubGlobal('localStorage', throwing);

    expect(readExpandedBranches().size).toBe(0);
    expect(() => writeExpandedBranches(new Set(['р']))).not.toThrow();
  });
});
