import type { LeadRole } from '@agentdeck/contracts/core/lead';
import type { TierLadder, TierRung } from './tier.types.ts';

/**
 * Лестница модели и усилия (03 §Economy): ступень модели и усилия, подъём усилия плана, шаг на
 * ступень вверх (эскалация и обучение, этап 11). Имена ступеней — данные переходника; здесь только
 * два закреплённых спецификацией слова усилия: потолок подъёма и запрет. Сопоставление с шаблоном
 * маршрута приходит снаружи (`tier.ts`, P32 allow-list).
 */

/** Подъём усилия плана доходит до этой ступени, не выше (03:143). */
export const EFFORT_RAISE_CAP = 'xhigh';
/** Это усилие ядро само не выбирает никогда (03:143 «never max»): только правка человека. */
export const EFFORT_NEVER = 'max';

/** Виды шагов, которым уровень `raise-for-planning` поднимает усилие (03:142). */
export const PLANNING_KINDS: ReadonlySet<string> = new Set(['plan', 'split', 'research']);

/**
 * Роль ведущего по виду шага (P138, строки `learned.json` v2): строка профиля роли и ключ
 * обучения. `null` — у вида нет роли: шаги ядра без сессии и разговор человека (чат).
 */
const STEP_ROLE_OF: Readonly<Record<string, LeadRole>> = {
  intake: 'intake',
  research: 'recon',
  plan: 'plan',
  split: 'plan',
  work: 'implement',
  fix: 'implement',
  custom: 'implement',
  'answer-reviewers': 'implement',
  review: 'review',
  report: 'integrate',
};

export function defaultRoleOf(stepKind: string | undefined): LeadRole | null {
  return stepKind === undefined ? null : (STEP_ROLE_OF[stepKind] ?? null);
}

/**
 * Роль шага в куске плана (P138): шаги, которые кусок делает сам, несут роль куска
 * (`unit.created.role`); ревью судится строкой ревью — ревьюер не кусок, и механика его не
 * понижает, — кроме единицы сборки (D23: её ревью идёт с ролью `integrate`). Нет роли куска —
 * роль вида шага.
 */
export function stepRoleOf(
  unitRole: LeadRole | null | undefined,
  stepKind: string | undefined,
): LeadRole | null {
  const own = defaultRoleOf(stepKind);
  if (!unitRole) return own;
  return own === 'review' && unitRole !== 'integrate' ? own : unitRole;
}

/**
 * Ступень модели: точное имя или самое длинное семейство-префикс — среди имени ступени и её
 * других имён (`aliases`: алиас и полный id одной модели — одна ступень). `null` — модели нет на
 * лестнице (или модель по умолчанию CLI): сравнить нечем.
 */
export function modelRank(ladder: TierLadder | undefined, model: string | null): number | null {
  if (!ladder || model === null) return null;
  let rank: number | null = null;
  let len = -1;
  ladder.models.forEach((name, i) => {
    for (const entry of [name, ...(ladder.aliases?.[i] ?? [])]) {
      if (model !== entry && !model.startsWith(entry)) continue;
      if (entry.length > len) {
        rank = i;
        len = entry.length;
      }
    }
  });
  return rank;
}

export function effortRank(ladder: TierLadder | undefined, effort: string | null): number | null {
  if (!ladder || effort === null) return null;
  const rank = ladder.efforts.indexOf(effort);
  return rank < 0 ? null : rank;
}

/** Высшая ступень усилия, которую ядро вправе выбрать само: потолок подъёма, никогда запрет. */
export function topEffort(ladder: TierLadder | undefined): string | null {
  if (!ladder) return null;
  const cap = ladder.efforts.indexOf(EFFORT_RAISE_CAP);
  const allowed = ladder.efforts.filter((e, i) => e !== EFFORT_NEVER && (cap < 0 || i <= cap));
  return allowed[allowed.length - 1] ?? null;
}

/**
 * Потолок модели автоматики (P138): min(потолок задачи, `autoCeiling` переходника). Ранг `null` —
 * ни того, ни другого на лестнице: модель сама не поднимается, только усилие.
 */
export function autoCapRank(
  ladder: TierLadder | undefined,
  taskCeiling: string | null,
): number | null {
  const ranks = [modelRank(ladder, taskCeiling), modelRank(ladder, ladder?.autoCeiling ?? null)];
  const known = ranks.filter((r): r is number => r !== null);
  return known.length === 0 ? null : Math.min(...known);
}

/**
 * Потолок задачи на переходнике `adapter`. Имя ступени своей лестницы или имя ни одной лестницы
 * (модель, которую назвал человек) — как есть. Ступень ЧУЖОЙ лестницы (`opus` задачи на маршруте
 * codex `*`) дальше не идёт: при своих ступенях — та же доля лестницы (ранг вниз), без них —
 * потолка нет, CLI берёт свою модель (W3-D: имя модели claude уходило в `codex -m`).
 */
export function ceilingOn(
  ladders: Readonly<Record<string, TierLadder>> | undefined,
  adapter: string,
  ceiling: string | null,
): { ceiling: string | null; reason?: string } {
  if (ceiling === null) return { ceiling };
  const own = ladders?.[adapter];
  if (modelRank(own, ceiling) !== null) return { ceiling };
  for (const [other, ladder] of Object.entries(ladders ?? {})) {
    const rank = other === adapter ? null : modelRank(ladder, ceiling);
    if (rank === null) continue;
    const n = ladder.models.length;
    const rungs = own?.models ?? [];
    if (rungs.length === 0)
      return {
        ceiling: null,
        reason: `task ceiling ${ceiling} is a ${other} rung and ${adapter} has no model ladder: ignored on ${adapter}, the CLI default model runs`,
      };
    const mapped = rungs[
      n <= 1 ? rungs.length - 1 : Math.floor((rank * (rungs.length - 1)) / (n - 1))
    ] as string;
    return {
      ceiling: mapped,
      reason: `task ceiling ${ceiling} is a ${other} rung (${rank + 1}/${n}): on ${adapter} it maps by rank to ${mapped}`,
    };
  }
  return { ceiling };
}

export const rungLabel = (r: TierRung): string =>
  `${r.model ?? 'cli default'}·${r.effort ?? 'cli default'}`;

export interface RungStep {
  rung: TierRung;
  /** Выше подняться нечем: ступень та же, причина названа. */
  atCeiling: boolean;
  reason: string;
}

/**
 * Ступень вверх (D21, F1): усилие на ступень до потолка подъёма (`xhigh`, никогда `max`), затем
 * следующая модель лестницы под шаблоном маршрута, не выше потолка автоматики, с усилием роли
 * (`baseEffort`). Усилие по умолчанию CLI ступени не имеет — подъём ставит потолок подъёма. Выше
 * некуда — та же ступень, `atCeiling`. Поле, которое назвал человек (`lock`), не двигается.
 */
export function rungUp(
  ladder: TierLadder | undefined,
  from: TierRung,
  opts: {
    capRank: number | null;
    matches: (model: string) => boolean;
    baseEffort: string | null;
    lock?: { model?: boolean; effort?: boolean };
  },
): RungStep {
  const top = topEffort(ladder);
  const topRank = effortRank(ladder, top);
  const er = effortRank(ladder, from.effort);
  const effortFree = opts.lock?.effort !== true;
  if (ladder && effortFree && top !== null && topRank !== null && (er === null || er < topRank)) {
    const next = er === null ? top : (ladder.efforts[er + 1] as string);
    return { rung: { ...from, effort: next }, atCeiling: false, reason: `effort ${next}` };
  }
  if (opts.lock?.model === true)
    return {
      rung: from,
      atCeiling: true,
      reason: `потолок: model ${from.model} is the human pick`,
    };
  const mr = modelRank(ladder, from.model);
  if (!ladder || mr === null)
    return {
      rung: from,
      atCeiling: true,
      reason: `потолок: model ${from.model ?? 'cli default'} has no rank on the ladder`,
    };
  const cap = opts.capRank;
  const outside: string[] = [];
  for (let i = mr + 1; cap !== null && i <= cap && i < ladder.models.length; i += 1) {
    const model = ladder.models[i] as string;
    if (!opts.matches(model)) {
      outside.push(model);
      continue;
    }
    const base = opts.baseEffort;
    const baseRank = effortRank(ladder, base);
    const fitting = base !== null && baseRank !== null && baseRank <= (topRank ?? -1) ? base : top;
    const effort = effortFree ? fitting : from.effort;
    return { rung: { model, effort }, atCeiling: false, reason: `model ${model}` };
  }
  return {
    rung: from,
    atCeiling: true,
    reason: `потолок: ${ceilingWhy(ladder, from, mr, cap, outside)}`,
  };
}

/**
 * Что держит модель на месте — названо то, что держит на самом деле: шаблон маршрута (модели
 * выше есть под потолком, но шаблон их не пускает), потолок автоматики или верх лестницы.
 */
function ceilingWhy(
  ladder: TierLadder,
  from: TierRung,
  mr: number,
  cap: number | null,
  outside: readonly string[],
): string {
  const label = rungLabel(from);
  if (outside.length > 0)
    return `${label}: ${outside.join(', ')} above it under the auto ceiling are outside the route model pattern`;
  if (mr >= ladder.models.length - 1) return `${label} is the top of the ladder`;
  if (cap === null) return `${label}: the adapter names no auto ceiling, the model is not raised`;
  return `${label} is the auto ceiling (min of task ceiling and autoCeiling)`;
}
