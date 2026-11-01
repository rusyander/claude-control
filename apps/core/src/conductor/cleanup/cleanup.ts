import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { HumanLedger } from '../human/human.types.ts';
import { releaseResource, type ReleaseDeps } from '../services.ts';
import type { CleanupDecision, CleanupItem, CleanupPoint, CleanupResult } from './cleanup.types.ts';

/**
 * Уборка на конце шага, единицы и задачи (06 §Human points: своё ядро снимает без вопроса, F10;
 * P90 — снято только то, что прочитано назад). Решение чистое — над проекцией журнала; снятие —
 * через `releaseResource` (одна дорога с командой `release-resource`, чтение назад там же).
 *
 * Не своё не трогается: ресурсы сессии снимает дорога сессии, копию — дорога копий (её ждёт
 * публикация), аренды и модели — свои дороги. Ресурс без единицы на её конце не судится — он
 * дождётся конца задачи, а не снимется наугад.
 */

/** Виды, которые ядро снимает само по строке ресурса (тот же набор, что у `release-resource`). */
const OWN_RELEASE = new Set(['tmpdir', 'container', 'process', 'port', 'volume', 'stand']);

const SCOPE_RANK = { 'step-end': 0, 'unit-end': 1, 'task-end': 2 } as const;

function inScope(
  at: CleanupPoint,
  r: HumanLedger['resources'][string],
  release: keyof typeof SCOPE_RANK,
): boolean {
  // Ресурс снимается на своей точке или позже: шаговый, переживший шаг (крах), снимет единица.
  if (SCOPE_RANK[release] > SCOPE_RANK[at.kind]) return false;
  if (at.kind === 'task-end') return true;
  if (at.kind === 'unit-end') return r.unitId === at.unitId;
  return r.stepId === at.stepId;
}

export function decideCleanup(ledger: HumanLedger, at: CleanupPoint): CleanupDecision {
  const release: CleanupItem[] = [];
  const keep: CleanupItem[] = [];
  for (const [rid, r] of Object.entries(ledger.resources)) {
    if (r.status === 'verified') continue;
    if (typeof r.release === 'object') {
      if (at.kind === 'task-end') keep.push({ rid, kind: r.kind, why: `kept: ${r.release.keep}` });
      continue;
    }
    if (!inScope(at, r, r.release)) continue;
    if (r.owner !== 'core') {
      keep.push({ rid, kind: r.kind, why: 'session resource: released by the session road' });
    } else if (!OWN_RELEASE.has(r.kind)) {
      keep.push({ rid, kind: r.kind, why: `${r.kind}: released by its own road` });
    } else {
      const why =
        r.status === 'leak' ? 'leak from an earlier pass: try again' : `release ${r.release}`;
      release.push({ rid, kind: r.kind, why });
    }
  }
  return { at, release, keep };
}

/** Снятие по решению: каждое — с чтением назад; отказ снятия — пропуск с причиной, не утечка. */
export async function applyCleanup(
  task: LiveTask,
  decision: CleanupDecision,
  deps: ReleaseDeps = {},
): Promise<CleanupResult> {
  const out: CleanupResult = { verified: [], leaks: [], skipped: [] };
  if (decision.release.length === 0 && decision.keep.length === 0) return out;
  // Решение в журнале до снятия: лента и отчёт видят, что и почему снято или оставлено.
  task.append({
    kind: 'decision',
    actor: 'core',
    ...(decision.at.kind === 'step-end' ? { stepId: decision.at.stepId } : {}),
    ...(decision.at.kind === 'unit-end' ? { unitId: decision.at.unitId } : {}),
    data: {
      decisionId: newId(),
      class: 'cleanup',
      inputs: [],
      facts: [],
      numbers: { release: decision.release.length, keep: decision.keep.length },
      reasons: [...decision.release, ...decision.keep].map((i) => `${i.rid}: ${i.why}`),
      output: decision as never,
    },
  });
  for (const item of decision.release) {
    const got = await releaseResource(task, item.rid, deps);
    if ('verified' in got) out.verified.push({ rid: got.rid, fact: got.verified });
    else if ('leak' in got) out.leaks.push({ rid: got.rid, reason: got.leak });
    else out.skipped.push({ rid: item.rid, reason: `${got.rejected}: ${got.reason}` });
  }
  return out;
}
