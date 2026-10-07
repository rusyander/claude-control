import type { ProviderStdoutParser } from '../types/assistant.ts';

/**
 * Разбор stdout `goose run -q --output-format stream-json` (Goose 1.53, снято
 * живым прогоном на заглушке модели — фикстура `__fixtures__/goose-1.53-run-stream-json.jsonl`).
 *
 * Поток — строка JSON на событие: `message` (сообщение целиком в форме Goose:
 * `role` + массив `content`), `complete` (итог с токенами), а также служебные
 * `notification` / `model_change` / `error`. Ответ модели идёт кусками: каждое
 * событие `message` от ассистента несёт ОЧЕРЕДНОЙ кусок текста, а не весь
 * текст заново (проверено ответом из трёх кусков).
 *
 * Почему не текстовый вывод: и с `-q` Goose печатает в stdout вызов инструмента
 * (`▸ shell`, `command: …`) и его вывод, склеенный с ответом, а без `-q` — ещё и
 * заставку с путём рабочего каталога. Всё это ложилось в переписку как ответ.
 *
 * Берём только части `type: 'text'` у сообщений ассистента: запрос инструмента,
 * его результат (сообщение `user` с `toolResponse`) и размышления ответом не
 * являются. Текст после инструмента отделяется пустой строкой — как в живом
 * `goose acp`. Строка не JSON (предупреждение CLI) пропускается: в этом формате
 * ответ бывает только внутри события.
 */
export function createGooseStreamParser(): ProviderStdoutParser {
  let pending = '';
  let said = false;
  let afterTool = false;

  const take = (line: string): string => {
    const raw = line.trim();
    if (!raw.startsWith('{')) return '';
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return '';
    }
    const message =
      (event as { type?: unknown; message?: unknown }).type === 'message'
        ? ((event as { message?: { role?: unknown; content?: unknown } }).message ?? {})
        : undefined;
    if (!message || !Array.isArray(message.content)) return '';
    const parts = message.content as { type?: unknown; text?: unknown }[];
    if (message.role !== 'assistant') {
      if (parts.some((part) => part.type === 'toolResponse')) afterTool = true;
      return '';
    }
    const text = parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');
    if (!text) return '';
    const separator = afterTool && said ? '\n\n' : '';
    afterTool = false;
    said = true;
    return separator + text;
  };

  return {
    push(chunk) {
      const lines = `${pending}${chunk}`.split('\n');
      pending = lines.pop() ?? '';
      return lines.map(take).join('');
    },
    end() {
      const last = pending;
      pending = '';
      return last ? take(last) : '';
    },
  };
}
