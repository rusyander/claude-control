import { resultText } from './tool-shim/encode.ts';

/**
 * Инструменты клиента ПОЛЕМ — для платформы, которая принимает `tools` диалекта
 * OpenAI (`clientTools: 'native'`, аудит DRV-01).
 *
 * До этого модуля мост выбрасывал схемы, вызовы и результаты у ЛЮБОЙ платформы,
 * а у совместимого шлюза (vLLM, LiteLLM, OpenRouter) агент через панель
 * оставался без рук, хотя сам шлюз вызовы умеет. Половина ответа — `tool_calls`
 * обратно в блоки `tool_use` — жила давно (`frames.ts`); здесь половина запроса.
 *
 * Потери называются здесь же, списком: мост собирает их в след, и строка
 * «серверный инструмент вендора не доехал» отличается от «инструментов нет».
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Потеря, которую знает только этот перевод. */
export interface NativeLoss {
  field: string;
  note: string;
}

export const SERVER_TOOL_LOSS: NativeLoss = {
  field: 'tools (серверные инструменты вендора)',
  note: 'инструмент, который исполняет сам вендор (поиск, редактор), схемы аргументов не несёт — объявить его чужой модели нечем',
};

/**
 * Схемы Anthropic → функции OpenAI.
 *
 * Переносится только инструмент КЛИЕНТА: у него есть имя и схема, и исполняет
 * его сам клиент. Серверный инструмент вендора (`type: web_search_…`) исполняет
 * вендор, и объявить его другой модели значило бы пообещать вызов, который
 * некому выполнить.
 */
export function nativeToolList(input: unknown): {
  tools: Record<string, unknown>[];
  skipped: boolean;
  cached: boolean;
} {
  const tools: Record<string, unknown>[] = [];
  let skipped = false;
  let cached = false;
  if (!Array.isArray(input)) return { tools, skipped, cached };

  for (const item of input) {
    if (!isRecord(item)) continue;
    if (item.cache_control !== undefined) cached = true;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const custom = item.type === undefined || item.type === 'custom';
    if (!name || !custom) {
      skipped = true;
      continue;
    }
    tools.push({
      type: 'function',
      function: {
        name,
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
        // Схема без свойств — законный инструмент без аргументов; пустое место
        // вместо схемы строгий шлюз отвергает целиком.
        parameters: isRecord(item.input_schema)
          ? item.input_schema
          : { type: 'object', properties: {} },
      },
    });
  }
  return { tools, skipped, cached };
}

/**
 * Выбор инструмента: значения диалектов не совпадают ни одним.
 * `any` — это `required`; конкретный инструмент — функция по имени.
 * Непонятное значение не угадывается: `undefined`, и мост называет потерю.
 */
export function nativeToolChoice(choice: unknown): {
  value?: unknown;
  parallel?: false;
} {
  if (!isRecord(choice)) return {};
  const parallel = choice.disable_parallel_tool_use === true ? { parallel: false as const } : {};
  switch (choice.type) {
    case 'auto':
      return { value: 'auto', ...parallel };
    case 'any':
      return { value: 'required', ...parallel };
    case 'none':
      return { value: 'none' };
    case 'tool':
      return typeof choice.name === 'string' && choice.name
        ? { value: { type: 'function', function: { name: choice.name } }, ...parallel }
        : {};
    default:
      return {};
  }
}

/** Следы вызовов одной реплики — в упаковке OpenAI. */
export interface NativeTraces {
  /** `tool_use` → элементы `tool_calls` реплики ассистента. */
  calls: Record<string, unknown>[];
  /** `tool_result` → реплики с ролью `tool`. */
  results: Record<string, unknown>[];
  /** Внутри результата была не только текстовая часть. */
  droppedResultParts: boolean;
}

export function emptyTraces(): NativeTraces {
  return { calls: [], results: [], droppedResultParts: false };
}

/**
 * Блок `tool_use` либо `tool_result` → след в упаковке OpenAI.
 *
 * Аргументы вызова в OpenAI — строка JSON, а не объект: объект строгий шлюз
 * отвергает схемой. Ошибка результата помечается тем же словом, что у
 * прослойки: поля `is_error` в роли `tool` нет, а модель, не узнавшая о
 * провале, повторяет тот же вызов.
 */
export function collectNativeTrace(block: Record<string, unknown>, traces: NativeTraces): void {
  if (block.type === 'tool_use') {
    const name = typeof block.name === 'string' ? block.name : '';
    if (!name) return;
    traces.calls.push({
      id: typeof block.id === 'string' ? block.id : '',
      type: 'function',
      function: { name, arguments: JSON.stringify(block.input ?? {}) },
    });
    return;
  }
  const body = resultText(block.content);
  if (body.dropped) traces.droppedResultParts = true;
  traces.results.push({
    role: 'tool',
    tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
    content: `${block.is_error === true ? 'ошибка: ' : ''}${body.text}`,
  });
}
