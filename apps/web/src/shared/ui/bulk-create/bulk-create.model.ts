import type { ParsedLine } from './bulk-create.types';

/**
 * Итог пакетного создания: сколько строк прошло и какие сорвались.
 *
 * Список упавших возвращается сырыми строками, а не индексами: форма кладёт их
 * обратно в поле ввода, чтобы поправить и повторить — уже созданное при этом
 * повторно не уходит.
 */
export interface BulkCreateResult {
  created: number;
  failed: string[];
}

/**
 * Создаёт черновики по одному по порядку: сервер правит конфиг-файл, и
 * параллельные записи в него наступали бы друг другу на пятки.
 *
 * Главное здесь — не прерываться на ошибке. Раньше отказ сервера по одной
 * строке (например, дубль существующего права) выбрасывал исключение прямо из
 * цикла: остальные строки не создавались, а форма навсегда оставалась в
 * состоянии «создаю» — кнопка заблокирована, прогресс замер, окно не закрыть.
 * Поэтому каждая строка обёрнута отдельно, а вызывающему возвращается отчёт.
 */
export async function runBulkCreate<TDraft>(
  lines: ParsedLine<TDraft>[],
  createOne: (draft: TDraft) => Promise<unknown>,
  onProgress?: (done: number, total: number) => void,
): Promise<BulkCreateResult> {
  const total = lines.length;
  let created = 0;
  const failed: string[] = [];

  for (const [index, line] of lines.entries()) {
    if (line.draft) {
      try {
        await createOne(line.draft);
        created += 1;
      } catch {
        // Текст ошибки показывает глобальный тост; здесь важно лишь запомнить,
        // какая строка не прошла, и продолжить остальные.
        failed.push(line.raw);
      }
    }

    onProgress?.(index + 1, total);
  }

  return { created, failed };
}
