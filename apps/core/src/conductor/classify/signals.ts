import type { ClassSignals, ReconMap } from '@agentdeck/contracts/core/lead';
import type { CheckRegistry } from '@agentdeck/contracts/core/records';
import { matchesAny, toSlashes } from '../../lib/glob/glob.ts';
import { covers } from '../../verifier/key/index.ts';

/**
 * Признаки класса (W2-8, P135) — записанные факты, без regex (P32): файлы — карта разведки,
 * единицы и связи — реестр профиля (`registry.units[*].paths`/`consumes`), покрытие — проверки
 * `test-runner` над каждым файлом карты, риск — проверки миграции и контракта над файлом плюс
 * правила путей ниже (маска + причина, разрешённые строки), пункты — число источников.
 * Реестр не прочитан — единицы по верхним каталогам файлов, покрытие `null` (неизвестно, а не «нет»).
 */

export interface RiskPathRule {
  name: string;
  globs: readonly string[];
  why: string;
}

/** Разрешённые правила риска по пути (P32: строка = маска + причина). */
export const RISK_PATH_RULES: readonly RiskPathRule[] = [
  {
    name: 'migration',
    globs: ['**/migrations/**', '**/migrate/**', '**/*.sql'],
    why: 'schema migration: a wrong step damages stored data',
  },
  {
    name: 'ci-config',
    globs: ['.github/workflows/**', '.gitlab-ci.yml', '**/Jenkinsfile'],
    why: 'pipeline config: every later run of the repository depends on it',
  },
  {
    name: 'deploy',
    globs: ['**/helm/**', '**/terraform/**', '**/*.tf', '**/Dockerfile'],
    why: 'deployment definition: the change reaches running systems',
  },
  {
    name: 'access',
    globs: ['**/auth/**', '**/security/**', '**/permissions/**'],
    why: 'access control: a mistake opens or closes access',
  },
];

const RISK_CHECK_CLASSES: ReadonlySet<string> = new Set(['migration', 'contract']);

export interface SignalsInput {
  map: ReconMap | null;
  /** Реестр проверок репозитория; `null` — не прочитан. */
  registry: CheckRegistry | null;
  /** Пунктов источника (≥ 1: запрос без источника — один пункт). */
  items: number;
}

function filesOf(map: ReconMap | null): string[] {
  return [...new Set((map?.files ?? []).map((f) => toSlashes(f.path)))].sort();
}

/** Верхний каталог файла; файл в корне — `.`. */
function topDir(file: string): string {
  const slash = file.indexOf('/');
  return slash < 0 ? '.' : file.slice(0, slash);
}

function unitsOf(files: readonly string[], registry: CheckRegistry | null): string[] {
  if (!registry) return [...new Set(files.map(topDir))].sort();
  return Object.entries(registry.units)
    .filter(([, def]) => files.some((f) => def.paths.some((p) => covers(p, f))))
    .map(([name]) => name)
    .sort();
}

/**
 * Число тронутых единиц для класса: файлы вне всех единиц реестра — ещё одна (неизвестная)
 * единица. Иначе правка в единице A плюс файлы вне реестра считалась бы одной единицей и S
 * доставалось бы задаче, которая трогает две области.
 */
function unitCountOf(files: readonly string[], registry: CheckRegistry | null): number {
  const named = unitsOf(files, registry).length;
  if (!registry) return named;
  const defs = Object.values(registry.units);
  const outside = files.some((f) => !defs.some((def) => def.paths.some((p) => covers(p, f))));
  return named + (outside ? 1 : 0);
}

/** Связи между тронутыми единицами: единица потребляет другую тронутую. */
function crossDepsOf(units: readonly string[], registry: CheckRegistry | null): number {
  if (!registry) return 0;
  const touched = new Set(units);
  let edges = 0;
  for (const u of units)
    for (const dep of registry.units[u]?.consumes ?? []) if (dep !== u && touched.has(dep)) edges++;
  return edges;
}

function coveredOf(files: readonly string[], registry: CheckRegistry | null): boolean | null {
  if (!registry) return null;
  const runners = registry.checks.filter((c) => c.class === 'test-runner');
  if (runners.length === 0) return false;
  return files.every((f) => runners.some((c) => covers(c.cwd, f)));
}

function riskOf(files: readonly string[], registry: CheckRegistry | null): string[] {
  const out: string[] = [];
  for (const rule of RISK_PATH_RULES)
    if (files.some((f) => matchesAny(f, rule.globs))) out.push(`path:${rule.name}`);
  // Проверка контракта или миграции из корня (`cwd` '') «покрывает» любой файл: такой признак был
  // бы постоянным, и S не досталось бы ни одной задаче репозитория. Риск — только у проверки над
  // своим каталогом; миграции в корне ловят правила путей выше.
  for (const c of registry?.checks ?? [])
    if (RISK_CHECK_CLASSES.has(c.class) && c.cwd !== '' && files.some((f) => covers(c.cwd, f)))
      out.push(`check:${c.class}:${c.id}`.slice(0, 100));
  return [...new Set(out)].slice(0, 20);
}

export function classSignalsOf(input: SignalsInput): ClassSignals {
  const files = filesOf(input.map);
  const units = unitsOf(files, input.registry);
  return {
    files: files.length,
    units: unitCountOf(files, input.registry),
    crossUnitDeps: crossDepsOf(units, input.registry),
    checkCovered: coveredOf(files, input.registry),
    risk: riskOf(files, input.registry),
    items: Math.max(1, input.items),
  };
}

/** Тронутые единицы (имена) — область карточки приёма. */
export function touchedUnitsOf(map: ReconMap | null, registry: CheckRegistry | null): string[] {
  return unitsOf(filesOf(map), registry).slice(0, 20);
}

/** Причина правила риска по его имени (`path:<name>`), для причин решения. */
export function riskWhy(signal: string): string {
  const rule = RISK_PATH_RULES.find((r) => `path:${r.name}` === signal);
  return rule ? `${rule.name} (${rule.why})` : signal;
}
