import { codexArguments, usageOf } from '../../../analytics/scanner/foreign.ts';
import type { WatchEvent } from '../watch/watch.types.ts';
import type { ForeignRowReader, ForeignTranscriptKind } from './foreign.types.ts';

/**
 * Строка переписки Codex или Qwen Code → события сторожа групп. Потока событий
 * у чужого CLI сторожу нет (`ProviderChatService` шлёт только старт и конец
 * хода), и всё, что видят правила, берётся из файла сессии CLI.
 *
 * Форма записей сверена с файлами НАСТОЯЩИХ CLI (codex-cli 0.155.1, qwen 0.24.3)
 * на подменной модели во временном доме — `__fixtures__/`. Расход вызова —
 * тем же счётом, что у аналитики (`usageOf`): вход у обоих CLI включает кэш.
 *
 * Имена инструментов приводятся к именам Claude (`Bash`/`Read`/`Edit`), иначе
 * правила о проверках, перечитываниях и долгих вызовах (R4, R5, R14–R16) чужого
 * CLI не узнали бы.
 */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** Сколько id ответов помнить для отсева повторов. */
const SEEN_CAP = 500;

function timeOf(record: Json): number {
  return typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
}

/** Команда оболочки строкой: Codex `shell` присылает массив argv. */
function commandText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === 'string');
    return parts.length > 0 ? parts.join(' ') : undefined;
  }
  return str(value);
}

/** Первый файл патча `apply_patch`: правка без пути ничего не скажет правилам. */
function patchTarget(patch: unknown): string | undefined {
  if (typeof patch !== 'string') return undefined;
  const match = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(patch);
  return match?.[1]?.trim() || undefined;
}

const SHELL_TOOLS = new Set(['exec_command', 'shell', 'shell_command', 'local_shell']);

/**
 * Имя и аргументы инструмента CLI → имя и аргументы Claude, которые читают
 * правила сторожа. Незнакомое имя проходит как есть.
 */
export function normalizeToolName(
  kind: ForeignTranscriptKind,
  name: string,
  input: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  if (kind === 'codex') {
    if (SHELL_TOOLS.has(name)) {
      const command = commandText(input.cmd) ?? commandText(input.command);
      const timeout = num(input.timeout_ms) || num(input.timeout);
      return {
        name: 'Bash',
        input: { ...(command ? { command } : {}), ...(timeout ? { timeout } : {}) },
      };
    }
    if (name === 'apply_patch') {
      const target = patchTarget(input.input ?? input.patch);
      return { name: 'Edit', input: target ? { file_path: target } : {} };
    }
    if (name === 'read_file') {
      const path = str(input.file_path) ?? str(input.path);
      return { name: 'Read', input: path ? { file_path: path } : {} };
    }
    return { name, input };
  }
  if (name === 'run_shell_command') {
    const command = str(input.command);
    const timeout = num(input.timeout);
    return {
      name: 'Bash',
      input: {
        ...(command ? { command } : {}),
        ...(timeout ? { timeout } : {}),
        ...(input.is_background === true ? { run_in_background: true } : {}),
      },
    };
  }
  if (name === 'read_file') {
    const path = str(input.absolute_path) ?? str(input.file_path);
    return { name: 'Read', input: path ? { file_path: path } : {} };
  }
  if (name === 'read_many_files') {
    // Один файл — обычное чтение (перечитывание видно R5); несколько — без пути.
    const paths = Array.isArray(input.paths) ? input.paths : [];
    const only = paths.length === 1 ? str(paths[0]) : undefined;
    return { name: 'Read', input: only ? { file_path: only } : {} };
  }
  if (name === 'edit' || name === 'write_file' || name === 'replace') {
    const path = str(input.file_path) ?? str(input.absolute_path);
    return { name: 'Edit', input: path ? { file_path: path } : {} };
  }
  return { name, input };
}

/** Длина ответа инструмента в знаках: строка — как есть, иное — его JSON. */
function resultChars(value: unknown): number {
  if (value === undefined || value === null) return 0;
  return typeof value === 'string' ? value.length : JSON.stringify(value).length;
}

function outputText(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const part of content) {
    const text = obj(part)?.text;
    if (typeof text === 'string') chars += text.length;
  }
  return chars;
}

/**
 * Codex (`rollout-*.jsonl`): ход — `event_msg/task_started` … `task_complete`;
 * вызов модели — `token_usage_record` (один на ответ). `event_msg/token_count`
 * повторяется с теми же итогами и в вызовы не идёт — кроме файла старого codex
 * без записей, где он единственный след (тогда — только при сдвиге итога).
 */
export function codexWatchEvents(): ForeignRowReader {
  const seen = new Set<string>();
  let records = 0;
  let model: string | undefined;
  let lastTotal = '';
  return (row) => {
    const record = obj(row);
    if (!record) return [];
    const t = timeOf(record);
    if (!Number.isFinite(t)) return [];
    const payload = obj(record.payload) ?? {};
    const call = (usage: Json): WatchEvent => {
      const raw = usageOf(
        usage.input_tokens,
        usage.cached_input_tokens,
        usage.output_tokens,
        usage.cache_write_input_tokens,
      );
      return {
        kind: 'call',
        t,
        ...(model ? { model } : {}),
        input: raw.input_tokens ?? 0,
        cacheRead: raw.cache_read_input_tokens ?? 0,
        cacheWrite: raw.cache_creation_input_tokens ?? 0,
        cacheWrite1h: 0,
        output: raw.output_tokens ?? 0,
      };
    };
    switch (record.type) {
      case 'turn_context':
        model = str(payload.model) ?? model;
        return [];
      case 'compacted':
        return [{ kind: 'compact', t }];
      case 'token_usage_record': {
        const id = str(payload.response_id);
        if (id && seen.has(id)) return [];
        if (id) {
          seen.add(id);
          if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value as string);
        }
        records += 1;
        return [call(obj(payload.usage) ?? {})];
      }
      case 'event_msg':
        if (payload.type === 'task_started') return [{ kind: 'start', t }];
        if (payload.type === 'task_complete') return [{ kind: 'end', t }];
        if (payload.type === 'token_count' && records === 0) {
          const info = obj(payload.info);
          const last = obj(info?.last_token_usage);
          const total = JSON.stringify(info?.total_token_usage ?? null);
          if (!last || total === lastTotal) return [];
          lastTotal = total;
          return [call(last)];
        }
        return [];
      case 'response_item':
        return codexItem(payload, t);
      default:
        return [];
    }
  };
}

function codexItem(payload: Json, t: number): WatchEvent[] {
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    const name = str(payload.name);
    if (!name) return [];
    const args =
      payload.type === 'function_call'
        ? codexArguments(payload.arguments)
        : { input: payload.input };
    const tool = normalizeToolName('codex', name, args);
    return [{ kind: 'tool', t, id: str(payload.call_id) ?? '', ...tool }];
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const id = str(payload.call_id);
    if (!id) return [];
    const output = payload.output;
    // Вывод бывает объектом `{ content, success }` — считаем его содержимое.
    const chars = resultChars(obj(output)?.content ?? output);
    return [{ kind: 'toolResult', t, id, chars }];
  }
  if (payload.type === 'reasoning') return [{ kind: 'activity', t }];
  if (payload.type === 'message' && payload.role === 'assistant') {
    return outputText(payload.content) > 0 ? [{ kind: 'activity', t }] : [];
  }
  return [];
}

/**
 * Qwen Code (`projects/<проект>/chats/<сессия>.jsonl`): ход — реплика человека
 * (`type:'user'`); вызов модели — `ui_telemetry` с `qwen-code.api_response`
 * (тем же счётом, что аналитика: `thoughts` — выход); сжатие окна — `system`
 * `chat_compression`. Конец хода сторожу шлёт сам прогон (`finish`): ответ
 * текстом в файле ещё не значит, что ход кончился.
 */
export function qwenWatchEvents(): ForeignRowReader {
  const seen = new Set<string>();
  return (row) => {
    const record = obj(row);
    if (!record) return [];
    const t = timeOf(record);
    if (!Number.isFinite(t)) return [];
    const parts = obj(record.message)?.parts;
    const list = Array.isArray(parts) ? parts.map(obj) : [];
    if (record.type === 'system') {
      if (record.subtype === 'chat_compression') {
        const reason = obj(obj(record.systemPayload)?.info)?.triggerReason;
        return [{ kind: 'compact', t, ...(reason === 'manual' ? { manual: true } : {}) }];
      }
      const event = obj(obj(record.systemPayload)?.uiEvent);
      if (record.subtype !== 'ui_telemetry' || event?.['event.name'] !== 'qwen-code.api_response')
        return [];
      const id = str(event.response_id);
      if (id && seen.has(id)) return [];
      if (id) {
        seen.add(id);
        if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value as string);
      }
      const raw = usageOf(
        event.input_token_count,
        event.cached_content_token_count,
        num(event.output_token_count) + num(event.thoughts_token_count),
      );
      const model = str(event.model);
      return [
        {
          kind: 'call',
          t,
          ...(model ? { model } : {}),
          input: raw.input_tokens ?? 0,
          cacheRead: raw.cache_read_input_tokens ?? 0,
          cacheWrite: 0,
          cacheWrite1h: 0,
          output: raw.output_tokens ?? 0,
        },
      ];
    }
    if (record.type === 'user') {
      // Служебная реплика CLI (не человек и не панель) ход не начинает.
      if (record.provenance !== undefined && record.provenance !== 'real_user') return [];
      return list.some((part) => str(part?.text)) ? [{ kind: 'start', t }] : [];
    }
    if (record.type === 'tool_result') {
      return list.flatMap((part): WatchEvent[] => {
        const response = obj(part?.functionResponse);
        const id = str(response?.id);
        if (!id) return [];
        const body = obj(response?.response);
        return [{ kind: 'toolResult', t, id, chars: resultChars(body?.output ?? body?.error) }];
      });
    }
    if (record.type !== 'assistant') return [];
    const out: WatchEvent[] = [];
    for (const part of list) {
      const call = obj(part?.functionCall);
      const name = str(call?.name);
      if (name) {
        const tool = normalizeToolName('qwen', name, obj(call?.args) ?? {});
        out.push({ kind: 'tool', t, id: str(call?.id) ?? '', ...tool });
      } else if (str(part?.text)) {
        // Текст или размышление: сессия жива, хотя вызова нет (R1).
        if (!out.some((event) => event.kind === 'activity')) out.push({ kind: 'activity', t });
      }
    }
    return out;
  };
}

/** Читатель по роду переписки. */
export function foreignWatchEvents(kind: ForeignTranscriptKind): ForeignRowReader {
  return kind === 'codex' ? codexWatchEvents() : qwenWatchEvents();
}
