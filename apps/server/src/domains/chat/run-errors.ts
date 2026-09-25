/**
 * Похоже ли падение прогона на временное — «сеть моргнула», перегрузка, таймаут.
 *
 * Разбор текста живёт ЗДЕСЬ, а не на клиенте, и применяется только к ошибкам,
 * пришедшим от самого CLI. Клиент по тексту не решает ничего: он видит готовый
 * флаг. Отказы панели (занят/вложение/нет папки) сюда не попадают вовсе — они
 * уходят HTTP-статусом с кодом, и подставить в такой текст своё имя файла,
 * чтобы выпросить авто-ретрай, больше нельзя.
 */
export function isRetriableRunError(message: string): boolean {
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|Connection error|overloaded|temporarily|timed?\s?out|\b50[234]\b|\b529\b/i.test(
    message,
  );
}

/** Код известной ошибки CLI — клиент показывает понятный текст и действие, а не сырую строку. */
export interface RunErrorCode {
  code: 'cli-outdated' | 'prompt-too-long';
  params?: Record<string, string>;
  /** Контекст переполнен — и при коде устаревшего CLI (сжатие упало из-за версии). */
  overflow?: boolean;
}

/**
 * Разбор сырого текста ошибки CLI (живой прогон 25.09.2026): «Prompt is too long ·
 * automatic compaction failed: API Error: 400 Claude Code 2.1.278 does not support
 * this model; version 2.1.280 or newer is required…». Устаревший CLI — главнее:
 * обновление чинит и сжатие; переполнение при этом остаётся флагом.
 */
export function runErrorCode(message: string): RunErrorCode | undefined {
  const overflow = /prompt is too long/i.test(message);
  const outdated =
    /Claude Code (\d+\.\d+\.\d+) does not support this model; version (\d+\.\d+\.\d+) or newer is required/i.exec(
      message,
    );
  if (outdated) {
    return {
      code: 'cli-outdated',
      params: { current: outdated[1] as string, required: outdated[2] as string },
      ...(overflow ? { overflow } : {}),
    };
  }
  return overflow ? { code: 'prompt-too-long', overflow } : undefined;
}
