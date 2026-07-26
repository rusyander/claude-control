import { describe, it, expect, vi } from 'vitest';
import { runBulkCreate } from './bulk-create.model';
import type { ParsedLine } from './bulk-create.types';

/**
 * Регрессия, ради которой тест и написан: одна отклонённая сервером строка
 * прерывала весь цикл создания. Форма оставалась в состоянии «создаю» навсегда
 * — кнопка заблокирована со спиннером, прогресс замер, окно не закрывалось, —
 * а строки после упавшей молча терялись.
 */

const lines = (...raw: string[]): ParsedLine<string>[] =>
  raw.map((line) => ({ raw: line, draft: line }));

describe('runBulkCreate', () => {
  it('падение одной строки не останавливает остальные', async () => {
    const createOne = vi.fn(async (draft: string) => {
      if (draft === 'b') throw new Error('duplicate');
      return draft;
    });

    const result = await runBulkCreate(lines('a', 'b', 'c', 'd'), createOne);

    expect(createOne).toHaveBeenCalledTimes(4);
    expect(result.created).toBe(3);
    expect(result.failed).toEqual(['b']);
  });

  it('не выбрасывает исключение наружу — форме есть где выключить «создаю»', async () => {
    const createOne = vi.fn(async () => {
      throw new Error('server said no');
    });

    await expect(runBulkCreate(lines('a', 'b'), createOne)).resolves.toEqual({
      created: 0,
      failed: ['a', 'b'],
    });
  });

  it('прогресс доходит до конца списка даже с ошибками', async () => {
    const steps: Array<[number, number]> = [];
    const createOne = vi.fn(async (draft: string) => {
      if (draft === 'a') throw new Error('нет');
      return draft;
    });

    await runBulkCreate(lines('a', 'b', 'c'), createOne, (done, total) =>
      steps.push([done, total]),
    );

    expect(steps).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('строки без черновика пропускаются, но прогресс их считает', async () => {
    const createOne = vi.fn(async (draft: string) => draft);
    const input: ParsedLine<string>[] = [
      { raw: 'bad', error: 'нет знака =' },
      { raw: 'good', draft: 'good' },
    ];

    const result = await runBulkCreate(input, createOne, () => {});

    expect(createOne).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ created: 1, failed: [] });
  });

  it('создание идёт по одному, а не параллельно: сервер правит один файл', async () => {
    let running = 0;
    let maxParallel = 0;
    const createOne = vi.fn(async () => {
      running += 1;
      maxParallel = Math.max(maxParallel, running);
      await Promise.resolve();
      running -= 1;
    });

    await runBulkCreate(lines('a', 'b', 'c'), createOne);

    expect(maxParallel).toBe(1);
  });
});
