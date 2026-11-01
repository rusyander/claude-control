import type { Predicate, SignalVerdict } from '../observer.types.ts';
import { contextOf, permitRefusalOf, toolEventOf, whereOf, type ToolEventData } from './facts.ts';

/**
 * Повтор падающей команды (06:136, F5): та же команда (отпечаток argv) в том же каталоге падает
 * тем же исходом — код выхода, а без него (CLI кода не отдал) отпечаток текста ошибки, — и между
 * падениями ничего не поменялось. Сбрасывает счёт любая правка в сессии и удачное исполнение в
 * том же каталоге. Второе падение — подсказка, третье — остановка шага (ступень `escalated`).
 * Отказ допуска — не падение команды (его считает повтор отказа): по id вызова, а если id нет или
 * он не тот, что в потоке, — следующая ошибка того же инструмента в той же сессии. Ожидание (класс `wait`) не судится.
 * Без отпечатка argv (разбор
 * неточный, R8) или без исхода сравнивать нечего — молчание, а не догадка.
 */

export const WASTE_FAIL_REPEAT = 'waste-fail-repeat';

interface Run {
  count: number;
  /** seq первого падения серии: новая серия после сброса — новые ключи. */
  epoch: number;
  sessionId: string;
  cwd: string | null;
}

export interface FailRepeatState {
  runs: ReadonlyMap<string, Run>;
  /** id вызовов, которым отказал судья права (их результат-ошибка — не падение команды). */
  refused: ReadonlySet<string>;
  /**
   * Отказы по `сессия|инструмент` — сколько ещё ждут своего результата: следующая ошибка того же
   * инструмента в сессии — отказанный вызов, не падение (id нет или он чужой).
   */
  refusedAnon: ReadonlyMap<string, number>;
}

const anonKey = (sessionId: string, tool: string): string => `${sessionId}|${tool}`;

function outcomeKey(d: ToolEventData): string | null {
  if (d.exitCode !== null) return `exit:${d.exitCode}`;
  return d.errorDigest === null ? null : `digest:${d.errorDigest}`;
}

function dropRuns(
  runs: ReadonlyMap<string, Run>,
  drop: (r: Run) => boolean,
): ReadonlyMap<string, Run> {
  const kept = [...runs].filter(([, r]) => !drop(r));
  return kept.length === runs.size ? runs : new Map(kept);
}

export const failRepeatPredicate: Predicate<FailRepeatState> = {
  ids: [WASTE_FAIL_REPEAT],
  init: () => ({ runs: new Map(), refused: new Set(), refusedAnon: new Map() }),
  step(state, line) {
    const refusal = permitRefusalOf(line);
    if (refusal) {
      // Отказ ждёт свой результат и по id, и по `сессия|инструмент`: id хука может быть не тем,
      // что в потоке (qwen пишет в хук свой `tool_use_id`, проба M), тогда решает второй ключ.
      const refused = refusal.toolUseId
        ? new Set(state.refused).add(refusal.toolUseId)
        : state.refused;
      if (!refusal.sessionId || refusal.tool === '')
        return { state: { ...state, refused }, verdicts: [] };
      const k = anonKey(refusal.sessionId, refusal.tool);
      const refusedAnon = new Map(state.refusedAnon).set(k, (state.refusedAnon.get(k) ?? 0) + 1);
      return { state: { ...state, refused, refusedAnon }, verdicts: [] };
    }
    const ev = toolEventOf(line);
    if (!ev) return { state, verdicts: [] };
    const d = ev.data;
    const anon = anonKey(d.sessionId, d.tool);
    const waiting = state.refusedAnon.get(anon) ?? 0;
    const byId = state.refused.has(d.toolUseId);
    if (d.isError && (byId || waiting > 0)) {
      // Результат отказанного вызова — не падение; ждущий отказ этого инструмента снят.
      const refusedAnon = new Map(state.refusedAnon);
      if (waiting <= 1) refusedAnon.delete(anon);
      else refusedAnon.set(anon, waiting - 1);
      return { state: { ...state, refusedAnon }, verdicts: [] };
    }
    if (d.effectClass === 'edit')
      return {
        state: { ...state, runs: dropRuns(state.runs, (r) => r.sessionId === d.sessionId) },
        verdicts: [],
      };
    // Ожидание — дело опроса: одиночный сон CLI блокируют одинаковой ошибкой (проба M), это не
    // падение команды; удачный сон ничего не поменял, серию падений не сбрасывает.
    if (d.argvDigest === null || d.effectClass === 'wait') return { state, verdicts: [] };
    if (!d.isError) {
      const runs = dropRuns(state.runs, (r) => r.sessionId === d.sessionId && r.cwd === d.cwd);
      return { state: { ...state, runs }, verdicts: [] };
    }
    const outcome = outcomeKey(d);
    if (outcome === null) return { state, verdicts: [] };
    const ctx = contextOf(d);
    const key = `${ctx}|${d.argvDigest}|${d.cwd ?? '?'}|${outcome}`;
    const prev = state.runs.get(key);
    const run: Run = {
      count: (prev?.count ?? 0) + 1,
      epoch: prev?.epoch ?? line.seq,
      sessionId: d.sessionId,
      cwd: d.cwd,
    };
    const runs = new Map(state.runs).set(key, run);
    const verdicts: SignalVerdict[] = [];
    if (run.count === 2 || run.count === 3) {
      const how =
        d.exitCode !== null
          ? `exit code ${d.exitCode}`
          : 'the same error text (the CLI gave no exit code; compared by error digest)';
      verdicts.push({
        fired: true,
        signal: WASTE_FAIL_REPEAT,
        subject: d.display ?? d.tool,
        detail: `failed ${run.count} times with ${how} in ${d.cwd ?? 'an unknown directory'}, no edit in between`,
        reasons: [
          `same argv digest ${d.argvDigest.slice(0, 12)} and directory`,
          `same outcome ${outcome.startsWith('exit:') ? outcome : 'digest'}`,
          `failure ${run.count} of this run (2nd → hint, 3rd → stop)`,
        ],
        key: `${WASTE_FAIL_REPEAT}:${key}:${run.epoch}:${run.count}`,
        ...whereOf(line),
        ...(run.count === 3 ? { escalated: true } : {}),
        inputs: [line.seq],
      });
    }
    return { state: { ...state, runs }, verdicts };
  },
};
