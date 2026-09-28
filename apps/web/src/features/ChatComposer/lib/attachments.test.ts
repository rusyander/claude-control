import { describe, it, expect } from 'vitest';
import { hasRejections, pastedNames, planAttach, MAX_FILE_BYTES } from './attachments';

/**
 * Регрессия: файл крупнее предела отсеивался молча — ни чипа, ни сообщения.
 * Со стороны это неотличимо от сломанного перетаскивания, и человек пробовал
 * снова. Теперь отсеянные возвращаются наружу — их называют человеку.
 *
 * Кейс chat-004: .exe ложился чипом и отвергался только при отправке. Теперь
 * тип проверяется в момент вложения, тем же предикатом, что и при отправке.
 */
const file = (name: string, size: number): { name: string; size: number } => ({ name, size });

describe('planAttach — размер', () => {
  it('слишком большой файл называется по имени и размеру, а не пропадает молча', () => {
    const plan = planAttach([file('отчёт.pdf', MAX_FILE_BYTES + 1), file('note.md', 10)]);

    expect(plan.tooLarge).toEqual([{ name: 'отчёт.pdf', size: MAX_FILE_BYTES + 1 }]);
    expect(plan.unsupported).toEqual([]);
    expect(plan.accepted.map((item) => item.name)).toEqual(['note.md']);
  });

  it('когда всё крупное — не приложено ничего, но сказано обо всех', () => {
    const plan = planAttach([file('a.pdf', 30e6), file('b.png', 25e6)], 20e6);

    expect(plan.accepted).toEqual([]);
    expect(plan.tooLarge.map((item) => item.name)).toEqual(['a.pdf', 'b.png']);
  });

  it('ровно на границе — прикладываем: предел объявлен как «до»', () => {
    const plan = planAttach([file('edge.png', MAX_FILE_BYTES)]);

    expect(hasRejections(plan)).toBe(false);
    expect(plan.accepted).toHaveLength(1);
  });

  it('обычные файлы проходят без единого отказа', () => {
    const plan = planAttach([file('a.md', 1), file('b.ts', 2)]);

    expect(hasRejections(plan)).toBe(false);
    expect(plan.accepted).toHaveLength(2);
  });
});

describe('planAttach — тип', () => {
  it('кейс chat-004: .exe отвергается при вложении, чипа нет', () => {
    const plan = planAttach([file('tool.exe', 10), file('note.md', 10)]);

    expect(plan.unsupported).toEqual(['tool.exe']);
    expect(plan.accepted.map((item) => item.name)).toEqual(['note.md']);
    expect(hasRejections(plan)).toBe(true);
  });

  it('крупный файл неподдерживаемого типа — отказ по типу, не по размеру', () => {
    const plan = planAttach([file('setup.exe', MAX_FILE_BYTES * 2)]);

    expect(plan.unsupported).toEqual(['setup.exe']);
    expect(plan.tooLarge).toEqual([]);
  });

  it('расширение без учёта регистра, как у сервера', () => {
    const plan = planAttach([file('SHOT.PNG', 10), file('noext', 10)]);

    expect(plan.accepted.map((item) => item.name)).toEqual(['SHOT.PNG']);
    expect(plan.unsupported).toEqual(['noext']);
  });
});

describe('pastedNames — две вставки в одну секунду (F-195)', () => {
  const now = new Date(2026, 8, 28, 10, 11, 12);
  const shot = { name: 'image.png', type: 'image/png' };

  it('второй снимок той же секунды получает своё имя, а не двойника чипа', () => {
    const first = pastedNames([shot], [], now);
    const second = pastedNames([shot], first, now);
    expect(second[0]).not.toBe(first[0]);
  });

  it('два снимка в одной вставке — тоже разные имена', () => {
    const [a, b] = pastedNames([shot, shot], [], now);
    expect(a).not.toBe(b);
  });
});
