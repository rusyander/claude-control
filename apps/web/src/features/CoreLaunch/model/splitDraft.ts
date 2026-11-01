import type { SplitProblem, SplitProposal, UnitDraft } from './launch.types';

/**
 * Редактор деления (02:69): единицы предложения → черновик человека → поля `edit-split`. Здесь
 * только то, что видно без ядра (пустое имя, повтор имени, зависимость на несуществующую единицу,
 * на себя); пересечение путей и цикл судит ядро той же проверкой, что у плана (P39), — его отказ
 * экран показывает дословно.
 */

/** Предел единиц в одной правке — тот же, что у схемы `edit-split`. */
export const UNITS_MAX = 20;

const pathsOf = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

let counter = 0;
const nextKey = (): string => {
  counter += 1;
  return `u${counter}`;
};

export function draftOfSplit(split: SplitProposal): UnitDraft[] {
  return split.units.map((u) => ({
    key: nextKey(),
    name: u.name,
    ownedPaths: u.ownedPaths.join('\n'),
    deps: [...u.deps],
    repo: u.repoKey,
    contract: u.contract,
  }));
}

export function addUnit(units: readonly UnitDraft[], repo: string | null): UnitDraft[] {
  return [...units, { key: nextKey(), name: '', ownedPaths: '', deps: [], repo, contract: false }];
}

/** Удалённая единица уходит и из зависимостей остальных: висячая ссылка — отказ ядра. */
export function removeUnit(units: readonly UnitDraft[], key: string): UnitDraft[] {
  const gone = units.find((u) => u.key === key);
  return units
    .filter((u) => u.key !== key)
    .map((u) => (gone ? { ...u, deps: u.deps.filter((d) => d !== gone.name) } : u));
}

/** Переименование тянет за собой зависимости на прежнее имя — связь не рвётся молча. */
export function renameUnit(units: readonly UnitDraft[], key: string, name: string): UnitDraft[] {
  const before = units.find((u) => u.key === key)?.name;
  return units.map((u) => {
    if (u.key === key) return { ...u, name };
    if (before && u.deps.includes(before))
      return { ...u, deps: u.deps.map((d) => (d === before ? name : d)) };
    return u;
  });
}

export function patchUnit(
  units: readonly UnitDraft[],
  key: string,
  patch: Partial<Omit<UnitDraft, 'key' | 'name'>>,
): UnitDraft[] {
  return units.map((u) => (u.key === key ? { ...u, ...patch } : u));
}

export function toggleDep(units: readonly UnitDraft[], key: string, dep: string): UnitDraft[] {
  return units.map((u) => {
    if (u.key !== key) return u;
    return u.deps.includes(dep)
      ? { ...u, deps: u.deps.filter((d) => d !== dep) }
      : { ...u, deps: [...u.deps, dep] };
  });
}

export function splitProblems(units: readonly UnitDraft[]): SplitProblem[] {
  const out: SplitProblem[] = [];
  if (units.length === 0) out.push({ unitKey: null, code: 'no-units' });
  if (units.length > UNITS_MAX) out.push({ unitKey: null, code: 'too-many' });
  const names = new Map<string, number>();
  for (const u of units) {
    const n = u.name.trim();
    if (n) names.set(n, (names.get(n) ?? 0) + 1);
  }
  for (const u of units) {
    const name = u.name.trim();
    if (!name) out.push({ unitKey: u.key, code: 'name-empty' });
    else if ((names.get(name) ?? 0) > 1) out.push({ unitKey: u.key, code: 'name-duplicate' });
    if (pathsOf(u.ownedPaths).length === 0) out.push({ unitKey: u.key, code: 'paths-empty' });
    for (const dep of u.deps) {
      if (dep === name) out.push({ unitKey: u.key, code: 'dep-self' });
      else if (!names.has(dep)) out.push({ unitKey: u.key, code: 'dep-unknown' });
    }
  }
  return out;
}

export interface EditSplitUnit {
  name: string;
  ownedPaths: string[];
  deps: string[];
  repo: string | null;
  contract: boolean;
}

function unitsOf(units: readonly UnitDraft[]): EditSplitUnit[] {
  return units.map((u) => ({
    name: u.name.trim(),
    ownedPaths: pathsOf(u.ownedPaths),
    deps: [...u.deps],
    repo: u.repo,
    contract: u.contract,
  }));
}

/** Поля команды `edit-split`: все поля единицы названы (P42), пути — по строке без пустых. */
export function editSplitFields(
  splitId: string,
  units: readonly UnitDraft[],
): { splitId: string; units: EditSplitUnit[] } {
  return { splitId, units: unitsOf(units) };
}

/** Черновик разошёлся с предложением: запуск ждёт, пока правку сохранят или откатят. */
export function splitDirty(
  units: readonly UnitDraft[] | null,
  split: SplitProposal | null,
): boolean {
  if (!units || !split) return false;
  const proposed: EditSplitUnit[] = split.units.map((u) => ({
    name: u.name,
    ownedPaths: [...u.ownedPaths],
    deps: [...u.deps],
    repo: u.repoKey,
    contract: u.contract,
  }));
  return JSON.stringify(unitsOf(units)) !== JSON.stringify(proposed);
}
