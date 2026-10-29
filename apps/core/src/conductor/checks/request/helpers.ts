import { resolve } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  CheckDecisionInput,
  CheckEntry,
  CheckRegistry,
  Verdict,
} from '@agentdeck/contracts/core/records';
import { realDir } from '../../../platform/copy-fs.ts';
import { isInside } from '../../../platform/paths.ts';
import { MIN_BEAT_MS } from '../../../verifier/queue/order.ts';
import type { HeartbeatAnswer } from '../../../verifier/queue/queue.types.ts';
import type { RunResult } from '../../../verifier/run/run.types.ts';
import { narrowVerdict, verdictOf } from '../../../verifier/run/verdict.ts';
import type { CheckDeps } from '../checks.types.ts';

/** Чистые помощники входа проверки: без состояния входа, без чтений кроме путей копии. */

export const ANSWER_BUDGET_MS = 100_000;
export const POLL_MS = 250;
/** Сколько последних прогонов проверки и единицы учат срок: старая история — другая машина. */
export const HISTORY_RUNS = 50;
export const EMPTY_REGISTRY: CheckRegistry = { units: {}, machinery: [], checks: [], rejected: [] };
export const WINDOW: CheckDecisionInput['window'] = {
  verdict: 'open',
  basis: 'not-modelled-until-phase-5',
};

/**
 * Вердикт прогона с поправкой узкой выборки: зелёный без единого выполненного теста — не зелёный
 * (выборка ни с чем не совпала, раннер вышел с 0). Причина дописывается в журнал записи, чтобы
 * читающий лог видел, почему «0 тестов» не засчитано.
 */
export function judge(
  entry: CheckEntry,
  narrowed: boolean,
  result: RunResult,
): { verdict: Verdict; result: RunResult; note?: string } {
  const kind = entry.filter?.kind;
  const out = narrowVerdict(verdictOf(result), narrowed && kind ? { kind, log: result.log } : null);
  if (!out.note) return { verdict: out.verdict, result };
  const log = `${result.log}\n[agentdeck] ${out.note}\n`;
  return {
    verdict: out.verdict,
    result: { ...result, log, logBytes: Buffer.byteLength(log) },
    note: out.note,
  };
}

/**
 * cwd проверки из реестра обязан лежать внутри копии (B2-F02): реестр читается из рабочего дерева
 * задачи, и `..` или ссылка-junction наружу запустили бы argv в чужом каталоге. Сравниваются
 * настоящие пути (ссылки раскрыты); не читается — тоже отказ, прогона нет. `null` — можно.
 */
export function cwdOutside(copyDir: string, cwd: string): string | null {
  if (cwd === '') return null;
  const root = realDir(copyDir);
  if (!('value' in root))
    return `check cwd: copy dir ${'unknown' in root ? root.unknown : 'absent'}`;
  const target = realDir(resolve(copyDir, cwd));
  if (!('value' in target))
    return `check cwd ${cwd}: ${'unknown' in target ? target.unknown : 'absent'}`;
  if (isInside(root.value, target.value)) return null;
  return `check cwd ${cwd}: outside the copy`;
}

/** Прогона не было (окружение или сервисы не готовы): исход `spawn-failed` → `no-verdict(env)`. */
export function notRun(reason: string): RunResult {
  return {
    end: 'spawn-failed',
    exit: null,
    signal: null,
    ms: 0,
    log: '',
    logBytes: 0,
    truncated: false,
    failing: [],
    standEpoch: null,
    standMoved: false,
    temp: { removed: true },
    reason,
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const factKind = (f: Fact<unknown>): 'value' | 'absent' | 'unknown' =>
  'value' in f ? 'value' : 'absent' in f ? 'absent' : 'unknown';
export const why = (f: Fact<unknown>): string => ('unknown' in f ? f.unknown : 'absent');
export const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
/**
 * Имя теста, что раннер прочтёт как флаг (`--root=…`, `--manifest-path=…`): шаблоны cargo/gradle
 * и `-t` jest кладут имя в argv как есть — такое имя увело бы прогон за пределы копии.
 */
export const flagLike = (name: string): boolean => name.startsWith('-');

/**
 * Удар сердца из таймера: исключение записи (ENOSPC, EPERM антивируса) в таймере роняет весь
 * процесс ядра. Сбой записи — «не прочитано» (F25), а не «отобрали»: следующий удар повторит.
 */
export function quietBeat(beat: () => HeartbeatAnswer): HeartbeatAnswer {
  try {
    return beat();
  } catch (error) {
    return { unknown: message(error) };
  }
}

/** Снятие, которое не должно уронить ответ: не снялось — аренду снимет очередь как молчащую. */
export function quietly(work: () => unknown): void {
  try {
    work();
  } catch {
    // Сбой записи при снятии: держатель перестаёт бить сердцем, очередь снимет запись сама.
  }
}

export function beatMsOf(deps: CheckDeps): number {
  // Такт удара — из настройки очереди (D§3.8): держатель считается молчащим после трёх пропусков.
  return Math.max(MIN_BEAT_MS, deps.queue.beatMs());
}
