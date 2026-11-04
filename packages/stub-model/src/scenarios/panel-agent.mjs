/**
 * Сценарий «агент панели через ядро» над `@agentdeck/stub-model` (P120): модель, с которой
 * говорит НАСТОЯЩИЙ CLI сессии ядра «ask» (Claude — Anthropic messages, Qwen Code — OpenAI chat),
 * когда маршрут профиля «Ассистент панели» — свой адрес, указывающий сюда.
 *
 * Ход описывает программа проверки — асинхронная функция над `tool(имя, аргументы)`, как писал
 * бы её фальшивый CLI. Модель без памяти: каждый запрос несёт всю историю, поэтому программа
 * переигрывается с начала, а вызовы, на которые в истории уже есть результат, получают его.
 * Первый вызов без результата — ответ этого запроса (вызов инструмента моста), конец программы —
 * ответ текстом (или шаг целиком: ошибка, пустой ответ).
 *
 * Инструменты моста у Claude отложены за `ToolSearch`: вызов инструмента, которого CLI ещё не
 * предложил, сначала просит его загрузить (`select:<полное имя>`); в переигровке такие вызовы
 * пропускаются. Своего кода SSE здесь нет — поток пишет диалект пакета.
 */
import { startStubModel } from '../server.mjs';

/** Метка просьбы платформы в первой реплике (`agentdeck:platform`, ядро её ставит). */
export const PANEL_MARK = '<!-- agentdeck:platform -->';
/** Сервер моста в конфиге MCP сессии ядра (`PANEL_BRIDGE_SERVER` контрактов). */
export const BRIDGE_SERVER = 'panel-bridge';
/** Сколько раз подряд просить загрузку инструмента, прежде чем сдаться текстом. */
const MAX_SEARCHES = 12;

/** Имя действия панели по имени инструмента CLI (`mcp__panel-bridge__x`, `panel-bridge__x`). */
export function actionOf(name) {
  const at = String(name).lastIndexOf('__');
  if (at < 0) return undefined;
  return String(name).includes(BRIDGE_SERVER) ? String(name).slice(at + 2) : undefined;
}

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (Array.isArray(content) ? content : [])
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join('\n');

const parseArgs = (raw) => {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

/**
 * Разбор тела запроса: просьба платформы, вызовы моста с их результатами по порядку, число
 * загрузок `ToolSearch`. Тело чужой формы или без метки — `prompt: undefined` (служебный запрос
 * CLI, не ход агента).
 */
export function parsePanelAgentRequest(body, offered = []) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const uses = [];
  const results = new Map();
  let prompt;
  for (const message of messages) {
    const parts = Array.isArray(message.content)
      ? message.content
      : [{ type: 'text', text: textOf(message.content) }];
    for (const part of parts) {
      if (message.role === 'user' && part?.type === 'text' && prompt === undefined) {
        const at = String(part.text ?? '').indexOf(PANEL_MARK);
        if (at >= 0) prompt = part.text.slice(at + PANEL_MARK.length).trim();
      }
      if (message.role === 'assistant' && part?.type === 'tool_use')
        uses.push({ id: part.id, name: part.name, args: part.input ?? {} });
      if (message.role === 'user' && part?.type === 'tool_result')
        results.set(part.tool_use_id, {
          text: textOf(part.content),
          isError: part.is_error === true,
        });
    }
    // OpenAI chat: вызовы — `tool_calls` ассистента, результаты — реплики `tool`.
    for (const call of message.role === 'assistant' ? (message.tool_calls ?? []) : [])
      uses.push({
        id: call.id,
        name: call.function?.name ?? '',
        args: parseArgs(call.function?.arguments),
      });
    if (message.role === 'tool')
      results.set(message.tool_call_id, { text: textOf(message.content), isError: false });
  }
  const calls = uses
    .filter((use) => actionOf(use.name))
    .map((use) => ({
      name: actionOf(use.name),
      args: use.args,
      ...(results.get(use.id) ?? { text: '', isError: true }),
    }));
  const current =
    prompt === undefined
      ? undefined
      : (/Human \(current request\): ([\s\S]*)$/.exec(prompt)?.[1] ?? prompt).trim();
  return {
    prompt,
    current,
    calls,
    searches: uses.filter((use) => use.name === 'ToolSearch').length,
    offered,
  };
}

class NextCall {
  constructor(call) {
    this.call = call;
  }
}

/**
 * Шаг ответа по программе: переиграть её над историей запроса. Расхождение переигровки с
 * историей (программа зовёт другое действие) — ошибка сценария: недетерминированная программа
 * дала бы модели другой ход, чем видел CLI.
 */
export async function decidePanelAgentStep(program, parsed) {
  if (parsed.current === undefined) return { text: 'ok' };
  let index = 0;
  const tool = async (name, args = {}, { say } = {}) => {
    const seen = parsed.calls[index];
    index += 1;
    if (!seen) throw new NextCall({ name, args, say });
    if (seen.name !== name)
      throw new Error(`panel-agent replay: call ${index} is ${seen.name}, program asked ${name}`);
    return { text: seen.text, isError: seen.isError };
  };
  try {
    const reply = await program({ current: parsed.current, prompt: parsed.prompt, tool });
    return typeof reply === 'string' ? { text: reply } : reply;
  } catch (error) {
    if (!(error instanceof NextCall)) throw error;
    const full = parsed.offered.find((name) => actionOf(name) === error.call.name);
    // Реплика перед вызовом едет тем же ответом, что и вызов; загрузке через ToolSearch её не дать —
    // иначе она прозвучала бы дважды.
    const say =
      typeof error.call.say === 'string' && error.call.say ? { text: error.call.say } : {};
    if (full) return { ...say, tool: { name: full, args: error.call.args } };
    const wanted = `mcp__${BRIDGE_SERVER}__${error.call.name}`;
    if (!parsed.offered.includes('ToolSearch') || parsed.searches >= MAX_SEARCHES)
      return { text: `stub: ${wanted} is not offered (${parsed.offered.join(', ')})` };
    return { tool: { name: 'ToolSearch', args: { query: `select:${wanted}`, max_results: 1 } } };
  }
}

/** Заглушка по программе; `turns` — разбор каждого запроса хода агента (для проверки). */
export async function startPanelAgentModel(program, options = {}) {
  const turns = [];
  const stub = await startStubModel({
    ...options,
    script: async (ctx) => {
      const offered = ctx.info.tools.map((item) => item.name);
      const parsed = parsePanelAgentRequest(ctx.request.body, offered);
      if (parsed.current !== undefined) turns.push(parsed);
      return decidePanelAgentStep(program, parsed);
    },
  });
  return Object.assign(stub, { turns });
}
