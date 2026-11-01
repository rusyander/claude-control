import type { OutcomeRule } from '../sdk-stream/outcome.ts';

/**
 * Исход вызова у Claude Code 2.1.310 (проба этапа 8): текст `tool_result` — то, что получила
 * модель (`Exit code 3\n<вывод>` у упавшей команды, строки файла у Read), поэтому размер — его
 * байты. Изменчивых строк в рамке нет: путь вывода фоновой задачи бывает только в успехе.
 */
export const CLAUDE_OUTCOME: OutcomeRule = { contentIsPayload: true };
