import { matchText, serverText } from '../../../lib/server-texts/server-texts.ts';

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
  code: 'cli-outdated' | 'prompt-too-long' | 'chat-process-lost' | CoreRefusalCode;
  params?: Record<string, string>;
  /** Контекст переполнен — и при коде устаревшего CLI (сжатие упало из-за версии). */
  overflow?: boolean;
  /**
   * Текст ошибки — сама панель по коду (не строка CLI): клиент показывает только перевод кода,
   * русская строка сервера под ним была бы повтором на другом языке.
   */
  panel?: true;
}

/** Отказы ядра в ходе чата (`core-run/refusal-text.ts`), текстом панели по коду. */
const CORE_REFUSALS = [
  'core-chat-contour-down',
  'core-chat-model-needed',
  'core-chat-contour-model',
  'core-chat-estimate-refused',
  'core-chat-refused',
  'core-chat-kit-hooks',
  'core-chat-kit-mcp',
  'core-chat-kit-missing',
  'core-chat-layer-untrusted',
  'core-chat-layer-mode',
  'core-chat-layer-sources',
  'core-chat-layer-build',
  'core-chat-layer-fit',
  'core-chat-carry-unsupported',
] as const;
type CoreRefusalCode = (typeof CORE_REFUSALS)[number];

function coreRefusalCode(message: string): RunErrorCode | undefined {
  const matched = matchText(message);
  const code = matched?.messageCode;
  if (!code || !(CORE_REFUSALS as readonly string[]).includes(code)) return undefined;
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(matched.params ?? {}))
    if (typeof value !== 'object') params[name] = String(value);
  return { code: code as CoreRefusalCode, params, panel: true };
}

/**
 * Разбор сырого текста ошибки CLI (живой прогон 25.09.2026): «Prompt is too long ·
 * automatic compaction failed: API Error: 400 Claude Code 2.1.278 does not support
 * this model; version 2.1.280 or newer is required…». Устаревший CLI — главнее:
 * обновление чинит и сжатие; переполнение при этом остаётся флагом.
 */
export function runErrorCode(message: string): RunErrorCode | undefined {
  // Текст панели по коду (прерванный ход, `auto-continue`): код едет рядом, чтобы
  // английский интерфейс не показывал русскую строку.
  if (message === serverText('chat-process-lost'))
    return { code: 'chat-process-lost', panel: true };
  const refusal = coreRefusalCode(message);
  if (refusal) return refusal;
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
