import { describe, it, expect } from 'vitest';
import { planAttach, MAX_FILE_BYTES } from './attachments';

/**
 * Регрессия: файл крупнее предела отсеивался молча — ни чипа, ни сообщения.
 * Со стороны это неотличимо от сломанного перетаскивания, и человек пробовал
 * снова. Теперь отсеянные имена возвращаются наружу — их называют человеку.
 */
const file = (name: string, size: number): { name: string; size: number } => ({ name, size });

describe('planAttach', () => {
  it('слишком большой файл называется по имени, а не пропадает молча', () => {
    const plan = planAttach([file('отчёт.pdf', MAX_FILE_BYTES + 1), file('note.md', 10)]);

    expect(plan.rejected).toEqual(['отчёт.pdf']);
    expect(plan.accepted.map((item) => item.name)).toEqual(['note.md']);
  });

  it('когда всё крупное — не приложено ничего, но сказано обо всех', () => {
    const plan = planAttach([file('a.pdf', 30e6), file('b.png', 25e6)], 20e6);

    expect(plan.accepted).toEqual([]);
    expect(plan.rejected).toEqual(['a.pdf', 'b.png']);
  });

  it('ровно на границе — прикладываем: предел объявлен как «до»', () => {
    const plan = planAttach([file('edge.png', MAX_FILE_BYTES)]);

    expect(plan.rejected).toEqual([]);
    expect(plan.accepted).toHaveLength(1);
  });

  it('обычные файлы проходят без единого отказа', () => {
    const plan = planAttach([file('a.md', 1), file('b.ts', 2)]);

    expect(plan.rejected).toEqual([]);
    expect(plan.accepted).toHaveLength(2);
  });
});
