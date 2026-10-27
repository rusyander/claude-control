import { usageOf } from '../../../analytics/scanner/foreign.ts';
import { errorHeadOf, guardLabel, toolOutcome } from '../watch/tool-outcome.ts';
import type { WatchEvent } from '../watch/watch.types.ts';
import { normalizeToolName, resultChars } from './foreign-events.ts';
import type { ForeignRowReader } from './foreign.types.ts';

/**
 * Поток `gemini -o stream-json` → события сторожа групп. Файла переписки сторож у
 * Gemini CLI не читает: каждый ход панели — новый запуск `-p` с перепиской в
 * промпте, и правила видят строки потока, которые панель и так разбирает
 * (`providers/catalog/gemini-stream.ts`), — в ту же минуту, что и человек.
 *
 * Формы — записи НАСТОЯЩЕГО gemini 0.62.0 на подменной модели во временном доме
 * (`__fixtures__/gemini-0.62-stream-watch.jsonl`):
 * - `tool_use` → вызов, имена — к именам Claude (`normalizeToolName`);
 * - `tool_result` со `status: 'error'`: `error.type: 'policy_violation'` — отказ хука
 *   набора («Tool execution blocked: <причина>», страж назван причиной, как у
 *   Claude) или правила политики («Tool execution denied by policy.»);
 *   `tool_not_registered` — инструмента нет (R29); прочее — ошибка (R24);
 * - оболочка с ненулевым выходом приходит `status: 'success'`: код виден, только
 *   когда вывода нет («Command exited with code: N»), вывод кода не несёт;
 * - текст ассистента → «жива» (R1);
 * - `result` → расход хода. CLI называет только итог хода по моделям (сумму всех
 *   запросов), окна одного запроса в потоке нет: вызов помечен `turnTotal`.
 */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

const HOOK_BLOCKED = /^Tool execution blocked:\s*/;
const SHELL_EXIT = /^Command exited with code: (-?\d+)\s*$/;

function timeOf(record: Json): number {
  return typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
}

/** Отказ, ошибка или ненулевой выход оболочки — по `tool_result` потока. */
function outcomeOf(record: Json): Partial<Extract<WatchEvent, { kind: 'toolResult' }>> {
  const output = str(record.output) ?? '';
  if (record.status !== 'error') {
    const exit = SHELL_EXIT.exec(output);
    return exit?.[1] && exit[1] !== '0'
      ? toolOutcome({ is_error: true, content: `Exit code ${exit[1]}` })
      : {};
  }
  const error = obj(record.error);
  const text = str(error?.message) ?? output;
  if (error?.type === 'policy_violation') {
    return HOOK_BLOCKED.test(text)
      ? { denied: guardLabel(text.replace(HOOK_BLOCKED, '')) || 'hook' }
      : { denied: 'policy' };
  }
  if (error?.type === 'tool_not_registered') {
    return { isError: true, errorKind: 'no-tool', errorHead: errorHeadOf(text) };
  }
  return toolOutcome({ is_error: true, content: text });
}

/** Итог хода по моделям: у каждой модели — свой вызов-итог. */
function turnCalls(record: Json, t: number, model: string | undefined): WatchEvent[] {
  const stats = obj(record.stats);
  if (!stats) return [];
  const models = Object.entries(obj(stats.models) ?? {});
  const rows: Array<[string | undefined, Json]> =
    models.length > 0
      ? models.flatMap(([name, value]) => {
          const one = obj(value);
          return one ? [[name, one] as [string, Json]] : [];
        })
      : [[model, stats]];
  return rows.flatMap(([name, usage]): WatchEvent[] => {
    const raw = usageOf(usage.input_tokens, usage.cached, usage.output_tokens);
    const input = raw.input_tokens ?? 0;
    const cacheRead = raw.cache_read_input_tokens ?? 0;
    const output = raw.output_tokens ?? 0;
    if (input + cacheRead + output === 0) return [];
    return [
      {
        kind: 'call',
        t,
        ...(name ? { model: name } : {}),
        input,
        cacheRead,
        cacheWrite: 0,
        cacheWrite1h: 0,
        output,
        turnTotal: true,
      },
    ];
  });
}

export function geminiStreamEvents(): ForeignRowReader {
  let model: string | undefined;
  return (row) => {
    const record = obj(row);
    if (!record) return [];
    const t = timeOf(record);
    if (!Number.isFinite(t)) return [];
    switch (record.type) {
      case 'init':
        model = str(record.model) ?? model;
        return [];
      case 'message':
        return record.role === 'assistant' && str(record.content) ? [{ kind: 'activity', t }] : [];
      case 'tool_use': {
        const name = str(record.tool_name);
        if (!name) return [];
        const tool = normalizeToolName('gemini', name, obj(record.parameters) ?? {});
        return [{ kind: 'tool', t, id: str(record.tool_id) ?? '', ...tool }];
      }
      case 'tool_result': {
        const id = str(record.tool_id);
        if (!id) return [];
        const chars = resultChars(record.output ?? obj(record.error)?.message);
        return [{ kind: 'toolResult', t, id, chars, ...outcomeOf(record) }];
      }
      case 'result':
        return turnCalls(record, t, model);
      default:
        return [];
    }
  };
}

/** Ход CLI сторож читает строками его потока (Gemini CLI), а не файлом переписки. */
export function readsForeignStream(providerId: string): boolean {
  return providerId === 'gemini';
}

/** Читатель потока хода по провайдеру; CLI без потока строк JSON — `undefined`. */
export function foreignStreamReader(providerId: string): ForeignRowReader | undefined {
  return readsForeignStream(providerId) ? geminiStreamEvents() : undefined;
}
