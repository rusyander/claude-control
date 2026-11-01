import type { PrecedenceDecision } from '@agentdeck/contracts/core/decisions';
import {
  scenarioProblems,
  type Gate,
  type OverlayEntry,
  type Scenario,
  type StepDef,
  type StepNarrowing,
} from '@agentdeck/contracts/core/scenario';
import { resolveKey, type PrecedenceKey } from '../../policy/resolve/precedence.ts';
import type { NarrowLevel, OverlayLayer, OverlayResult } from './scenario.types.ts';

/**
 * Правки уровней 3–5 поверх сценария (00 §Precedence, G12, P65) — чистая функция, одна на все
 * дороги (запуск, оценка, редактор). Здесь только перекройка: какие шаги задеты, вставка шага
 * ядра. Суд каждого листа — ОДИН судья старшинства `policy/resolve/precedence.ts` (G1): уровень 3
 * (сценарий библиотеки или пресет) отвергается только за нарушение правил платформы, уровни 4
 * (файлы проекта) и 5 (слой пользователя) только сужают; расширение не молчит и не обрезается до
 * «ближайшего узкого» — человек видит, что файл просил и почему нет.
 */

/** Добавить шаг уровни 4/5 могут только шагом ядра: проверка или вопрос человеку — это сужение. */
const INSERTABLE: ReadonlySet<StepDef['kind']> = new Set(['check', 'ask-human']);

/** Лист сужения шага: ключ судьи, текущее значение шага, предложенное и как его применить. */
interface Leaf {
  key: PrecedenceKey;
  base: unknown;
  value: unknown;
  apply(step: StepDef, value: unknown): StepDef;
}

/** Каждый ключ сужения шага — своя строка с судом; порядок ключей фиксирован схемой. */
function leaves(step: StepDef, n: StepNarrowing): Leaf[] {
  const out: Leaf[] = [];
  const push = (key: PrecedenceKey, base: unknown, value: unknown, apply: Leaf['apply']) => {
    if (value !== undefined) out.push({ key, base, value, apply });
  };
  push('checks.mid', step.checks.mid, n.checks?.mid, (s, v) => ({
    ...s,
    checks: { ...s.checks, mid: v as StepDef['checks']['mid'] },
  }));
  push('checks.required', step.checks.required, n.checks?.required, (s, v) => ({
    ...s,
    checks: { ...s.checks, required: v as string[] },
  }));
  push('roundCap', step.roundCap, n.roundCap, (s, v) => ({ ...s, roundCap: v as number }));
  for (const field of ['tokens', 'minutes'] as const)
    push(`budget.${field}`, step.budget[field], n.budget?.[field], (s, v) => ({
      ...s,
      budget: { ...s.budget, [field]: v as number },
    }));
  push('overBudget', step.overBudget, n.overBudget, (s, v) => ({
    ...s,
    overBudget: v as StepDef['overBudget'],
  }));
  push('model.tier', step.model.tier, n.model?.tier, (s, v) => ({
    ...s,
    model: { ...s.model, tier: v as StepDef['model']['tier'] },
  }));
  push('model.routes', step.model.routes, n.model?.routes, (s, v) => ({
    ...s,
    model: { ...s.model, routes: v as NonNullable<StepDef['model']['routes']> },
  }));
  push('userLayer.hooks', step.userLayer.hooks, n.userLayer?.hooks, (s, v) => ({
    ...s,
    userLayer: { ...s.userLayer, hooks: v as StepDef['userLayer']['hooks'] },
  }));
  push('userLayer.skills', step.userLayer.skills, n.userLayer?.skills, (s, v) => ({
    ...s,
    userLayer: { ...s.userLayer, skills: v as StepDef['userLayer']['skills'] },
  }));
  push('gate', step.gate, n.gate, (s, v) => ({ ...s, gate: v as Gate[] }));
  return out;
}

/**
 * Строки одного пути от разных слоёв — одно решение старшинства на ключ: уровень 4 и 5 по одному
 * листу дают общую строку журнала, итог — у последнего принятого.
 */
function merge(into: Map<string, PrecedenceDecision>, d: PrecedenceDecision): void {
  const had = into.get(d.key);
  if (!had) {
    into.set(d.key, d);
    return;
  }
  into.set(d.key, {
    ...(d.applied.length > 0 ? d : had),
    applied: [...had.applied, ...d.applied],
    rejected: [...had.rejected, ...d.rejected],
  });
}

const entry = (
  level: 3 | NarrowLevel,
  path: string,
  value: unknown,
  reason: string,
): OverlayEntry => ({
  level,
  path,
  // Значение строки журнала — JSON: `undefined` в нём не живёт.
  value: (value === undefined ? null : value) as OverlayEntry['value'],
  reason: reason.slice(0, 1000),
});

/** Новый шаг ядра встаёт в цепочку: всё, что ждало его предшественников, ждёт и его. */
function insertStep(steps: StepDef[], added: StepDef): StepDef[] {
  const before = new Set(added.after);
  const spliced = steps.map((s) =>
    s.after.some((a) => before.has(a)) ? { ...s, after: [...s.after, added.id] } : s,
  );
  return [...spliced, added];
}

export function overlayScenario(base: Scenario, layers: readonly OverlayLayer[]): OverlayResult {
  const platform = scenarioProblems(base);
  if (platform.length > 0) {
    return {
      scenario: base,
      applied: [],
      rejected: platform.map((p) => entry(3, 'scenario', null, `platform rule: ${p}`)),
      refused: true,
      precedence: [],
    };
  }
  const label = `${base.id}@${base.version}`;
  const applied: OverlayEntry[] = [];
  const rejected: OverlayEntry[] = [];
  const decisions = new Map<string, PrecedenceDecision>();
  let steps = base.steps;
  // Уровень 4 раньше 5: оба только сужают, порядок даёт устойчивые строки, а не другой итог.
  const ordered4then5 = [...layers].sort((a, b) => a.level - b.level);
  for (const layer of ordered4then5) {
    const { level, source, file } = layer;
    if (file.ciWait !== undefined) {
      const d = resolveKey('ciWait', { level: 2, source: 'launch choice', value: null }, [
        { level, source, value: file.ciWait },
      ]);
      merge(decisions, d);
      for (const r of d.rejected)
        rejected.push(entry(level, 'ciWait', r.value, `${source}: ${r.why}`));
    }
    for (const [key, narrowing] of Object.entries(file.steps ?? {})) {
      const known = steps.map((s) => s.id);
      const targets = key === '*' ? known : known.filter((id) => id === key);
      if (targets.length === 0) {
        rejected.push(entry(level, `steps.${key}`, narrowing, `${source}: no step ${key}`));
        continue;
      }
      for (const id of targets) {
        const at = steps.findIndex((s) => s.id === id);
        let step = steps[at] as StepDef;
        for (const leaf of leaves(step, narrowing)) {
          const path = `steps.${id}.${leaf.key}`;
          const d = resolveKey(leaf.key, { level: 3, source: label, value: leaf.base }, [
            { level, source, value: leaf.value },
          ]);
          merge(decisions, { ...d, key: path });
          const row = d.applied[0];
          if (row) {
            step = leaf.apply(step, d.value);
            applied.push(entry(level, path, leaf.value, `${source}: ${row.note}`));
          } else {
            for (const r of d.rejected)
              rejected.push(entry(level, path, leaf.value, `${source}: ${r.why}`));
          }
        }
        steps = steps.map((s, i) => (i === at ? step : s));
      }
    }
    for (const added of file.insert ?? []) {
      const path = `insert.${added.id}`;
      if (!INSERTABLE.has(added.kind)) {
        rejected.push(
          entry(
            level,
            path,
            added,
            `${source}: only core steps check / ask-human may be added, not ${added.kind}`,
          ),
        );
        continue;
      }
      const next = insertStep(steps, added);
      const before = new Set(scenarioProblems({ ...base, steps }));
      const fresh = scenarioProblems({ ...base, steps: next }).filter((p) => !before.has(p));
      if (fresh.length > 0) {
        rejected.push(entry(level, path, added, `${source}: ${fresh.join('; ')}`));
        continue;
      }
      steps = next;
      applied.push(
        entry(
          level,
          path,
          added,
          `${source}: adds a ${added.kind} step after ${added.after.join(', ') || 'start'}`,
        ),
      );
    }
  }
  return {
    scenario: { ...base, steps },
    applied,
    rejected,
    refused: false,
    precedence: [...decisions.values()],
  };
}
