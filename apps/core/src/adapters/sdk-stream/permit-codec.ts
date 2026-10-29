import type { PermitCodec } from '../adapter.types.ts';

/**
 * Форма вопроса о праве у CLI формата SDK. Вопрос приходит `{tool_name, input, tool_use_id}` —
 * аргументами инструмента сервера права (`--permission-prompt-tool`) или телом управляющей
 * строки `can_use_tool`; ответ — `{behavior:'allow', updatedInput}` или
 * `{behavior:'deny', message}`, текстом инструмента либо телом `control_response`. Форма у
 * обеих дорог одна, поэтому кодек один на каркас SDK.
 */

/**
 * Прокси отложенных инструментов: модель зовёт `tool_call {name, arguments}`, поток пишет запрос
 * под именем прокси, а вопрос о праве CLI задаёт о ЦЕЛИ — `tool_name` = `input.name` запроса
 * (без регистра: CLI сводит имя к зарегистрированному), `input` = `arguments`, `tool_use_id`
 * тот же (Qwen Code 0.24.3, `resolveToolCallBridgeRequest`). Ворот права (`policy/permit/pending`)
 * сопоставляет такой вопрос только с этой целью.
 */
export const SDK_TOOL_PROXIES: readonly string[] = ['tool_call'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export const SDK_PERMIT_CODEC: PermitCodec = {
  read(raw) {
    if (!isRecord(raw)) return undefined;
    const { tool_name: tool, input, tool_use_id: toolUseId } = raw;
    // Без id вызова нельзя доказать, что вопрос отвечает на запрос модели (P41): не разбираем.
    if (typeof tool !== 'string' || !tool || typeof toolUseId !== 'string' || !toolUseId) {
      return undefined;
    }
    if (input !== undefined && !isRecord(input)) return undefined;
    return { toolUseId, call: { tool, input: input ?? {} } };
  },
  render(answer) {
    return answer.allow
      ? { behavior: 'allow', updatedInput: answer.input }
      : { behavior: 'deny', message: answer.message };
  },
};
