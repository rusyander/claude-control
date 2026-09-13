import {
  CALL_CLOSE,
  CALL_OPEN,
  readTools,
  RESULT_CLOSE,
  resultOpen,
  systemAddendum,
  type ShimTool,
} from './protocol.ts';

/**
 * Путь НАВЕРХ: инструменты клиента и следы прошлых вызовов — текстом.
 *
 * Без этого история разговора теряет половину смысла: мост и так не переносит
 * `tool_use`/`tool_result` (строка таблицы диалекта), и агент, у которого из
 * прошлого хода исчез и вызов, и его результат, начинает заново — в лучшем
 * случае. В худшем он видит собственную реплику «сейчас запишу файл», не видит
 * ни записи, ни ответа, и записывает второй раз.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Вызов инструмента → текст протокола. */
export function encodeToolUse(name: string, args: unknown): string {
  const payload = JSON.stringify({ name, arguments: args ?? {} });
  return `${CALL_OPEN}${payload}${CALL_CLOSE}`;
}

/**
 * Текст результата. Картинка внутри результата инструмента наверх не едет:
 * текстовым протоколом её не передать — и об этом говорится вслух, потерей.
 */
export function resultText(content: unknown): { text: string; dropped: boolean } {
  if (typeof content === 'string') return { text: content, dropped: false };
  if (!Array.isArray(content)) return { text: '', dropped: false };

  let text = '';
  let dropped = false;
  for (const part of content) {
    if (typeof part === 'string') {
      text += part;
      continue;
    }
    if (isRecord(part) && typeof part.text === 'string') {
      text += part.text;
      continue;
    }
    dropped = true;
  }
  return { text, dropped };
}

/** Результат вызова → текст протокола. Имя берётся по идентификатору вызова. */
export function encodeToolResult(
  block: Record<string, unknown>,
  names: ReadonlyMap<string, string>,
): { text: string; dropped: boolean } {
  const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
  const name = names.get(id) ?? (typeof block.name === 'string' ? block.name : id || 'инструмент');
  const body = resultText(block.content);
  const failed = block.is_error === true ? 'ошибка: ' : '';
  return {
    text: `${resultOpen(name)}\n${failed}${body.text}\n${RESULT_CLOSE}`,
    dropped: body.dropped,
  };
}

/**
 * Имена инструментов по идентификаторам вызовов — из самой истории.
 *
 * Результат в диалекте Anthropic ссылается на вызов идентификатором и имени не
 * носит, а модели нужно имя: `<tool_result name="toolu_01AB…">` она читает как
 * результат неизвестно чего.
 */
export function toolNamesById(messages: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (!Array.isArray(messages)) return names;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    // Упаковка OpenAI кладёт вызовы РЯДОМ с содержимым, а содержимое при этом
    // сплошь и рядом пустая строка. Читать имена только из блоков значило бы
    // терять их у любой истории в этом диалекте.
    if (Array.isArray(message.tool_calls)) collectOpenAiNames(message.tool_calls, names);
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        names.set(block.id, block.name);
      }
      // Диалект OpenAI носит те же следы в другой упаковке — история чата может
      // прийти и в ней.
      if (Array.isArray(block.tool_calls)) collectOpenAiNames(block.tool_calls, names);
    }
  }
  return names;
}

/**
 * В истории запроса уже есть вызов инструмента или его результат.
 *
 * Один вопрос, два диалекта: у Anthropic это блоки `tool_use`/`tool_result`, у
 * OpenAI — роль `tool` и поле `tool_calls`. Смотрим по телу КЛИЕНТА, до
 * перевода: после него обе формы уже свёрнуты в текст протокола, и отличить
 * настоящий след хода от слова «tool_result» в тексте будет нечем.
 */
export function historyHasToolUse(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.role === 'tool') return true;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_use' || block.type === 'tool_result') return true;
      if (Array.isArray(block.tool_calls) && block.tool_calls.length > 0) return true;
    }
  }
  return false;
}

function collectOpenAiNames(calls: unknown[], names: Map<string, string>): void {
  for (const call of calls) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call.function) ? call.function : call;
    if (typeof call.id === 'string' && typeof fn.name === 'string') names.set(call.id, fn.name);
  }
}

/** Аргументы вызова OpenAI приезжают строкой; в протокол они идут объектом. */
function openAiArguments(value: unknown): unknown {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // Не разобралось — отдаём как есть: догадываться о смысле аргументов
    // прошлого хода прослойке нечем, а выбросить их значит стереть историю.
    return value;
  }
}

export interface ShimmedRequest {
  body: Record<string, unknown>;
  /** Инструменты, объявленные клиентом: их именами проверяется ответ. */
  tools: ShimTool[];
  /** Внутрь результата инструмента попадало не только текстовое содержимое. */
  droppedResultParts: boolean;
}

/**
 * Запрос в диалекте OpenAI → запрос с прослойкой.
 *
 * Тело клиента здесь уже в нужном диалекте, и переводить нечего — но
 * инструменты всё равно надо снять с поля `tools` (контур его не принимает) и
 * положить текстом, а роль `tool`, которой у контура нет, свернуть в реплику
 * пользователя.
 */
export function shimOpenAiRequest(
  body: Record<string, unknown>,
  protocolText: string,
  requestFields: Readonly<Record<string, unknown>> = {},
): ShimmedRequest {
  const tools = readTools(body.tools);
  const names = toolNamesById(body.messages);
  const addendum = systemAddendum(protocolText, tools);

  const out: Record<string, unknown> = { ...body };
  delete out.tools;
  // Без `tools` оба поля строгий шлюз отвергает запросом целиком — выбирать
  // модели больше не из чего, протокол у неё в системной строке.
  delete out.tool_choice;
  delete out.parallel_tool_calls;
  // Инструменты САМОЙ платформы остаются выключенными, пока человек их не
  // включил (Т7): свой набор она подбирает сама, и включённым он перебивал бы
  // протокол, которому мы только что научили модель. Чем они гасятся — знание
  // драйвера, а не прослойки.
  Object.assign(out, requestFields);

  const messages: Record<string, unknown>[] = [];
  let dropped = false;
  let addedToSystem = false;

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(message)) continue;

    if (message.role === 'system' && addendum && !addedToSystem) {
      addedToSystem = true;
      messages.push({ ...message, content: joinText(textOf(message.content), addendum) });
      continue;
    }

    if (message.role === 'tool') {
      const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      const name =
        (typeof message.name === 'string' ? message.name : '') ||
        names.get(id) ||
        id ||
        'инструмент';
      const result = resultText(message.content);
      dropped = dropped || result.dropped;
      messages.push({
        role: 'user',
        content: `${resultOpen(name)}\n${result.text}\n${RESULT_CLOSE}`,
      });
      continue;
    }

    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const calls = message.tool_calls
        .filter(isRecord)
        .map((call) => {
          const fn = isRecord(call.function) ? call.function : call;
          const name = typeof fn.name === 'string' ? fn.name : '';
          return name ? encodeToolUse(name, openAiArguments(fn.arguments)) : '';
        })
        .filter(Boolean)
        .join('\n');
      const next: Record<string, unknown> = {
        ...message,
        content: joinText(textOf(message.content), calls),
      };
      delete next.tool_calls;
      messages.push(next);
      continue;
    }

    messages.push(message);
  }

  if (addendum && !addedToSystem) messages.unshift({ role: 'system', content: addendum });
  out.messages = messages;

  return { body: out, tools, droppedResultParts: dropped };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function joinText(first: string, second: string): string {
  return [first, second].filter(Boolean).join('\n\n');
}
