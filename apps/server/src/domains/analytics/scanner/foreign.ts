import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EntrySource } from './scan-file.ts';
import type { ForeignSource, RawEntry, RawUsage } from './types.ts';

/**
 * Сессии Codex и Qwen Code глазами аналитики (пункт 7 «Цели», 06.10.2026).
 *
 * Формат сверен с файлами, которые написали НАСТОЯЩИЕ CLI (codex 0.160,
 * qwen 0.25.0) во временном доме на подменной модели, а не по документации:
 * оба пишут больше одного следа на ответ, и брать нужно ровно один.
 *
 * Обе стороны считают вход вместе с прочитанным из кэша (форма OpenAI:
 * `input_tokens ⊇ cached`), а транскрипт Claude — без него. Поэтому вход здесь
 * — разность, иначе кэш учитывался бы дважды и в объёме, и в цене.
 */

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Вход «с кэшем внутри» → три поля Claude: вход без кэша, чтение кэша, запись. */
function usageOf(input: unknown, cached: unknown, output: unknown, written?: unknown): RawUsage {
  const read = Math.min(count(cached), count(input));
  return {
    input_tokens: count(input) - read,
    output_tokens: count(output),
    cache_read_input_tokens: read,
    cache_creation_input_tokens: count(written),
  };
}

function parse(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // недописанная строка идущей сессии
  }
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

function answer(
  base: Pick<RawEntry, 'timestamp' | 'sessionId' | 'cwd'>,
  id: string,
  model: string | undefined,
  usage: RawUsage,
): RawEntry {
  return {
    ...base,
    type: 'assistant',
    message: { id, ...(model ? { model } : {}), usage },
  };
}

function toolCall(base: Pick<RawEntry, 'timestamp' | 'sessionId'>, name: string): RawEntry {
  return { ...base, type: 'tool', message: { content: [{ type: 'tool_use', name }] } };
}

/**
 * Codex: `rollout-*.jsonl`. На ответ — `token_usage_record` с `response_id`
 * (0.160) и дубль `event_msg/token_count` с `last_token_usage`. Берётся первый;
 * у файла старого codex без записей — второй. Модель — из `turn_context` хода,
 * проект — `cwd` из `session_meta`.
 */
export const codexEntries: EntrySource = async function* (lines) {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  const models = new Map<string, string>();
  let records = 0;
  const fallback: RawEntry[] = [];
  for await (const line of lines) {
    const row = parse(line);
    if (!row) continue;
    const payload = obj(row.payload);
    const timestamp = str(row.timestamp);
    if (row.type === 'session_meta') {
      sessionId = str(payload.id) ?? str(payload.session_id);
      cwd = str(payload.cwd);
      // Первая запись несёт проект сессии — как первая строка транскрипта Claude.
      yield { type: 'meta', ...(cwd ? { cwd } : {}), ...(sessionId ? { sessionId } : {}) };
      continue;
    }
    const base = {
      ...(timestamp ? { timestamp } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(cwd ? { cwd } : {}),
    };
    if (row.type === 'turn_context') {
      model = str(payload.model) ?? model;
      const turn = str(payload.turn_id);
      if (turn && model) models.set(turn, model);
      continue;
    }
    if (row.type === 'token_usage_record') {
      const usage = obj(payload.usage);
      records += 1;
      const turn = str(payload.turn_id);
      yield answer(
        base,
        str(payload.response_id) ?? `record-${records}`,
        (turn && models.get(turn)) || model,
        usageOf(
          usage.input_tokens,
          usage.cached_input_tokens,
          usage.output_tokens,
          usage.cache_write_input_tokens,
        ),
      );
      continue;
    }
    if (row.type === 'event_msg' && payload.type === 'token_count') {
      const last = obj(obj(payload.info).last_token_usage);
      if (Object.keys(last).length === 0) continue;
      fallback.push(
        answer(
          base,
          `token-count-${fallback.length}`,
          model,
          usageOf(
            last.input_tokens,
            last.cached_input_tokens,
            last.output_tokens,
            last.cache_write_input_tokens,
          ),
        ),
      );
      continue;
    }
    if (row.type === 'response_item' && payload.type === 'function_call') {
      const name = str(payload.name);
      if (name) yield toolCall(base, name);
    }
  }
  if (records === 0) yield* fallback;
};

/**
 * Qwen Code: `projects/<проект>/chats/<сессия>.jsonl`. Каждый запрос к модели —
 * и фоновый (извлечение памяти), а не только ответ человеку — пишется записью
 * `ui_telemetry` с событием `qwen-code.api_response` и `response_id`; ответ
 * человеку вдобавок несёт `usageMetadata`. Берётся телеметрия, а у файла без
 * неё — `usageMetadata`. `thoughts` — отдельно от `output`, как у Gemini, и
 * стоит как выход.
 */
export const qwenEntries: EntrySource = async function* (lines) {
  let telemetry = 0;
  const fallback: RawEntry[] = [];
  for await (const line of lines) {
    const row = parse(line);
    if (!row) continue;
    const timestamp = str(row.timestamp);
    const sessionId = str(row.sessionId);
    const cwd = str(row.cwd);
    const base = {
      ...(timestamp ? { timestamp } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(cwd ? { cwd } : {}),
    };
    const event = obj(obj(row.systemPayload).uiEvent);
    if (row.type === 'system' && event['event.name'] === 'qwen-code.api_response') {
      telemetry += 1;
      yield answer(
        base,
        str(event.response_id) ?? `telemetry-${telemetry}`,
        str(event.model),
        usageOf(
          event.input_token_count,
          event.cached_content_token_count,
          count(event.output_token_count) + count(event.thoughts_token_count),
        ),
      );
      continue;
    }
    if (row.type !== 'assistant') {
      // Первая запись (вопрос человека) несёт проект сессии.
      if (cwd) yield { type: 'meta', ...base };
      continue;
    }
    const parts = Array.isArray(obj(row.message).parts)
      ? (obj(row.message).parts as unknown[])
      : [];
    for (const part of parts) {
      const name = str(obj(obj(part).functionCall).name);
      if (name) yield toolCall(base, name);
    }
    const meta = obj(row.usageMetadata);
    if (Object.keys(meta).length > 0) {
      fallback.push(
        answer(
          base,
          str(row.uuid) ?? `usage-${fallback.length}`,
          str(row.model),
          usageOf(
            meta.promptTokenCount,
            meta.cachedContentTokenCount,
            count(meta.candidatesTokenCount) + count(meta.thoughtsTokenCount),
          ),
        ),
      );
    }
  }
  if (telemetry === 0) yield* fallback;
};

/** Файлы сессий чужого CLI, изменённые с начала периода. */
export function collectForeignFiles(
  source: ForeignSource,
  since: number,
): Array<{ path: string; mtimeMs: number }> {
  const result: Array<{ path: string; mtimeMs: number }> = [];
  const take = (path: string): void => {
    const { mtimeMs } = statSync(path);
    if (mtimeMs >= since) result.push({ path, mtimeMs });
  };
  const walk = (dir: string, depth: number, accept: (name: string) => boolean): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth > 0) walk(path, depth - 1, accept);
      else if (entry.isFile() && accept(entry.name)) take(path);
    }
  };
  const seen = new Set<string>();
  for (const home of source.homes) {
    if (seen.has(home)) continue;
    seen.add(home);
    if (source.kind === 'codex') {
      const rollout = (name: string) => name.startsWith('rollout-') && name.endsWith('.jsonl');
      walk(join(home, 'sessions'), 3, rollout); // sessions/ГГГГ/ММ/ДД/rollout-*.jsonl
      walk(join(home, 'archived_sessions'), 0, rollout);
    } else {
      const projects = join(home, 'projects');
      if (!existsSync(projects)) continue;
      for (const project of readdirSync(projects, { withFileTypes: true })) {
        if (project.isDirectory()) {
          walk(join(projects, project.name, 'chats'), 0, (name) => name.endsWith('.jsonl'));
        }
      }
    }
  }
  return result;
}

export function entriesOf(source: ForeignSource): EntrySource {
  return source.kind === 'codex' ? codexEntries : qwenEntries;
}
