import type { MessageUsage } from '@agentdeck/contracts';

/** Меньше — скорость по паре токенов скачет на порядок и ничего не говорит. */
const MIN_OUTPUT = 8;

/**
 * Скорость генерации шага, ток/с, — только для модели не из облака Claude.
 *
 * Зачем только там: у локальной модели (и у чужой в контуре) скорость и есть то,
 * что человек выбирает, — карта, кеш, контекст; у облачного Claude её не
 * поменять, и лишнее число в каждой строке ленты было бы шумом. Время берётся
 * из живого потока (`genMs`, без чтения промпта); у шага из транскрипта его нет —
 * тогда и скорости нет, а не выдуманный ноль.
 */
export function generationSpeed(usage: MessageUsage): number | undefined {
  if (!usage.genMs || usage.genMs <= 0 || usage.output < MIN_OUTPUT) return undefined;
  if (!usage.model || /^claude/i.test(usage.model)) return undefined;
  return Math.round(usage.output / (usage.genMs / 1000));
}
