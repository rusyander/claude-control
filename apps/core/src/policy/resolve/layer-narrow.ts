import type { HookMode, SkillMode } from '@agentdeck/contracts/core/user-layer';

/**
 * Слой пользователя шага против правила маршрута (контур, `layerRule`): побеждает более узкое —
 * то есть МЕНЬШЕ слоя пользователя в сессии. Направление обратно `WIDTH_ORDER` сценария
 * (там `on` — самое узкое: уровни 3-5 не вправе выключать слой человека, это его слой); здесь
 * сужает маршрут контура, которому чужой слой в сессии — риск: хуки off<observe<on, навыки off<on.
 * Нет правила — слой шага как есть (читателя правила контура пока нет, остаток R6).
 */

export interface StepLayer {
  hooks: HookMode;
  skills: SkillMode;
}

/** Правило маршрута: поле, которого нет, ничего не сужает. */
export type RouteLayerRule = Partial<StepLayer>;

export interface NarrowedLayer {
  layer: StepLayer;
  /** Каждое сужение названо: «hooks on → observe (route rule)». */
  narrowed: string[];
}

const HOOK_WIDTH: readonly HookMode[] = ['off', 'observe', 'on'];
const SKILL_WIDTH: readonly SkillMode[] = ['off', 'on'];

function narrower<T extends string>(order: readonly T[], step: T, rule: T | undefined): T {
  if (rule === undefined) return step;
  return order.indexOf(rule) < order.indexOf(step) ? rule : step;
}

export function narrowLayer(step: StepLayer, rule?: RouteLayerRule): NarrowedLayer {
  if (!rule) return { layer: { ...step }, narrowed: [] };
  const layer: StepLayer = {
    hooks: narrower(HOOK_WIDTH, step.hooks, rule.hooks),
    skills: narrower(SKILL_WIDTH, step.skills, rule.skills),
  };
  const narrowed: string[] = [];
  if (layer.hooks !== step.hooks)
    narrowed.push(`hooks ${step.hooks} → ${layer.hooks} (route rule)`);
  if (layer.skills !== step.skills)
    narrowed.push(`skills ${step.skills} → ${layer.skills} (route rule)`);
  return { layer, narrowed };
}
