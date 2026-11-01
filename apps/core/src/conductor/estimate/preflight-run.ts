import type { JournalDataV1, JournalLine } from '@agentdeck/contracts/core/journal';
import type { LiveTask } from '../../journal/resume.ts';
import type { AllowedRoute, PreflightRepo } from '../preflight/index.ts';
import type { PreflightVerdict, RoadResult } from '../preflight/preflight.types.ts';
import type { PreflightRow, SplitEnv } from './estimate.types.ts';

/**
 * Предпроверка дорог при оценке и при запуске (P101, 04:105-112): один прогон на задачу, итог —
 * строка `signal preflight` (detail — JSON строк ответа: повтор оценки отвечает тем же, не
 * гоняя пробы второй раз). Падение дороги — задача не идёт, причина и исправление названы.
 */

export const PREFLIGHT_SIGNAL = 'preflight';

function detailOf(r: RoadResult): string {
  const fix = 'fix' in r && r.fix ? ` — fix: ${r.fix}` : '';
  return `${'detail' in r && r.detail ? r.detail : r.status}${fix}`;
}

/** Строки ответа: блокирующая дорога — `failed`, отложенная фазой или ненужная — `not-checked`. */
export function preflightRows(verdict: PreflightVerdict): PreflightRow[] {
  const statusOf = (r: RoadResult): PreflightRow['status'] => {
    if (verdict.blocking.includes(r)) return 'failed';
    if (r.status === 'skipped' || r.status === 'not-checked-until-phase') return 'not-checked';
    return 'ok';
  };
  return verdict.roads.map((r) => ({ road: r.road, status: statusOf(r), detail: detailOf(r) }));
}

/** Публикует ли сценарий: есть шаг `publish`. Сценарий не разрешён — `undefined`, дорога git проверяется. */
export function publishesOf(steps: readonly { kind: string }[] | undefined): boolean | undefined {
  return steps ? steps.some((s) => s.kind === 'publish') : undefined;
}

export async function runTaskPreflight(
  repos: readonly { repoKey: string; path: string }[],
  allowed: readonly AllowedRoute[],
  env: SplitEnv,
  publishes?: boolean,
): Promise<{ start: boolean; rows: PreflightRow[] }> {
  const withRemotes: PreflightRepo[] = await Promise.all(
    repos.map(async (r) => {
      const remotes = await env.remotesOf(r.path);
      // Удалённые не прочлись — пустой список: `ls-remote` назовёт «нет удалённых», не тишина.
      return { path: r.path, remotes: 'value' in remotes ? remotes.value : [] };
    }),
  );
  const verdict = await env.preflight(
    {
      needsServices: await env.needsServices(repos),
      ...(publishes === undefined ? {} : { publishes }),
    },
    withRemotes,
    allowed,
  );
  return { start: verdict.start, rows: preflightRows(verdict) };
}

/** Строка предпроверки в журнале задачи. `subject` — где прогнана: оценка или запуск. */
export function journalPreflight(
  task: LiveTask,
  at: 'estimate' | 'launch',
  result: { start: boolean; rows: PreflightRow[] },
  cmdId?: string,
): JournalLine<'signal'> {
  const data: JournalDataV1['signal'] = {
    signal: PREFLIGHT_SIGNAL,
    severity: result.start ? 'info' : 'stop',
    subject: at,
    detail: JSON.stringify(result.rows),
  };
  return task.append({ kind: 'signal', actor: 'core', data, ...(cmdId ? { cmdId } : {}) });
}

/** Массив JSON из `detail` сигнала; чужая форма — пусто (повтор не падает на старой строке). */
export function jsonArray(detail: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(detail);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Строки предпроверки из журнальной строки (повтор оценки). */
export function rowsOfSignal(detail: string): PreflightRow[] {
  return jsonArray(detail).filter(
    (r): r is PreflightRow =>
      typeof r === 'object' && r !== null && 'road' in r && 'status' in r && 'detail' in r,
  );
}
