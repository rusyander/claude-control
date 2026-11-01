import type { DialectId, Step, StepContext, StepFn } from '@agentdeck/stub-model';
import type { Move, StubTask, TimedMove } from './stub-tasks.types.ts';

/**
 * Ходы задачи → сценарий общей заглушки (`packages/stub-model`, P120): своего кода протоколов
 * здесь нет, только функция шага над уже разобранным запросом.
 *
 * - Номер хода = число ответов модели в истории разговора (каждый наш ответ — ровно одно
 *   сообщение ассистента: вызов инструмента или текст). Повтор того же запроса (CLI повторил
 *   после обрыва, ядро перезапустилось) получает тот же ход — сценарий без памяти.
 * - Имя инструмента берётся из объявленных САМИМ CLI: встроенные — по словарю имён, инструменты
 *   ядра — точное имя или хвост `__<имя>` (`mcp__agentdeck__step_done`). Имена аргументов — из
 *   схемы инструмента в запросе (`file_path` / `absolute_path` / `path`).
 * - Боковые запросы CLI (заголовок разговора, извлечение памяти) инструмента оболочки не
 *   объявляют: им короткий текст, ход не тратится.
 */

/** Метки брифа: шаг и копию модель-заглушка читает из системного промпта, как читала бы модель. */
export const BRIEF_MARKERS = { step: 'agentdeck-step:', copy: 'agentdeck-copy:' } as const;

export function briefFor(input: { stepId: string; copyRoot: string; request: string }): string {
  return [
    'You are running one AgentDeck step.',
    `${BRIEF_MARKERS.step} ${input.stepId}`,
    `${BRIEF_MARKERS.copy} ${input.copyRoot}`,
    '',
    input.request,
  ].join('\n');
}

/** Встроенные инструменты по классу хода: имена, под которыми их объявляют CLI фазы 2. */
export const TOOL_VOCABULARY = {
  write: ['Write', 'write_file'],
  read: ['Read', 'read_file'],
  shell: ['Bash', 'run_shell_command'],
  /**
   * Фоновая команда, которая будит CLI своим концом (P48). Qwen в режиме stream-json будит модель
   * только уведомлением монитора: фоновая `run_shell_command` (`is_background`) хода не начинает.
   * Нет такого инструмента — фоновая команда оболочки (Claude `Bash run_in_background` будит сам).
   */
  wake: ['monitor'],
} as const;

export type BuiltinClass = keyof typeof TOOL_VOCABULARY;

/**
 * Отложенные инструменты: CLI объявляет инструменты MCP только именем в промпте.
 * - Загрузчик (Claude `ToolSearch`, `select:<имя>`): после него инструмент объявлен прямо. Вызов
 *   загрузчика — не ход задачи: номер хода его не считает, иначе каждый следующий ход сдвинулся бы.
 * - Посредник (Qwen `tool_call {name, arguments}`): зовёт отложенный инструмент сам — это и есть ход;
 *   Qwen `tool_search` списка не меняет (только показывает схему), заглушке он не нужен.
 */
export const TOOL_LOADERS: readonly string[] = ['ToolSearch'];
export const TOOL_PROXIES: readonly string[] = ['tool_call'];

/** Ответ на боковой запрос CLI (без инструмента оболочки). */
export const SIDE_REPLY = 'stub side reply';

const PATH_KEYS = ['file_path', 'absolute_path', 'path'] as const;
const BACKGROUND_KEYS = ['run_in_background', 'is_background'] as const;

type DeclaredTool = StepContext['info']['tools'][number];

function propsOf(tool: DeclaredTool): Record<string, unknown> {
  const schema = tool.schema as { properties?: Record<string, unknown> } | undefined;
  return schema?.properties ?? {};
}

function requiredOf(tool: DeclaredTool): string[] {
  const schema = tool.schema as { required?: unknown } | undefined;
  return Array.isArray(schema?.required) ? (schema.required as string[]) : [];
}

export function findBuiltin(tools: readonly DeclaredTool[], cls: BuiltinClass) {
  const names: readonly string[] = TOOL_VOCABULARY[cls];
  return tools.find((t) => names.includes(t.name));
}

export function findModelTool(tools: readonly DeclaredTool[], name: string) {
  return tools.find((t) => t.name === name || t.name.endsWith(`__${name}`));
}

/** Сколько ответов модели уже в истории — номер следующего хода (протоколы фазы 2 и responses). */
export function assistantTurns(dialect: DialectId, body: Record<string, unknown>): number {
  const loader = (name: unknown): boolean =>
    typeof name === 'string' && TOOL_LOADERS.includes(name);
  if (dialect === 'openai-responses') {
    const input = Array.isArray(body.input) ? (body.input as Record<string, unknown>[]) : [];
    return input.filter(
      (item) =>
        ((item.type === 'function_call' || item.type === 'custom_tool_call') &&
          !loader(item.name)) ||
        (item.type === 'message' && item.role === 'assistant') ||
        (item.type === undefined && item.role === 'assistant'),
    ).length;
  }
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  return messages.filter((m) => m.role === 'assistant' && !loaderOnly(m, loader)).length;
}

/** Ответ модели, который только загрузил отложенные инструменты (без текста и других вызовов). */
function loaderOnly(message: Record<string, unknown>, loader: (name: unknown) => boolean): boolean {
  const calls: unknown[] = [];
  let text = typeof message.content === 'string' ? message.content.trim() : '';
  if (Array.isArray(message.content)) {
    for (const block of message.content as Record<string, unknown>[]) {
      if (block.type === 'tool_use') calls.push(block.name);
      else if (block.type === 'text' && typeof block.text === 'string') text += block.text.trim();
    }
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls as { function?: { name?: unknown } }[]) {
      calls.push(call.function?.name);
    }
  }
  return calls.length > 0 && text === '' && calls.every(loader);
}

/** Все строки тела запроса — метки брифа ищутся в разобранном JSON, а не в сыром (экранирование). */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) strings(v, out);
  return out;
}

/** Роли системного промпта в истории сообщений (openai-chat, openai-responses). */
const SYSTEM_ROLES = new Set(['system', 'developer']);

/**
 * Строки СИСТЕМНОГО промпта запроса: `system` (anthropic-messages), `instructions`
 * (openai-responses), сообщения с ролью system/developer (openai-chat `messages`,
 * openai-responses `input`). Вывод инструментов и реплики пользователя сюда не входят: метка в
 * прочитанном файле или выводе команды иначе побеждала бриф (F-84).
 */
function systemStrings(body: Record<string, unknown>): string[] {
  const out = [...strings(body.system), ...strings(body.instructions)];
  for (const list of [body.messages, body.input]) {
    if (!Array.isArray(list)) continue;
    for (const item of list as Record<string, unknown>[]) {
      if (item && typeof item === 'object' && SYSTEM_ROLES.has(item.role as string)) {
        strings(item.content, out);
      }
    }
  }
  return out;
}

export function briefValues(body: Record<string, unknown>): { stepId?: string; copy?: string } {
  const found: { stepId?: string; copy?: string } = {};
  for (const text of systemStrings(body)) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!found.stepId && trimmed.startsWith(BRIEF_MARKERS.step)) {
        found.stepId = trimmed.slice(BRIEF_MARKERS.step.length).trim();
      }
      if (!found.copy && trimmed.startsWith(BRIEF_MARKERS.copy)) {
        found.copy = trimmed.slice(BRIEF_MARKERS.copy.length).trim();
      }
    }
  }
  return found;
}

export function fill(template: string, values: { stepId?: string; copy?: string }): string {
  return template
    .replaceAll('${stepId}', values.stepId ?? '${stepId}')
    .replaceAll('${copy}', values.copy ?? '${copy}');
}

export function fillDeep(value: unknown, values: { stepId?: string; copy?: string }): unknown {
  if (typeof value === 'string') return fill(value, values);
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, values));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, values)]));
  }
  return value;
}

/** Оболочка, которая исполнит строку: POSIX (`bash`, `sh`) или cmd.exe. */
export type ShellDialect = 'posix' | 'cmd';

/**
 * argv → строка команды, которую оболочка `shell` разберёт ровно в этот argv (F-84). POSIX —
 * одинарные кавычки: `$(…)`, обратные кавычки, `$VAR` и `\` внутри не раскрываются (двойные
 * кавычки оставляли их живыми: `echo "$(git push …)"` исполнял push при argv «литерал echo»).
 * cmd.exe — двойные кавычки; слово, которое cmd раскрыл бы или разорвал даже в кавычках
 * (`%VAR%`, `!`, `"`, перевод строки, `\` перед закрывающей кавычкой), — отказ, а не тихая порча.
 */
export function commandLine(argv: readonly string[], shell: ShellDialect = 'posix'): string {
  return argv.map((a) => (shell === 'cmd' ? cmdWord(a) : posixWord(a))).join(' ');
}

const PLAIN_WORD = /^[\w@+=:,./-]+$/;

function posixWord(a: string): string {
  if (PLAIN_WORD.test(a)) return a;
  return `'${a.replace(/'/g, `'\\''`)}'`;
}

function cmdWord(a: string): string {
  if (/[%!"\r\n]/.test(a) || a.endsWith('\\')) {
    throw new Error(`cmd.exe cannot carry this word literally: ${JSON.stringify(a)}`);
  }
  // `\` в слове cmd не трогает: CRT снимает его только перед кавычкой.
  return /^[\w@+=:,./\\-]+$/.test(a) ? a : `"${a}"`;
}

/**
 * Какой оболочкой CLI исполнит команду своего инструмента: `Bash` Claude — bash на любой ОС
 * (на Windows — Git Bash); инструменты Qwen зовут оболочку системы — cmd.exe на Windows.
 */
function shellOf(toolName: string): ShellDialect {
  const system = toolName === 'run_shell_command' || toolName === 'monitor';
  return system && process.platform === 'win32' ? 'cmd' : 'posix';
}

function missing(what: string): Step {
  return { text: `STUB TASK SCRIPT: ${what} is not declared by this CLI` };
}

function pathArgs(tool: DeclaredTool, path: string): Record<string, unknown> {
  const props = propsOf(tool);
  const key = PATH_KEYS.find((k) => k in props) ?? PATH_KEYS[0];
  return { [key]: path };
}

function shellArgs(tool: DeclaredTool, command: string, background: boolean) {
  const props = propsOf(tool);
  const args: Record<string, unknown> = { command };
  if ('description' in props) args.description = 'stub task move';
  const bgKey = BACKGROUND_KEYS.find((k) => k in props);
  if (bgKey && (background || requiredOf(tool).includes(bgKey))) args[bgKey] = background;
  return args;
}

/** Полное имя отложенного инструмента ядра, как его назвал CLI в промпте (`mcp__agentdeck__<имя>`). */
export function deferredName(body: Record<string, unknown>, name: string): string | undefined {
  const token = new RegExp(`([A-Za-z0-9_.-]*__${name})(?![A-Za-z0-9_])`);
  for (const text of strings(body)) {
    const found = token.exec(text);
    if (found) return found[1];
  }
  return undefined;
}

/**
 * Инструмента ядра нет среди объявленных, но CLI назвал его отложенным:
 * - CLI с посредником (Qwen `tool_call {name, arguments}`) — сам ход идёт через посредника;
 * - CLI с загрузчиком (Claude `ToolSearch`) — сначала загрузка `select:<имя>` (ход не считается),
 *   в следующем запросе инструмент уже объявлен и зовётся прямо.
 */
function deferredCall(ctx: StepContext, name: string, args: unknown): Step | undefined {
  const full = deferredName(ctx.request.body, name);
  if (!full) return undefined;
  const proxy = ctx.info.tools.find((t) => TOOL_PROXIES.includes(t.name));
  if (proxy) return { tool: { name: proxy.name, args: { name: full, arguments: args } } };
  const loaderTool = ctx.info.tools.find((t) => TOOL_LOADERS.includes(t.name));
  if (!loaderTool) return undefined;
  const query: Record<string, unknown> = { query: `select:${full}` };
  if ('max_results' in propsOf(loaderTool)) query.max_results = 1;
  return { tool: { name: loaderTool.name, args: query } };
}

/**
 * Фоновая команда инструментом пробуждения (`TOOL_VOCABULARY.wake`): объявлен прямо — зовётся
 * прямо; отложен (Qwen называет `monitor` в промпте строкой `"monitor": "…"`) — через посредника.
 * Нет ни того, ни другого — `undefined`, ход идёт фоновой командой оболочки.
 */
function wakeCall(ctx: StepContext, argv: readonly string[]): Step | undefined {
  const direct = findBuiltin(ctx.info.tools, 'wake');
  if (direct) {
    const args: Record<string, unknown> = { command: commandLine(argv, shellOf(direct.name)) };
    if ('description' in propsOf(direct)) args.description = 'stub task move';
    return { tool: { name: direct.name, args } };
  }
  const proxy = ctx.info.tools.find((t) => TOOL_PROXIES.includes(t.name));
  if (!proxy) return undefined;
  const texts = strings(ctx.request.body);
  const names: readonly string[] = TOOL_VOCABULARY.wake;
  const name = names.find((n) => texts.some((t) => t.includes(`"${n}":`)));
  if (!name) return undefined;
  const args = { command: commandLine(argv, shellOf(name)), description: 'stub task move' };
  return { tool: { name: proxy.name, args: { name, arguments: args } } };
}

/** Один ход → шаг заглушки по объявленным инструментам этого запроса. */
export function stepFor(move: Move, ctx: StepContext): Step {
  const tools = ctx.info.tools;
  const values = briefValues(ctx.request.body);
  switch (move.op) {
    case 'text':
      return { text: move.text };
    case 'write': {
      const tool = findBuiltin(tools, 'write');
      if (!tool) return missing('a write tool');
      const args = { ...pathArgs(tool, fill(move.path, values)), content: move.content };
      return { tool: { name: tool.name, args } };
    }
    case 'read': {
      const tool = findBuiltin(tools, 'read');
      if (!tool) return missing('a read tool');
      const args = pathArgs(tool, fill(move.path, values));
      // Окно — только в поля, которые инструмент объявил (Claude `Read`, Qwen `read_file`: offset/limit).
      if (move.range) {
        const props = propsOf(tool);
        if ('offset' in props) args.offset = move.range.offset;
        if ('limit' in props) args.limit = move.range.limit;
      }
      return { tool: { name: tool.name, args } };
    }
    case 'shell': {
      const argv = move.argv.map((a) => fill(a, values));
      const tool = findBuiltin(tools, 'shell');
      const wake = move.background ? wakeCall(ctx, argv) : undefined;
      if (wake) return wake;
      if (!tool) return missing('a shell tool');
      const command = commandLine(argv, shellOf(tool.name));
      return {
        tool: { name: tool.name, args: shellArgs(tool, command, move.background === true) },
      };
    }
    case 'model-tool': {
      const tool = findModelTool(tools, move.tool);
      const args = fillDeep(move.args, values);
      if (!tool) return deferredCall(ctx, move.tool, args) ?? missing(`core tool ${move.tool}`);
      return { tool: { name: tool.name, args } };
    }
  }
}

function timed(step: Step, move: TimedMove): Step {
  const { usage, window } = move;
  return {
    ...step,
    ...(move.holdMs ? { holdMs: move.holdMs } : {}),
    ...(move.stallMs ? { stallMs: move.stallMs } : {}),
    // У протокола заглушки нет поля записи кеша: контекст (вход + кеш) сохраняется суммой.
    ...(usage
      ? {
          usage: {
            input: usage.input + (usage.cacheWrite ?? 0),
            output: usage.output ?? 2,
            cached: usage.cacheRead ?? 0,
          },
        }
      : {}),
    ...(window
      ? {
          window: {
            status: window.status,
            utilization: window.usedPct / 100,
            resetsAt: Math.floor((Date.now() + window.resetInMs) / 1000),
          },
        }
      : {}),
  };
}

/** Ответ заглушки за ходом с меткой `turnEnd`: текст без инструмента — CLI кончает свой ход. */
export const TURN_END_TEXT = 'turn end';

/**
 * Ход задачи по номеру ответа модели: за каждым ходом с `turnEnd` стоит лишний ответ текстом,
 * поэтому номер ответа и номер хода расходятся. `turn-end` — это тот вставленный ответ.
 */
export function moveAt(
  moves: readonly TimedMove[],
  answer: number,
): TimedMove | 'turn-end' | undefined {
  let left = answer;
  for (const move of moves) {
    if (left === 0) return move;
    left -= 1;
    if (move.turnEnd) {
      if (left === 0) return 'turn-end';
      left -= 1;
    }
  }
  return undefined;
}

/** Сценарий задачи для `startStubModel({ script })` / `createStubRoute({ script })`. */
export function scriptFor(task: Pick<StubTask, 'moves'>, closing = 'done'): StepFn {
  return (ctx) => {
    if (!findBuiltin(ctx.info.tools, 'shell')) return { text: SIDE_REPLY };
    const move = moveAt(task.moves, assistantTurns(ctx.dialect, ctx.request.body));
    if (!move) return { text: closing };
    if (move === 'turn-end') return { text: TURN_END_TEXT };
    return timed(stepFor(move, ctx), move);
  };
}
