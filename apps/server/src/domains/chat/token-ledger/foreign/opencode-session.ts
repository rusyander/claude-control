import { guardLabel, MAX_TIMEOUT_MS, toolOutcome } from '../watch/tool-outcome.ts';
import type { WatchEvent } from '../watch/watch.types.ts';
import { normalizeToolName, resultChars } from './foreign-events.ts';
import type { ForeignDocumentReader } from './foreign.types.ts';

/**
 * Сессия OpenCode из базы (`opencode-db.ts`) → события сторожа групп. Формы — записи
 * НАСТОЯЩЕГО opencode 1.18.35 на подменной модели во временном доме
 * (`__fixtures__/opencode-1.18-session.json`):
 *
 * - часть `step-finish` — расход ОДНОГО запроса к модели: `tokens.input` уже без
 *   кэша, `cache.read`/`cache.write` отдельно, размышление — в выходе. Окно запроса
 *   настоящее, правила об окне (R2, R19, R34) работают как у Claude;
 * - часть `tool` — вызов (`state.input`) и, когда `state.status` устоялся, ответ:
 *   отказ человека или правила прав — текстом самого CLI в `state.error`, отказ
 *   плагина набора — его текст как есть (`[ctx-guard] …`), ненулевой выход оболочки —
 *   `state.metadata.exit` при `completed`, срок — пометка в `<shell_metadata>`;
 * - `text`/`reasoning` → «жива» (R1); часть `compaction` → сжатие (`auto: false` — по просьбе);
 * - ошибка сообщения (`info.error`, кроме отмены) → сбой запроса (R30);
 * - субагент (`task`) — дочерняя сессия: её события помечены `sidechain`.
 *
 * Реплику человека читатель не отдаёт: начало хода сторож получает от панели.
 * Каждая запись отдаётся один раз — по ключу (id части, id вызова), время — её
 * собственное.
 */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const timeOf = (...values: unknown[]): number | undefined =>
  values.find((value): value is number => typeof value === 'number' && Number.isFinite(value));

const PERMISSION_REJECTED = /^The user rejected permission to use this specific tool call/;
const RULE_DENIED =
  /^The user has specified a rule which prevents you from using this specific tool call/;
/** Отказ плагина набора: метка стража (`[ctx-guard] `) или его общий текст. */
const KIT_REFUSAL = /^\[[\w.-]*guard\]|^agentdeck kit: refused/;
const TIMED_OUT = /terminated command after exceeding timeout (\d+) ms/;
/** Заглушка OpenCode на месте пустого вывода — не текст ошибки. */
const NO_OUTPUT = /^\(no output\)\s*$/;

type ToolResult = Extract<WatchEvent, { kind: 'toolResult' }>;

function outcomeOf(state: Json): Partial<ToolResult> {
  if (state.status === 'error') {
    const text = str(state.error) ?? '';
    if (PERMISSION_REJECTED.test(text)) return { denied: 'permission' };
    if (RULE_DENIED.test(text)) return { denied: 'policy' };
    if (KIT_REFUSAL.test(text)) return { denied: guardLabel(text) || 'hook' };
    return toolOutcome({ is_error: true, content: text });
  }
  const output = str(state.output) ?? '';
  const timed = TIMED_OUT.exec(output);
  const ms = timed?.[1] ? Math.min(Number(timed[1]), MAX_TIMEOUT_MS) : 0;
  if (ms > 0) return { timedOutMs: ms };
  const exit = obj(state.metadata)?.exit;
  if (typeof exit === 'number' && exit !== 0) {
    // Голова — к форме Claude («Exit code N»): род ошибки и её повтор (R24) узнаются тем же разбором.
    const body = NO_OUTPUT.test(output) ? '' : `\n${output}`;
    return toolOutcome({ is_error: true, content: `Exit code ${exit}${body}` });
  }
  return {};
}

/** Голова сбоя запроса: имя ошибки, код ответа и текст — как у R30 в строке сигнала. */
function apiErrorHead(error: Json): string | undefined {
  const name = str(error.name);
  if (!name || name === 'MessageAbortedError') return undefined;
  const data = obj(error.data);
  const status = num(data?.statusCode);
  const message = str(data?.message);
  return `${name}${status ? ` ${status}` : ''}${message ? `: ${message}` : ''}`;
}

/** Сколько ключей отданных записей помнить: длинная сессия serve с запасом. */
const FED_CAP = 20_000;

export function opencodeWatchEvents(): ForeignDocumentReader {
  const fed = new Set<string>();
  const once = (key: string): boolean => {
    if (fed.has(key)) return false;
    fed.add(key);
    if (fed.size > FED_CAP) fed.delete(fed.values().next().value as string);
    return true;
  };

  const walk = (doc: Json, sidechain: boolean, now: number, out: WatchEvent[]): void => {
    const side = sidechain ? { sidechain: true as const } : {};
    for (const rawMessage of arr(doc.messages)) {
      const message = obj(rawMessage);
      const info = obj(message?.info);
      const messageId = str(message?.id);
      if (!message || !info || !messageId) continue;
      const created = timeOf(message.created, obj(info.time)?.created) ?? now;
      const error = obj(info.error);
      const head = error ? apiErrorHead(error) : undefined;
      if (head && once(`e:${messageId}`)) {
        out.push({ kind: 'apiError', t: timeOf(obj(info.time)?.completed) ?? created, head });
      }
      for (const rawPart of arr(message.parts)) {
        const part = obj(rawPart);
        const partId = str(part?.id);
        if (!part || !partId) continue;
        const at = timeOf(part.created) ?? created;
        switch (part.type) {
          case 'step-finish': {
            if (info.role !== 'assistant' || !once(`c:${partId}`)) break;
            const tokens = obj(part.tokens);
            const cache = obj(tokens?.cache);
            const call = {
              input: num(tokens?.input),
              cacheRead: num(cache?.read),
              cacheWrite: num(cache?.write),
              output: num(tokens?.output) + num(tokens?.reasoning),
            };
            if (call.input + call.cacheRead + call.cacheWrite + call.output === 0) break;
            const model = str(info.modelID);
            out.push({
              kind: 'call',
              t: at,
              ...(model ? { model } : {}),
              ...call,
              cacheWrite1h: 0,
              ...side,
            });
            break;
          }
          case 'tool': {
            const state = obj(part.state);
            const id = str(part.callID) ?? partId;
            const status = str(state?.status);
            // `pending` — аргументы модели ещё не дописаны: вызов отдаётся, когда пошёл.
            if (!state || !status || status === 'pending') break;
            const times = obj(state.time);
            // Ключ — id части: id вызова пишет модель, у субагента он может совпасть.
            if (once(`t:${partId}`)) {
              const tool = normalizeToolName(
                'opencode',
                str(part.tool) ?? '?',
                obj(state.input) ?? {},
              );
              out.push({ kind: 'tool', t: timeOf(times?.start) ?? at, id, ...tool, ...side });
            }
            if ((status === 'completed' || status === 'error') && once(`r:${partId}`)) {
              out.push({
                kind: 'toolResult',
                t: timeOf(times?.end, part.updated) ?? at,
                id,
                chars: resultChars(status === 'error' ? state.error : state.output),
                ...outcomeOf(state),
              });
            }
            break;
          }
          case 'text':
          case 'reasoning':
            if (info.role === 'assistant' && str(part.text) && once(`a:${partId}`)) {
              out.push({ kind: 'activity', t: timeOf(obj(part.time)?.end) ?? at });
            }
            break;
          case 'compaction':
            if (!sidechain && once(`k:${partId}`)) {
              out.push({
                kind: 'compact',
                t: at,
                ...(part.auto === false ? { manual: true } : {}),
              });
            }
            break;
          default:
            break;
        }
      }
    }
    for (const child of arr(doc.children)) {
      const one = obj(child);
      if (one) walk(one, true, now, out);
    }
  };

  return (doc, now) => {
    const root = obj(doc);
    if (!root) return [];
    const out: WatchEvent[] = [];
    walk(root, false, now, out);
    // Субагент пишет в свою сессию вперемешку с родителем: события — по времени.
    return out.sort((a, b) => a.t - b.t);
  };
}
