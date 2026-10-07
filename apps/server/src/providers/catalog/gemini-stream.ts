import type { ProviderStdoutParser } from '../types/assistant.ts';

/**
 * Разбор stdout `gemini -o stream-json -p …` (Gemini CLI 0.62.0, снято живым
 * прогоном на заглушке модели — фикстура `__fixtures__/gemini-0.62-stream-json.jsonl`).
 *
 * Поток — строка JSON на событие: `init`, `message` (`role` + `content`, у
 * ответа ассистента `delta: true` — каждый кусок ОЧЕРЕДНОЙ, не весь текст
 * заново), `tool_use`, `tool_result`, `result` (`status` + токены). Берём только
 * `content` сообщений ассистента; текст после инструмента отделяется пустой
 * строкой, как у Goose. Строка не JSON пропускается.
 *
 * Почему не текстовый вывод: на win32 gemini 0.62.0 после хода с вызовом
 * инструмента, когда соединение с моделью держится (keep-alive), печатает ответ
 * целиком и падает уже на выходе (`Assertion failed: !(handle->flags &
 * UV_HANDLE_CLOSING)`, код 0xC0000409). По одному коду выхода ответ было не
 * отличить от сбоя, и человек видел вместо ответа предупреждения CLI. Событие
 * `result` со `status: "success"` — слово самого CLI, что ход кончился удачно:
 * `settled()` говорит запуску, что ненулевой код после него — сбой выхода.
 */
export function createGeminiStreamParser(): ProviderStdoutParser {
  let pending = '';
  let said = false;
  let afterTool = false;
  let succeeded = false;

  const take = (line: string): string => {
    const raw = line.trim();
    if (!raw.startsWith('{')) return '';
    let event: { type?: unknown; role?: unknown; content?: unknown; status?: unknown };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      return '';
    }
    if (event.type === 'result') {
      succeeded = event.status === 'success';
      return '';
    }
    if (event.type === 'tool_result') {
      afterTool = true;
      return '';
    }
    if (event.type !== 'message' || event.role !== 'assistant') return '';
    if (typeof event.content !== 'string' || !event.content) return '';
    const separator = afterTool && said ? '\n\n' : '';
    afterTool = false;
    said = true;
    return separator + event.content;
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
    settled: () => succeeded,
  };
}
