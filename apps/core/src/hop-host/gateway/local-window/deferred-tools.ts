/**
 * Отложенные инструменты Claude Code на пути к локальной модели (L7).
 *
 * С `ENABLE_TOOL_SEARCH=true` Claude Code не шлёт описания MCP-серверов в каждом
 * запросе: модель видит их имена списком и подгружает описание инструментом
 * `ToolSearch`. Облачный API делает остальное сам — инструмент с `defer_loading`
 * не попадает в промпт, а блок `tool_reference` в ответе `ToolSearch` превращается
 * в описание ровно там, где его запросили. llama-server этого не умеет: инструмент
 * с `defer_loading` он печатает в шапке как обычный, а `tool_reference` не знает.
 * На полном наборе владельца (~36 тыс. токенов описаний gitlab и atlassian) это
 * половина промпта, которую модель перечитывает на каждом первом ходе.
 *
 * Здесь — то же, что делает облако, руками шлюза (бинарь 2.1.286, разбор запросов
 * 15.10):
 * - отложенный инструмент, на который никто не сослался, из `tools` уходит —
 *   в том числе `DeferredToolPlaceholder`, заглушка, которую CLI держит в списке;
 * - `tool_reference` становится текстом с описанием в формате, обещанном
 *   описанием `ToolSearch`: `<functions><function>{…}</function></functions>`;
 * - сославшийся инструмент остаётся в `tools` с настоящей схемой: по списку
 *   llama-server строит грамматику вызова, и без него модель вызвать инструмент
 *   не может (замер 15.10: вызывала `ToolSearch` повторно), а заглушка без схемы
 *   даёт вызов с пустыми аргументами.
 *
 * Начало промпта при этом обязано не меняться: подгрузка посреди разговора,
 * сдвинувшая шапку, заставила бы сервер перечитать всё с начала (у гибридной
 * Qwen3.8 частичного возврата нет). Поэтому там, где шаблон чата наш
 * (`inline`), описание подгруженного заменяется пометкой `DEFERRED_TOOL_MARK`,
 * и шаблон такой инструмент в шапке пропускает: модель читает описание в ответе
 * `ToolSearch`, грамматика знает имя и схему. Чужой шаблон пометки не знает —
 * там инструмент печатается в шапке как есть: верно, но один раз дорого.
 */

/** Пометка описания, по которой наш шаблон чата не печатает инструмент в шапке. */
export const DEFERRED_TOOL_MARK = '[[deferred]]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Символы описаний MCP, которые Claude Code шлёт целиком, хотя поиск инструментов включён
 * (`ToolSearch` в списке): разговор начат без поиска, а CLI при продолжении повторяет снимок
 * промпта (`prompt_snapshot` в журнале) вместе с набором инструментов, чтобы не сбить кеш.
 * Замер 15.10, 2.1.286: новый сеанс с поиском — 17 инструментов, тот же сеанс, начатый без
 * поиска и продолженный с ним, — 140, описания MCP целиком. Шлюз их не снимает: CLI считает
 * их объявленными, и `ToolSearch` их не найдёт. Сказать человеку — дело панели. Нет таких — 0.
 */
export function frozenToolChars(body: Record<string, unknown>): number {
  const tools = Array.isArray(body.tools) ? body.tools.filter(isRecord) : [];
  if (!tools.some((tool) => tool.name === 'ToolSearch')) return 0;
  return tools
    .filter(
      (tool) =>
        typeof tool.name === 'string' &&
        tool.name.startsWith('mcp__') &&
        tool.defer_loading !== true,
    )
    .reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
}

/** Имена инструментов, на которые сослался `ToolSearch` где-либо в разговоре. */
function referencedNames(messages: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(messages)) return names;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== 'tool_result' || !Array.isArray(block.content))
        continue;
      for (const part of block.content) {
        if (isRecord(part) && part.type === 'tool_reference' && typeof part.tool_name === 'string')
          names.add(part.tool_name);
      }
    }
  }
  return names;
}

/** Описание инструмента так, как его обещает `ToolSearch`: одна строка `<function>`. */
function functionLine(tool: Record<string, unknown>): string {
  return `<function>${JSON.stringify({
    description: typeof tool.description === 'string' ? tool.description : '',
    name: tool.name,
    parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: 'object' },
  })}</function>`;
}

function expandResult(
  block: Record<string, unknown>,
  deferred: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
  if (block.type !== 'tool_result' || !Array.isArray(block.content)) return block;
  if (!block.content.some((part) => isRecord(part) && part.type === 'tool_reference')) return block;
  const lines: string[] = [];
  const rest: unknown[] = [];
  for (const part of block.content) {
    if (isRecord(part) && part.type === 'tool_reference') {
      const tool = typeof part.tool_name === 'string' ? deferred.get(part.tool_name) : undefined;
      // Ссылка без инструмента в списке — CLI его уже снял (сервер MCP отключился):
      // модели честнее узнать это, чем получить пустой ответ.
      lines.push(
        tool
          ? functionLine(tool)
          : `<!-- ${String(part.tool_name)}: tool is no longer available -->`,
      );
    } else rest.push(part);
  }
  return {
    ...block,
    content: [{ type: 'text', text: `<functions>\n${lines.join('\n')}\n</functions>` }, ...rest],
  };
}

/**
 * Тело запроса Anthropic, в котором отложенные инструменты развёрнуты так, как это
 * сделал бы облачный API. Нет ни отложенных, ни ссылок — тот же объект, без копии.
 */
export function expandDeferredTools(
  body: Record<string, unknown>,
  inline: boolean,
): Record<string, unknown> {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const deferred = new Map<string, Record<string, unknown>>();
  for (const tool of tools) {
    if (isRecord(tool) && tool.defer_loading === true && typeof tool.name === 'string')
      deferred.set(tool.name, tool);
  }
  const referenced = referencedNames(body.messages);
  if (deferred.size === 0 && referenced.size === 0) return body;

  const nextTools: unknown[] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || tool.defer_loading !== true) {
      nextTools.push(tool);
      continue;
    }
    if (typeof tool.name !== 'string' || !referenced.has(tool.name)) continue;
    const { defer_loading: _deferred, ...plain } = tool;
    nextTools.push(inline ? { ...plain, description: DEFERRED_TOOL_MARK } : plain);
  }

  const messages = Array.isArray(body.messages)
    ? body.messages.map((message) =>
        isRecord(message) && Array.isArray(message.content)
          ? {
              ...message,
              content: message.content.map((block) =>
                isRecord(block) ? expandResult(block, deferred) : block,
              ),
            }
          : message,
      )
    : body.messages;

  const next: Record<string, unknown> = { ...body, messages };
  if (nextTools.length > 0) next.tools = nextTools;
  else delete next.tools;
  return next;
}
