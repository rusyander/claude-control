import type { DlpApiKind } from '../../dlp/api-shapes.ts';

/**
 * Перевод диалектов: клиент говорит по-Anthropic, контур — по-OpenAI.
 *
 * ТАБЛИЦА НАПИСАНА ДО КОДА и живёт данными, а не расползается по условиям в
 * трёх функциях: перевод — самая опасная часть шлюза, и единственный способ
 * отвечать за него — держать перечень соответствий в одном месте, где его
 * видно целиком, и прогонять тестом каждую строку.
 *
 * Второе, ради чего таблица существует: ЧТО НЕ ПЕРЕНОСИТСЯ. Мост, который
 * молча теряет половину запроса, хуже отсутствия моста — человек считает, что
 * модель видела инструменты, размышления и документы, а она их не видела.
 * Поэтому каждая потеря названа строкой таблицы, попадает в след запроса и
 * подписана компромиссом `dialect-bridge`.
 *
 * Направление здесь ровно одно: наверх всегда уходит диалект OpenAI, потому что
 * так говорит контур (справочник §5). Обратно ответ переводится в тот диалект,
 * на котором спросил клиент.
 */

/** Диалект — тот же словарь форм, что у прокси защиты данных: второго нет. */
export type Dialect = DlpApiKind;

/** Что мост делает с полем. */
export type DialectFate =
  /** Переносится как есть. */
  | 'mapped'
  /** Переносится под другим именем. */
  | 'renamed'
  /** Переносится частично: часть смысла теряется, и она названа. */
  | 'lossy'
  /** Не переносится вовсе. */
  | 'dropped';

export interface DialectRow {
  /** Поле в диалекте Anthropic — то, что присылает клиент. */
  anthropic: string;
  /** Поле в диалекте OpenAI — то, что понимает контур. Пусто — не доезжает. */
  openai: string;
  fate: DialectFate;
  /** Почему так. Этот текст панель показывает человеку не переводя. */
  note: string;
}

/**
 * Соответствия. Порядок — от главного к частному; он же порядок показа.
 *
 * Строки с `fate: 'dropped'` — не забытые, а СОЗНАТЕЛЬНО не перенесённые:
 * инструменты клиенту объявить нельзя (`no-client-tools`, справочник §6),
 * подписанный блок размышлений мост воспроизвести не может, а полей вроде
 * `top_k` в диалекте OpenAI просто нет.
 */
export const DIALECT_TABLE: DialectRow[] = [
  { anthropic: 'model', openai: 'model', fate: 'mapped', note: 'имя модели идёт как есть' },
  {
    anthropic: 'messages',
    openai: 'messages',
    fate: 'lossy',
    note: 'реплики переносятся; блоки содержимого разворачиваются в текст и картинки',
  },
  {
    anthropic: 'system',
    openai: 'messages[0].role=system',
    fate: 'renamed',
    note: 'системная строка становится первой репликой с ролью system',
  },
  {
    anthropic: 'system[] (массив блоков)',
    openai: 'messages[0].role=system',
    fate: 'lossy',
    note: 'текст блоков склеивается; разметка блоков и пометки кэша теряются',
  },
  { anthropic: 'max_tokens', openai: 'max_tokens', fate: 'mapped', note: 'потолок ответа' },
  { anthropic: 'temperature', openai: 'temperature', fate: 'mapped', note: '' },
  { anthropic: 'top_p', openai: 'top_p', fate: 'mapped', note: '' },
  {
    anthropic: 'top_k',
    openai: '',
    fate: 'dropped',
    note: 'в диалекте OpenAI такого параметра нет — придумывать замену мост не станет',
  },
  {
    anthropic: 'stop_sequences',
    openai: 'stop',
    fate: 'renamed',
    note: 'список стоп-строк',
  },
  { anthropic: 'stream', openai: 'stream', fate: 'mapped', note: '' },
  {
    anthropic: 'metadata.user_id',
    openai: 'user',
    fate: 'lossy',
    note: 'контур принимает поле схемой и до модели не доносит (справочник §5)',
  },
  {
    anthropic: 'tools',
    openai: '',
    fate: 'dropped',
    note: 'свои инструменты контуру объявить нельзя: он подбирает их сам (`no-client-tools`)',
  },
  {
    anthropic: 'tool_choice',
    openai: '',
    fate: 'dropped',
    note: 'выбирать не из чего: набор инструментов не наш',
  },
  {
    anthropic: 'thinking',
    openai: '',
    fate: 'dropped',
    note: 'подписанный блок размышлений мост воспроизвести не может — подпись стала бы недействительной',
  },
  {
    anthropic: 'cache_control',
    openai: '',
    fate: 'dropped',
    note: 'кэш промпта — свойство вендорного API, у контура его нет',
  },
  {
    anthropic: 'content[].image',
    openai: 'content[].image_url',
    fate: 'renamed',
    note: 'картинка переносится data-адресом; поймёт ли её модель, зависит от самой модели',
  },
  {
    anthropic: 'content[].document',
    openai: '',
    fate: 'dropped',
    note: 'документов и цитат в диалекте контура нет',
  },
  {
    anthropic: 'content[].tool_use / tool_result',
    openai: '',
    fate: 'dropped',
    note: 'следы вызова инструментов уходят вместе с инструментами; пустая реплика не отправляется',
  },
  {
    anthropic: 'content[].text ← choices[].message.content',
    openai: 'choices[].message.content',
    fate: 'mapped',
    note: 'ответ разворачивается обратно в блок текста',
  },
  {
    anthropic: 'stop_reason ← finish_reason',
    openai: 'choices[].finish_reason',
    fate: 'renamed',
    note: 'stop → end_turn, length → max_tokens, tool_calls → tool_use',
  },
  {
    anthropic: 'usage.input_tokens ← usage.prompt_tokens',
    openai: 'usage.prompt_tokens',
    fate: 'renamed',
    note: 'расход переименовывается, значения те же',
  },
];

/**
 * Что контур выбрасывает из запроса, написанного НА ЕГО ЖЕ диалекте.
 *
 * Мост здесь ни при чём: клиент говорит по-OpenAI, контур принимает по-OpenAI,
 * и переводить нечего — а половина полей всё равно не доезжает до модели
 * (справочник §5, `build_completion_kwargs`). Без этой таблицы след запроса от
 * codex или cursor честно показывал бы «перенеслось всё» ровно там, где молча
 * пропали инструменты, — то есть в самом важном случае.
 *
 * Названия полей здесь — имена диалекта OpenAI, а не наши: человек ищет их в
 * своём конфиге и в документации CLI.
 */
export const OPENAI_DROPPED: DialectLoss[] = [
  {
    field: 'tools',
    note: 'контур игнорирует схемы инструментов молча: он подбирает инструменты сам (`no-client-tools`)',
  },
  {
    field: 'n',
    note: 'принято схемой и потеряно: контур отдаёт один вариант ответа (справочник §5)',
  },
  { field: 'presence_penalty', note: 'принято схемой контура и до модели не доносится' },
  { field: 'frequency_penalty', note: 'принято схемой контура и до модели не доносится' },
  { field: 'user', note: 'принято схемой контура и до модели не доносится' },
  {
    field: 'response_format',
    note: 'схемой контура не объявлено — пройдёт лишним ключом и исчезнет',
  },
  { field: 'seed', note: 'схемой контура не объявлено — пройдёт лишним ключом и исчезнет' },
  { field: 'logprobs', note: 'схемой контура не объявлено — пройдёт лишним ключом и исчезнет' },
  { field: 'logit_bias', note: 'схемой контура не объявлено — пройдёт лишним ключом и исчезнет' },
];

/**
 * Потери запроса в диалекте OpenAI: называются только РЕАЛЬНО присланные поля.
 * `tool_choice: "none"` потерей не считается — это единственное его значение,
 * которое у контура работает (выключает инструменты платформы).
 */
export function openAiRequestLoss(body: Record<string, unknown>): DialectLoss[] {
  const lost = OPENAI_DROPPED.filter((row) => body[row.field] !== undefined);
  if (body.tool_choice !== undefined && body.tool_choice !== 'none') {
    lost.push({
      field: 'tool_choice',
      note: 'у контура имеет смысл только «none»: набор инструментов не наш',
    });
  }
  return lost;
}

/** Причина остановки: значения диалектов не совпадают ни одним. */
const STOP_REASON: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
};

/** Одна потеря перевода: что именно не доехало и почему. */
export interface DialectLoss {
  field: string;
  note: string;
}

export interface TranslatedRequest {
  body: Record<string, unknown>;
  /** Что не перенеслось — по одной записи на РЕАЛЬНО встреченное поле. */
  lost: DialectLoss[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Строка таблицы по имени поля Anthropic — чтобы текст потери был один. */
function rowNote(anthropic: string): string {
  return DIALECT_TABLE.find((row) => row.anthropic === anthropic)?.note ?? '';
}

function lose(lost: DialectLoss[], field: string): void {
  if (lost.some((item) => item.field === field)) return;
  lost.push({ field, note: rowNote(field) });
}

/** Часть содержимого в форме OpenAI: текст либо картинка. */
type OpenAiPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/**
 * Блоки Anthropic → части OpenAI. Возвращает пусто, если переносить нечего:
 * реплика из одних следов инструментов не отправляется вовсе, потому что
 * контур требует непустое содержимое у всех ролей, кроме assistant.
 */
function blocksToParts(content: unknown, lost: DialectLoss[]): OpenAiPart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];

  const parts: OpenAiPart[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block) parts.push({ type: 'text', text: block });
      continue;
    }
    if (!isRecord(block)) continue;
    if (block.cache_control !== undefined) lose(lost, 'cache_control');

    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image' && isRecord(block.source)) {
      const url = imageUrl(block.source);
      if (url) parts.push({ type: 'image_url', image_url: { url } });
      continue;
    }
    if (block.type === 'document') {
      lose(lost, 'content[].document');
      continue;
    }
    if (block.type === 'tool_use' || block.type === 'tool_result') {
      lose(lost, 'content[].tool_use / tool_result');
      continue;
    }
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      lose(lost, 'thinking');
      continue;
    }
  }
  return parts;
}

/** Картинка Anthropic приезжает base64 либо ссылкой; наружу — data-адрес. */
function imageUrl(source: Record<string, unknown>): string {
  if (source.type === 'url' && typeof source.url === 'string') return source.url;
  if (typeof source.data === 'string') {
    const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
    return `data:${media};base64,${source.data}`;
  }
  return '';
}

/**
 * Части → содержимое реплики. Один текст остаётся строкой: массив из одной
 * текстовой части понимают не все совместимые шлюзы, а строку — все.
 */
function partsToContent(parts: OpenAiPart[]): string | OpenAiPart[] | undefined {
  if (parts.length === 0) return undefined;
  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n\n');
  }
  return parts;
}

/**
 * Запрос Anthropic → запрос контура.
 *
 * Всё, что таблица помечает `dropped`, сюда не попадает НИКОГДА: лишний ключ
 * контур молча выбросит своей схемой (`extra='ignore'`), и разница между
 * «мы не послали» и «оно исчезло по дороге» стала бы невидимой.
 */
export function anthropicRequestToOpenAi(input: unknown): TranslatedRequest {
  const lost: DialectLoss[] = [];
  if (!isRecord(input)) return { body: {}, lost };

  const body: Record<string, unknown> = {};
  if (typeof input.model === 'string') body.model = input.model;

  const messages: Record<string, unknown>[] = [];

  if (input.system !== undefined) {
    if (Array.isArray(input.system)) lose(lost, 'system[] (массив блоков)');
    const parts = blocksToParts(input.system, lost);
    const content = partsToContent(parts);
    if (content !== undefined) messages.push({ role: 'system', content });
  }

  if (Array.isArray(input.messages)) {
    for (const message of input.messages) {
      if (!isRecord(message)) continue;
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const content = partsToContent(blocksToParts(message.content, lost));
      // Реплика, от которой после перевода ничего не осталось, не отправляется:
      // контур отвергает пустое содержимое у всех ролей, кроме assistant.
      if (content === undefined) continue;
      messages.push({ role, content });
    }
  }
  body.messages = messages;

  if (typeof input.max_tokens === 'number') body.max_tokens = input.max_tokens;
  if (typeof input.temperature === 'number') body.temperature = input.temperature;
  if (typeof input.top_p === 'number') body.top_p = input.top_p;
  if (Array.isArray(input.stop_sequences)) body.stop = input.stop_sequences;
  if (typeof input.stream === 'boolean') body.stream = input.stream;
  if (isRecord(input.metadata) && typeof input.metadata.user_id === 'string') {
    body.user = input.metadata.user_id;
    lose(lost, 'metadata.user_id');
  }

  if (input.top_k !== undefined) lose(lost, 'top_k');
  if (input.tools !== undefined) lose(lost, 'tools');
  if (input.tool_choice !== undefined) lose(lost, 'tool_choice');
  if (input.thinking !== undefined) lose(lost, 'thinking');

  return { body, lost };
}

/** Причина остановки в диалекте Anthropic. */
export function stopReasonOf(finishReason: unknown): string {
  return typeof finishReason === 'string' ? (STOP_REASON[finishReason] ?? 'end_turn') : 'end_turn';
}

/**
 * Цельный ответ контура → цельный ответ Anthropic. Идентификатор берётся
 * контуровский с приставкой: клиенты по нему ничего не ищут, а в журнале двух
 * сторон один и тот же вызов должно быть видно как один.
 */
export function openAiResponseToAnthropic(payload: unknown, model: string): unknown {
  const source = isRecord(payload) ? payload : {};
  const choice = Array.isArray(source.choices) ? source.choices[0] : undefined;
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {};
  const usage = isRecord(source.usage) ? source.usage : {};
  const text = typeof message.content === 'string' ? message.content : '';

  return {
    id: `msg_${typeof source.id === 'string' ? source.id : Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model: typeof source.model === 'string' ? source.model : model,
    content: [{ type: 'text', text }],
    stop_reason: stopReasonOf(isRecord(choice) ? choice.finish_reason : undefined),
    stop_sequence: null,
    usage: {
      input_tokens: numberOf(usage.prompt_tokens),
      output_tokens: numberOf(usage.completion_tokens),
    },
  };
}

/**
 * Список моделей контура → форма Anthropic. Клиент, спросивший на маршруте
 * `/v1/messages`, разбирает ответ своей схемой, и список в чужой форме он
 * читает как «моделей нет» — то есть как пустой выпадающий список вместо
 * настроенного контура.
 */
export function openAiModelsToAnthropic(payload: unknown): unknown {
  const source = isRecord(payload) ? payload : {};
  const list = Array.isArray(source.data) ? source.data : [];

  return {
    data: list.filter(isRecord).map((item) => {
      const id = typeof item.id === 'string' ? item.id : '';
      return {
        type: 'model',
        id,
        // Своего человеческого имени у контура нет — показываем
        // идентификатор, а не выдумываем название.
        display_name: id,
        ...(typeof item.created === 'number'
          ? { created_at: new Date(item.created * 1_000).toISOString() }
          : {}),
      };
    }),
    has_more: false,
  };
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Отказ в форме диалекта клиента.
 *
 * Форма важнее текста: CLI разбирает ошибку по своей схеме, и понятная причина
 * доходит до человека, а не превращается в «unexpected response». Текст при
 * этом остаётся русским — контур присылает его по-русски и уже без секретов
 * (справочник §8), пересказывать его мост не берётся.
 */
export function errorBody(dialect: Dialect, message: string, code: string): unknown {
  return dialect === 'anthropic'
    ? { type: 'error', error: { type: anthropicErrorType(code), message } }
    : { error: { message, type: 'invalid_request_error', code } };
}

function anthropicErrorType(code: string): string {
  if (code === 'authentication_error') return 'authentication_error';
  if (code === 'permission_error') return 'permission_error';
  if (code === 'not_found_error') return 'not_found_error';
  if (code === 'rate_limit_error') return 'rate_limit_error';
  if (code === 'request_too_large') return 'request_too_large';
  if (code === 'api_error' || code === 'overloaded_error') return code;
  return 'invalid_request_error';
}
