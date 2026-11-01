import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { Predicate, SignalVerdict } from '../observer.types.ts';

/**
 * Предикат тишины сессии (06:138-139, P18, F9 этапа 8): `stall` по строке `session.probe` — её
 * пишет проводка, когда затихшая сессия перешла свой порог и прошла пробу жизни. Предикат только
 * называет факт: живая и молчит — показана (тишина ≠ провал, никто её не снимает); мёртвая —
 * показана, а сессию `lost` пишет проводка (правило продолжения); живость не прочитана — показана,
 * ничего не снято. Серьёзность и действие — из каталога (`stall`: warn → show), не отсюда.
 * Ключ — сессия + строка пробы: одна проба — один сигнал, перезапуск ядра его не повторит.
 */

export const STALL_SIGNAL = 'stall';

type ProbeData = JournalLine<'session.probe'>['data'];

/** Длительность для человека: `12m 05s`, `40s`, `1h 02m`. */
export function formatQuiet(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/** Процессор дерева за окно тишины: растёт — сессия что-то делает молча; стоит — ждёт. */
function cpuText(delta: number | null): string {
  if (delta === null) return 'CPU unread';
  if (delta > 0) return `CPU moving (+${delta} ms)`;
  if (delta === 0) return 'CPU flat';
  return `CPU fell by ${-delta} ms (a child process exited)`;
}

function detailOf(d: ProbeData): string {
  const quiet = `quiet ${formatQuiet(d.quietMs)}, threshold ${formatQuiet(d.thresholdMs)} (${d.toolClass})`;
  if (d.verdict === 'alive')
    return `${quiet}; host alive, ${cpuText(d.cpuDeltaMs)}; shown, not stopped`;
  if (d.verdict === 'dead')
    return `${quiet}; host dead: session lost, the resume rule takes the step`;
  return `${quiet}; liveness unread (${d.reason}); nothing stopped`;
}

export const stallPredicate: Predicate<null> = {
  ids: [STALL_SIGNAL],
  init: () => null,
  step(state, line) {
    if (line.kind !== 'session.probe') return { state, verdicts: [] };
    const d = (line as JournalLine<'session.probe'>).data;
    const verdict: SignalVerdict = {
      fired: true,
      signal: STALL_SIGNAL,
      subject: d.sessionId,
      detail: detailOf(d),
      reasons: [
        `session.probe seq ${line.seq}: ${d.verdict}`,
        `quiet ${d.quietMs} ms ≥ threshold ${d.thresholdMs} ms (${d.toolClass})`,
        d.reason,
      ],
      key: `${STALL_SIGNAL}:${d.sessionId}:${line.seq}`,
      sessionId: d.sessionId,
      ...(line.stepId ? { stepId: line.stepId } : {}),
      inputs: [line.seq],
    };
    return { state, verdicts: [verdict] };
  },
};
