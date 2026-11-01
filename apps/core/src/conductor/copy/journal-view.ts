import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { BASE_PIN_SIGNAL, parseBasePin } from '../estimate/base-pin.ts';
import type { CopySetupDecision } from './copy.types.ts';

/**
 * Что настройке копии нужно из журнала задачи и чего нет в свёртке: репозиторий единицы
 * (`unit.created` — свёртка держит только состояние и ветку), закреплённая база
 * (`task.created.repos[].baseRef`), уже записанные решение `copy-setup` и ресурс копии.
 * Журнал — истина (01 §State), поэтому читается он, а не память процесса: после краха её нет.
 */

export interface UnitRepo {
  unitId: string;
  repoKey: string;
  branch: string;
  /** Основная копия репозитория. */
  path: string;
  baseRef: string;
  /**
   * Ссылка, от которой приколота база (`signal base-pin`: `origin/main`, `origin/<ветка MR>`);
   * `baseRef` — только её sha. Нет строки (задача не из оценки) — `undefined`.
   */
  pinnedRef?: string;
}

export function unitRepoOf(task: LiveTask, unitId: string): UnitRepo | { missing: string } {
  let unit: { repoKey: string; branch: string } | undefined;
  let repos: { repoKey: string; path: string; baseRef: string }[] = [];
  const pins = new Map<string, string>();
  for (const line of readJournalLines(task.dir, task.taskId).lines) {
    if (line.kind === 'task.created') {
      repos = (line.data as { repos: typeof repos }).repos;
    } else if (line.kind === 'unit.created') {
      const data = line.data as { unitId: string; repoKey: string; branch: string };
      if (data.unitId === unitId) unit = { repoKey: data.repoKey, branch: data.branch };
    } else if (line.kind === 'signal') {
      const s = line.data as { signal: string; subject: string; detail: string };
      const pin = s.signal === BASE_PIN_SIGNAL ? parseBasePin(s.detail) : null;
      if (pin) pins.set(s.subject, pin.ref);
    }
  }
  if (!unit) return { missing: `unit ${unitId}: no unit.created` };
  const key = unit.repoKey;
  const repo = repos.find((r) => r.repoKey === key);
  if (!repo) return { missing: `unit ${unitId}: repo ${unit.repoKey} not in task.created` };
  return {
    unitId,
    repoKey: unit.repoKey,
    branch: unit.branch,
    path: repo.path,
    baseRef: repo.baseRef,
    ...(pins.has(key) ? { pinnedRef: pins.get(key) as string } : {}),
  };
}

/**
 * Последнее решение `copy-setup` по единице: есть — настройка не повторяется при возобновлении,
 * а дирижёр отдаёт шагу записанное (хвост провала переживает перезапуск ядра). Провал на
 * создании копии в расчёт не идёт: настройки тогда не было вовсе, и копия, вставшая на повторе,
 * настраивается, а не получает старое «failed at create».
 */
export function journaledSetup(task: LiveTask, unitId: string): CopySetupDecision | undefined {
  let out: CopySetupDecision | undefined;
  for (const line of readJournalLines(task.dir, task.taskId).lines) {
    const data = line.data as { class?: string; output?: unknown };
    if (line.kind !== 'decision' || line.unitId !== unitId || data.class !== 'copy-setup') continue;
    const decision = data.output as CopySetupDecision;
    if (decision.failure?.stage !== 'create') out = decision;
  }
  return out;
}

/** Запись ресурса копии по каталогу: rid, единица-владелец и не снят ли он уже. */
export function copyResourceOf(
  task: LiveTask,
  dir: string,
  same: (a: string, b: string) => boolean,
): { rid: string; unitId: string | undefined; released: boolean } | undefined {
  let found: { rid: string; unitId: string | undefined; released: boolean } | undefined;
  for (const line of readJournalLines(task.dir, task.taskId).lines) {
    if (line.kind === 'resource.created') {
      const data = line.data as { rid: string; kind: string; ref: string };
      if (data.kind !== 'copy') continue;
      let worktree: unknown;
      try {
        worktree = (JSON.parse(data.ref) as { worktree?: unknown }).worktree;
      } catch {
        continue; // ref копии сессии в другой форме — не наша запись
      }
      if (typeof worktree === 'string' && same(worktree, dir))
        found = { rid: data.rid, unitId: line.unitId, released: false };
    } else if (line.kind === 'resource.released' && found) {
      if ((line.data as { rid: string }).rid === found.rid) found.released = true;
    }
  }
  return found;
}

/**
 * Живая копия единицы по журналу (`resource.created` вида `copy` с её `unitId`, не снятая): cwd
 * шагов и проверок единицы. Исполнитель (зона B) и крючки зоны F читают её отсюда, а не из памяти
 * процесса — после перезапуска ядра памяти нет. Нет копии — `undefined`.
 */
export function unitCopyOf(
  task: LiveTask,
  unitId: string,
): { rid: string; dir: string; repo: string } | undefined {
  let found: { rid: string; dir: string; repo: string } | undefined;
  for (const line of readJournalLines(task.dir, task.taskId).lines) {
    if (line.kind === 'resource.created' && line.unitId === unitId) {
      const data = line.data as { rid: string; kind: string; ref: string };
      if (data.kind !== 'copy') continue;
      try {
        const ref = JSON.parse(data.ref) as { worktree?: unknown; repo?: unknown };
        if (typeof ref.worktree === 'string' && typeof ref.repo === 'string')
          found = { rid: data.rid, dir: ref.worktree, repo: ref.repo };
      } catch {
        // ref копии сессии в другой форме — не копия единицы
      }
    } else if (line.kind === 'resource.released' && found) {
      if ((line.data as { rid: string }).rid === found.rid) found = undefined;
    }
  }
  return found;
}

interface CopyAttempt {
  actionId: string;
  target: string;
  idempotencyHint: string;
}

/** Начатые действия `copy-create` единицы в порядке журнала. */
function copyAttempts(task: LiveTask, unitId: string): CopyAttempt[] {
  const out: CopyAttempt[] = [];
  for (const line of readJournalLines(task.dir, task.taskId).lines) {
    const data = line.data as Partial<CopyAttempt> & { kind?: string };
    if (line.kind === 'action.started' && line.unitId === unitId && data.kind === 'copy-create')
      out.push(data as CopyAttempt);
  }
  return out;
}

/**
 * Каталог копии — выкладка ЭТОЙ единицы: в журнале есть её более ранняя попытка `copy-create` на
 * тот же каталог (`action.started` пишется до эффекта). Нет — каталог не наш, что бы ни лежало
 * на диске: недовыложенное или целое рабочее дерево человека ядро не снимает и не присваивает.
 */
export function ownCopyAttempt(
  task: LiveTask,
  unitId: string,
  dir: string,
  currentActionId: string,
  same: (a: string, b: string) => boolean,
): boolean {
  return copyAttempts(task, unitId).some(
    (a) => a.actionId !== currentActionId && same(a.target, dir),
  );
}

/**
 * База, закреплённая первой попыткой единицы (sha из `idempotencyHint` = `<ветка>@<sha>`):
 * повтор после краха встаёт от неё же, даже если ревизия-имя `baseRef` с тех пор сдвинулась.
 */
export function pinnedBaseOf(task: LiveTask, unitId: string): string | undefined {
  const first = copyAttempts(task, unitId)[0];
  if (!first) return undefined;
  const sha = first.idempotencyHint.slice(first.idempotencyHint.lastIndexOf('@') + 1);
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
}
