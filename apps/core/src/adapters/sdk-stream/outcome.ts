import { maskSecretsInText } from '@agentdeck/dlp/secret-mask';
import type { ToolOutcome } from '../adapter.types.ts';

/**
 * Исход вызова инструмента из блока `tool_result` потока `stream-json` (этап 8, F18). Только поля,
 * которые CLI пишет сам: признак ошибки и текст блока — не текст модели. Код выхода структурным
 * полем не отдаёт ни Claude Code 2.1.310 (`tool_use_result` упавшей команды — строка), ни Qwen
 * Code 0.24.3 (только текстовая рамка) — проба `.agent/tmp/core-s8-measure.agent.md` §Probe;
 * поэтому `exitCode` всегда `null`, повтор сбоя узнаётся по отпечатку `errorText`.
 */

/** Предел текста ошибки, байт UTF-8 (контракт `ToolOutcome.errorText`). */
export const ERROR_TEXT_MAX_BYTES = 2048;

export interface OutcomeRule {
  /** Текст блока — то, что получила модель (Claude); `false` — поток несёт подпись для показа (Qwen). */
  contentIsPayload: boolean;
  /**
   * Строки рамки CLI, меняющиеся от вызова к вызову при том же сбое (pid группы процесса у Qwen):
   * без их снятия отпечаток ошибки не повторяется никогда, и повтор сбоя не срабатывает.
   */
  volatileLine?(line: string): boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Текст блока: строка или текстовые части массива (картинки в текст не входят). */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => isObject(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => (part as { text: string }).text)
    .join('\n');
}

/** Обрезка по байтам UTF-8 без разрыва символа. */
export function clipBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return text;
  let end = max;
  // Продолжение многобайтного символа (10xxxxxx) — назад до его начала.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

export function readToolOutcome(block: Record<string, unknown>, rule: OutcomeRule): ToolOutcome {
  const text = resultText(block.content);
  const isError = block.is_error === true;
  let errorText: string | null = null;
  if (isError) {
    // CRLF Windows и LF Linux — один отпечаток; маска до обрезки: обрезок секрета маска не узнаёт.
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const kept = rule.volatileLine ? lines.filter((l) => !rule.volatileLine!(l)) : lines;
    errorText = clipBytes(maskSecretsInText(kept.join('\n').trim()), ERROR_TEXT_MAX_BYTES);
  }
  return {
    exitCode: null,
    errorText,
    bytes: rule.contentIsPayload ? Buffer.byteLength(text, 'utf8') : null,
  };
}
