import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeWhenFree } from './remove-when-free.ts';

function failing(code: string) {
  return Object.assign(new Error(code), { code });
}

/**
 * Удаление, которое первые `times` раз отвечает `code`, — так Windows отвечает,
 * пока каталог держит уходящий CLI. Занять каталог по-настоящему проверка не
 * может: держит ли его рабочий каталог чужого процесса, решает сборка Windows,
 * и такой тест сам был бы плавающим.
 */
function heldFor(times: number, code = 'EBUSY') {
  const calls: string[] = [];
  return {
    calls,
    remove: (dir: string) => {
      calls.push(dir);
      if (calls.length <= times) throw failing(code);
    },
  };
}

describe('removeWhenFree', () => {
  it('занятый каталог ждёт освобождения, а не падает на первом отказе', async () => {
    for (const code of ['EBUSY', 'EPERM', 'ENOTEMPTY']) {
      const held = heldFor(2, code);
      await removeWhenFree('/tmp/x', 5_000, held.remove);
      expect(held.calls).toHaveLength(3);
    }
  });

  it('не освободился за срок — настоящая ошибка, а не молча оставленный каталог', async () => {
    const held = heldFor(Number.POSITIVE_INFINITY);
    await expect(removeWhenFree('/tmp/x', 400, held.remove)).rejects.toMatchObject({
      code: 'EBUSY',
    });
    expect(held.calls).toHaveLength(3);
  });

  it('чужая ошибка не ждёт: сразу наружу', async () => {
    const held = heldFor(1, 'ENOENT_LIKE');
    await expect(removeWhenFree('/tmp/x', 5_000, held.remove)).rejects.toMatchObject({
      code: 'ENOENT_LIKE',
    });
    expect(held.calls).toHaveLength(1);
  });

  it('настоящий каталог снимается, повторный вызов по снятому — не ошибка', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-free-'));
    writeFileSync(join(dir, 'file.txt'), 'x');
    await removeWhenFree(dir);
    await removeWhenFree(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
