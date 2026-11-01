import type { PrecedenceDecision } from '@agentdeck/contracts/core/decisions';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import { WIDTH_ORDER } from '@agentdeck/contracts/core/scenario';
import type { AllowedSetResolution } from './resolve.types.ts';

/**
 * ОДИН судья старшинства (06 §Precedence, G1): значение ключа по уровням 1–5. Уровень 1 —
 * пол платформы, его не опустить никому; уровень 2 (живое решение человека) вправе расширить;
 * уровни 3–5 только сужают — расширение отвергнуто строкой с источником и причиной, никогда не
 * обрезано молча до «ближайшего узкого» (R:S2-18). Предложения судятся по возрастанию уровня
 * (устойчиво): итог не зависит от порядка, в котором дорога их собрала.
 *
 * Здесь же — суд каждого ключа: порядки ширины, числа, списки, CI-ожидание из файла. Сценарий
 * (`conductor/scenario/overlay.ts`) только перекраивает шаги и зовёт `resolveKey` по листу;
 * маршруты остаются своей функцией (`resolveAllowedRoutes`), а в журнал идут строкой этого же
 * решения (`routesPrecedence`).
 */

export type PrecedenceLevel = PrecedenceDecision['sourceLevel'];

/** Значение одного уровня: кто сказал и что. */
export interface PrecedenceValue {
  level: PrecedenceLevel;
  /** Для человека на экране запуска: `r1: .agentdeck/scenario.json`, `feature@1`. */
  source: string;
  value: unknown;
}

/** Пол платформы (уровень 1): итог не бывает шире. */
export interface PrecedenceFloor {
  source: string;
  value: unknown;
}

/** Ключи с судом ширины; путь вне таблицы — отказ с именем, не молчание. */
export const PRECEDENCE_KEYS = [
  ...(Object.keys(WIDTH_ORDER) as (keyof typeof WIDTH_ORDER)[]),
  'roundCap',
  'budget.tokens',
  'budget.minutes',
  'checks.required',
  'gate',
  'model.routes',
  'humanPoints',
  'ciWait',
] as const;
export type PrecedenceKey = (typeof PRECEDENCE_KEYS)[number];

/** Сравнение значений по смыслу, не по порядку ключей файла (`{criterion, kind}` = `{kind, …}`). */
export function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const rec = value as Record<string, unknown>;
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(rec[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const contains = (list: readonly unknown[], item: unknown): boolean =>
  list.some((x) => canon(x) === canon(item));

/** Итог суда одного предложения: принято (и во что превратилось значение) или отвергнуто. */
type Verdict = { ok: true; note: string; value: unknown } | { ok: false; why: string };

function ordered(order: readonly string[], base: string, value: string): Verdict {
  return order.indexOf(value) <= order.indexOf(base)
    ? { ok: true, note: `${base} → ${value}`, value }
    : { ok: false, why: `widening ${base} → ${value} (narrow-only order: ${order.join(' < ')})` };
}

/** Меньше — уже; нет предела у основы — любое число его вводит, то есть сужает. */
function numeric(base: number | undefined, value: number): Verdict {
  if (base === undefined) return { ok: true, note: `unbounded → ${value}`, value };
  return value <= base
    ? { ok: true, note: `${base} → ${value}`, value }
    : { ok: false, why: `widening ${base} → ${value} (only lower is allowed)` };
}

/** Список проверок и ворот: новое значение обязано содержать каждое прежнее. */
function superset(base: readonly unknown[], value: readonly unknown[]): Verdict {
  const dropped = base.filter((b) => !contains(value, b));
  return dropped.length === 0
    ? { ok: true, note: `${base.length} → ${value.length} items`, value }
    : { ok: false, why: `widening: drops ${dropped.map(canon).join(', ')}` };
}

/** Маршруты шага: только подмножество прежних (R:PR-16); нет списка у основы — сужает любой. */
function subset(base: readonly unknown[] | undefined, value: readonly unknown[]): Verdict {
  if (base === undefined) return { ok: true, note: `all allowed → ${value.length} routes`, value };
  const added = value.filter((v) => !contains(base, v));
  return added.length === 0
    ? { ok: true, note: `${base.length} → ${value.length} routes`, value }
    : { ok: false, why: `widening: adds ${added.map(canon).join(', ')}` };
}

/**
 * Пункты человека (06:7, пункт 5): ниже уровня 2 — только объединение. Убрать пункт нижний
 * уровень не может: предложение добавляет своё, прежнее остаётся (сужение — больше вопросов).
 */
function union(base: readonly unknown[] | undefined, value: readonly unknown[]): Verdict {
  const have = base ?? [];
  const added = value.filter((v) => !contains(have, v));
  const kept = have.filter((b) => !contains(value, b));
  const merged = [...have, ...added];
  const note =
    `adds ${added.length}` + (kept.length > 0 ? `, keeps ${kept.length} not listed by it` : '');
  return { ok: true, note, value: merged };
}

const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** Суд ключа: `value` уже `base` или равен — принять; шире — отвергнуть с причиной. */
function judge(key: PrecedenceKey, base: unknown, value: unknown): Verdict {
  switch (key) {
    case 'model.tier':
    case 'overBudget':
    case 'userLayer.hooks':
    case 'userLayer.skills':
    case 'checks.mid':
      return ordered(WIDTH_ORDER[key], String(base), String(value));
    case 'roundCap':
    case 'budget.tokens':
    case 'budget.minutes':
      return numeric(num(base), num(value) ?? Number.POSITIVE_INFINITY);
    case 'checks.required':
    case 'gate':
      return superset(list(base), list(value));
    case 'model.routes':
      return subset(base === undefined ? undefined : list(base), list(value));
    case 'humanPoints':
      return union(base === undefined ? undefined : list(base), list(value));
    case 'ciWait':
      // Ждать CI — живое решение человека для ЭТОЙ задачи (R:S1-09); файл его не ставит вовсе.
      return {
        ok: false,
        why: "CI wait is the user's live decision for this task (R:S1-09), never a file's",
      };
  }
}

/**
 * Значение ключа по уровням. `base` — значение, от которого судят (обычно уровень 2 или 3);
 * `offers` — прочие уровни; `floor` — пол платформы. Строки `applied`/`rejected` — по одной на
 * каждое предложение, в порядке уровней; пол, если он поднял итог, — своей строкой уровня 1.
 */
export function resolveKey(
  key: PrecedenceKey,
  base: PrecedenceValue,
  offers: readonly PrecedenceValue[],
  floor?: PrecedenceFloor,
): PrecedenceDecision {
  const applied: PrecedenceDecision['applied'] = [];
  const rejected: PrecedenceDecision['rejected'] = [];
  let value = base.value;
  let sourceLevel = base.level;
  let source = base.source;
  // Устойчивая сортировка: при равных уровнях строки остаются в порядке дороги.
  const ranked = [...offers].sort((a, b) => a.level - b.level);
  for (const offer of ranked) {
    const verdict: Verdict =
      offer.level <= 2
        ? // Уровень 2 вправе расширить; пол ниже его всё равно поднимет (суд пола после цикла).
          {
            ok: true,
            note: `live decision: ${canon(value)} → ${canon(offer.value)}`,
            value: offer.value,
          }
        : judge(key, value, offer.value);
    if (verdict.ok) {
      value = verdict.value;
      sourceLevel = offer.level;
      source = offer.source;
      applied.push({
        level: offer.level,
        source: offer.source,
        value: offer.value,
        note: verdict.note,
      });
    } else {
      rejected.push({
        level: offer.level,
        source: offer.source,
        value: offer.value,
        why: verdict.why,
      });
    }
  }
  if (floor) {
    // Итог обязан быть не шире пола: суд «пол → итог» тем же правилом ключа.
    const held = judge(key, floor.value, value);
    if (!held.ok) {
      rejected.push({
        level: sourceLevel,
        source,
        value,
        why: `below the platform floor (${floor.source}): ${held.why}`,
      });
      value = floor.value;
      sourceLevel = 1;
      source = floor.source;
      applied.push({ level: 1, source: floor.source, value, note: 'platform floor holds' });
    } else if (key === 'humanPoints') {
      // Объединение с полом: пункт платформы не снимает никто, итог — пол ∪ значение.
      const merged = union(list(floor.value), list(value));
      if (merged.ok && list(merged.value).length > list(value).length) {
        value = merged.value;
        applied.push({ level: 1, source: floor.source, value: floor.value, note: merged.note });
      }
    }
  }
  return { key, value, sourceLevel, source, applied, rejected };
}

/**
 * Набор маршрутов задачи — строкой того же решения (G1): `resolveAllowedRoutes` остаётся своей
 * функцией (одна на запуск и на суд `tier`), а журнал видит ОДНО решение `precedence` на
 * разрешение — ключи сценария и маршруты рядом. Причина строки маршрута уже начинается с
 * источника (`r1: .agentdeck/scenario.json: …`) — она идёт целиком, источник строки — уровень:
 * резать по «: » нельзя, двоеточие бывает и внутри имени источника.
 *
 * Строка маршрутов — проекция уже принятого решения набора (`resolveAllowedRoutes`), а не второй
 * судья старшинства: судья класса `precedence` один — `resolveKey` (P01).
 */
export type RoutesPrecedence = PrecedenceDecision & { key: 'routes' };

export function routesPrecedence(resolution: AllowedSetResolution): RoutesPrecedence {
  const level = (n: number): PrecedenceLevel => Math.min(5, Math.max(1, n)) as PrecedenceLevel;
  const applied = resolution.applied.map((e) => ({
    level: e.level,
    source: `level ${e.level}`,
    value: e.path,
    note: e.reason,
  }));
  const rejected = resolution.rejected.map((e) => ({
    level: e.level,
    source: `level ${e.level}`,
    value: e.path,
    why: e.reason,
  }));
  if (resolution.kind === 'refused')
    return {
      key: 'routes',
      value: null,
      sourceLevel: level(resolution.applied.at(-1)?.level ?? 2),
      source: resolution.reasons.join('; '),
      applied,
      rejected,
    };
  return {
    key: 'routes',
    value: resolution.allowedRoutes,
    sourceLevel: level(resolution.sourceLevel),
    source: `level ${resolution.sourceLevel}`,
    applied,
    rejected,
  };
}

/**
 * Набор маршрутов, уже разрешённый (`task.created.allowedRoutes` + `routesSourceLevel`), —
 * строкой решения: оценка и правки после создания видят тот же итог, что и запуск.
 */
export function allowedSetPrecedence(routes: readonly unknown[], level: number): RoutesPrecedence {
  const sourceLevel = Math.min(5, Math.max(1, level)) as PrecedenceLevel;
  return {
    key: 'routes',
    value: [...routes],
    sourceLevel,
    source: sourceLevel === 1 ? 'contour (platform)' : `level ${sourceLevel}`,
    applied: [],
    rejected: [],
  };
}

/** Значение строки журнала — JSON: `undefined` в нём не живёт (поле без предела — `null`). */
function jsonSafe(value: unknown): JournalJson {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (v === undefined ? null : v)),
  ) as JournalJson;
}

type JournalJson = JournalDataV1['decision']['output'];

/**
 * Данные строки `decision {class:'precedence'}` — ОДНА строка на разрешение (ключи сценария и
 * маршруты): оценка, правка сценария и деление пишут одинаковое решение одинаковых входов (P80).
 * `facts` — чтения, на которых стоит итог (файлы проекта, библиотека).
 */
export function precedenceDecisionData(
  keys: readonly PrecedenceDecision[],
  facts: readonly { readClass: string; kind: 'value' | 'absent' | 'unknown' }[],
): {
  class: 'precedence';
  inputs: number[];
  facts: { readClass: string; kind: 'value' | 'absent' | 'unknown' }[];
  numbers: Record<string, number>;
  reasons: string[];
  /** `{keys: PrecedenceDecision[]}` в форме JSON строки журнала. */
  output: { keys: JournalJson };
} {
  const rejected = keys.flatMap((k) => k.rejected.map((r) => `${k.key}: ${r.source}: ${r.why}`));
  return {
    class: 'precedence',
    inputs: [],
    facts: facts.map((f) => ({ readClass: f.readClass, kind: f.kind })),
    numbers: {
      keys: keys.length,
      applied: keys.reduce((n, k) => n + k.applied.length, 0),
      rejected: keys.reduce((n, k) => n + k.rejected.length, 0),
    },
    reasons: rejected.length > 0 ? rejected : ['every offer within its level'],
    output: { keys: jsonSafe([...keys]) },
  };
}
