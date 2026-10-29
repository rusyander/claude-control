/** Ответ модели, собранный клиентом-оракулом из потока или из JSON, — одна форма на все протоколы. */
export type ReplyPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown }
  | { kind: 'custom'; id: string; name: string; input: string };

export type Reply =
  | {
      kind: 'message';
      id: string;
      /** Как протокол назвал конец: end_turn / tool_use, stop / tool_calls, completed. */
      stopReason: string;
      /**
       * Нет — протокол его не прислал (настоящий чат OpenAI без `include_usage`; заглушка
       * шлёт расход на чанке конца всегда, как llama-server); `cached` — только ненулевой.
       */
      usage?: Usage;
      parts: ReplyPart[];
    }
  | { kind: 'error'; midStream: boolean; type: string; message: string };

export interface Usage {
  input: number;
  output: number;
  cached?: number;
}

/** Расход с полем кеша протокола: ноль или нет поля — `cached` не пишется. */
export function usageWith(input: number, output: number, cached: unknown): Usage {
  return typeof cached === 'number' && cached > 0 ? { input, output, cached } : { input, output };
}
