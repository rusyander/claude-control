import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { createFoldBook } from './folds.ts';

/**
 * Книга свёрток (этап 11, P146) на настоящем реестре задач: свёртку живой задачи ведёт подписка.
 * Задача, закрытая и открытая заново (потеря аренды, повторное открытие), — НОВЫЙ объект живой
 * задачи: подписка на старый строк больше не получит, и сторож фона судил бы по застывшей свёртке.
 */

describe('stage 11 agents fold book over the task registry', () => {
  it('a task reopened as a new live object is followed anew: its next lines reach the fold', async () => {
    const registry = createTaskRegistry(join(tempDir('fold-book-'), 'tasks'), deps());
    const first = await registry.create(CREATED);
    const book = createFoldBook(registry);
    const seen: string[] = [];
    const onLine = (_f: unknown, line: { kind: string }) => seen.push(line.kind);
    book.follow(first, onLine);
    // Аренда потеряна и задача открыта снова между двумя обходами: живая задача — другой объект.
    registry.drop(first.taskId);
    const again = await registry.open(first.taskId);
    if (!('task' in again)) throw new Error(again.refused);
    expect(again.task).not.toBe(first);
    const fold = book.follow(again.task, onLine);
    again.task.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } } as never);
    expect(fold.taskEnded).toBe(true);
    expect(seen).toContain('task.ended');
    // Повтор с тем же объектом — та же подписка, не вторая.
    expect(book.follow(again.task, onLine)).toBe(fold);
    book.close();
    registry.closeAll();
  });
});
