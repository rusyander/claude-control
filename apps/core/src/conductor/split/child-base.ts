import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { commitOf } from '../../platform/copy-git.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import { mergeHeads } from '../../platform/git/merge-heads.ts';
import { BASE_PIN_SIGNAL, parseBasePin } from '../estimate/base-pin.ts';
import { isIntegrationUnit } from '../gates/integrated.ts';
import type { TaskRegistry } from '../tasks.ts';
import type { ProposedUnit } from './split.types.ts';

/**
 * База дочерней задачи XL с зависимостями (Q-2 s11): ребёнок, идущий «после» других, должен видеть
 * их работу — его копия берётся не от приколотой базы родителя, а от головы опубликованной ветки
 * ребёнка-зависимости. Одна голова — она; несколько — их слияние тем же путём, что основа копии
 * интеграции (`merge-tree --write-tree` + `commit-tree`, `platform/git/merge-heads.ts`); конфликт —
 * ребёнка не создают, причина названа (родитель кончается красным, как на отказе оценки).
 *
 * MR ребёнка смотрит туда же, куда MR единиц одной задачи с зависимостями: в основную ветку
 * репозитория, со ссылками (`publish-wiring/attempt.ts` `targetBranch: view.baseBranch`), — поэтому
 * ссылка приколотой базы ребёнка остаётся ссылкой родителя (`origin/main`), а не sha головы.
 */

/** Что родитель знает о своём репозитории и уже созданных детях — читается один раз на волну. */
export interface ParentBaseFacts {
  /** Ключ репозитория → ссылка приколотой базы родителя (`signal base-pin`). */
  pins: Map<string, string>;
  /** Имя части → id её задачи (все прежние волны). */
  byName: Map<string, string>;
}

/** Ссылки приколотой базы родителя и дети прежних волн из его журнала. */
export function parentBaseFacts(parent: LiveTask, signal: string): ParentBaseFacts {
  const pins = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const l of readJournalLines(parent.dir, parent.taskId).lines as JournalLine[]) {
    if (l.kind !== 'signal') continue;
    const d = (l as JournalLine<'signal'>).data;
    if (d.signal === BASE_PIN_SIGNAL) {
      const pin = parseBasePin(d.detail ?? '');
      if (pin) pins.set(d.subject, pin.ref);
    } else if (d.signal === signal) {
      try {
        const wave = JSON.parse(d.detail ?? '{}') as { byName?: Record<string, string> };
        for (const [name, id] of Object.entries(wave.byName ?? {})) byName.set(name, id);
      } catch {
        // Строка не JSON — волна без имён (до Q-2), зависимостей по ней не найти.
      }
    }
  }
  return { pins, byName };
}

/** Головы веток незакрытых единиц ребёнка в этом репозитории (интеграция — не своя работа). */
function headsOf(registry: TaskRegistry, childId: string, repoKey: string): string[] | null {
  const live = registry.live(childId);
  const state = live?.state ?? registry.view(childId);
  if (!state) return null;
  return Object.values(state.units)
    .filter((u) => u.repoKey === repoKey && u.state !== 'closed' && !isIntegrationUnit(u))
    .sort((a, b) => a.createdSeq - b.createdSeq)
    .map((u) => `refs/heads/${u.branch}`);
}

/**
 * База ребёнка `unit`: `null` — зависимостей в этом репозитории нет, база родителя как была;
 * `{ sha }` — голова зависимости или слияние голов; `{ refused }` — конфликт или головы не прочесть.
 */
export async function dependentBaseOf(
  registry: TaskRegistry,
  repoPath: string,
  unit: ProposedUnit,
  byName: ReadonlyMap<string, string>,
  git: GitOptions = {},
): Promise<{ sha: string } | { refused: string } | null> {
  if (unit.deps.length === 0) return null;
  const heads: string[] = [];
  for (const dep of unit.deps) {
    const childId = byName.get(dep);
    if (!childId) return { refused: `dependency ${dep} has no child task` };
    const got = headsOf(registry, childId, unit.repoKey);
    if (got === null) return { refused: `dependency ${dep}: child task ${childId} not found` };
    heads.push(...got);
  }
  if (heads.length === 0) return null;
  if (heads.length === 1) {
    const sha = await commitOf(repoPath, heads[0]!, git);
    if ('value' in sha) return { sha: sha.value };
    return {
      refused: `dependency head ${heads[0]!.replace(/^refs\/heads\//, '')}: ${'unknown' in sha ? sha.unknown : 'absent'}`,
    };
  }
  const merged = await mergeHeads(repoPath, heads, git);
  if (!('value' in merged))
    return {
      refused: `dependency heads merge: ${'unknown' in merged ? merged.unknown : 'absent'}`,
    };
  if (merged.value.kind === 'clean') return { sha: merged.value.commit };
  const pair = merged.value.between.map((h) => h.replace(/^refs\/heads\//, '')).join(' + ');
  return {
    refused: `dependency heads conflict: ${merged.value.files.join(', ')} (${pair})`,
  };
}
