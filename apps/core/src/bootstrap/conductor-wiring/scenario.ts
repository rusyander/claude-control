import type { StepDef } from '@agentdeck/contracts/core/scenario';
import type { SkillFlow, UserLayerInventory } from '@agentdeck/contracts/core/user-layer';
import type { BriefPartId } from '../../context/brief/index.ts';
import type {
  BriefSection,
  BriefSectionId,
  ConductorHooks,
  StepCtx,
} from '../../conductor/run/run.types.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';

/**
 * Зона A этапа 4 — сценарий: части брифа шага, которые знает сценарий (задача, шаг и его ворота,
 * знания ссылками). Уровень модели и продолжение (`decideTier`, `decideContinuation`) зовёт
 * исполнитель на старте сессии: у `preStep` шва нет места для маршрута (CONTRACT REQUEST
 * `routing`). Сборка и маска — `buildBrief` из `context/brief`, один раз над частями всех зон.
 */

/** Списки id шва и брифа обязаны совпасть: иначе часть одной зоны бриф не разместит. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const BRIEF_IDS_MATCH: Same<BriefSectionId, BriefPartId> = true;

const FROM = 'conductor/scenario';

/** Порядок шагов навыка по имени навыка — из описи слоя (`agentdeck.steps`, 02:33). */
export type SkillFlows = ReadonlyMap<string, SkillFlow>;
const NO_FLOWS: SkillFlows = new Map();

/**
 * Уровень 5 — только порядок шагов навыка (G4): опись слоя пользователя даёт `flow` навыков шага,
 * бриф раскладывает их в подшаги. Порт родителя (опись читает переходник); нет порта или описи —
 * остаётся место подшага из «Пути», как до фазы 7.
 */
export type ScenarioWiringDeps = ConductorWiringDeps & {
  userLayerInventory?(s: StepCtx): UserLayerInventory | null | Promise<UserLayerInventory | null>;
};

function gateLines(def: StepDef): string[] {
  return def.gate.map((g) => ('criterion' in g ? `- ${g.kind}: ${g.criterion}` : `- ${g.kind}`));
}

function flowLines(skillId: string, flow: SkillFlow): string[] {
  return [
    `skill ${skillId} steps, in order:`,
    ...flow.steps.map((st, i) => `  ${i + 1}. ${st.title} (${st.id})`),
  ];
}

/**
 * Место подшага в порядке навыка: шаг навыка узнаётся по заголовку (`after`), номер — запасной
 * путь, если заголовок переименовали; `index: -1` и пустой `after` — до первого шага (02:26).
 */
function withinLine(within: NonNullable<StepDef['within']>, flow: SkillFlow | undefined): string {
  const pathOnly =
    `this is sub-step ${within.index} of skill ${within.skillId}` +
    (within.after ? `, after "${within.after}"` : '');
  if (!flow) return pathOnly;
  if (within.index === -1 && !within.after)
    return `this sub-step goes before step 1 of skill ${within.skillId}`;
  const byTitle = within.after ? flow.steps.findIndex((st) => st.title === within.after) : -1;
  const at = byTitle >= 0 ? byTitle : within.index;
  const anchor = flow.steps[at];
  // Якорь не нашёлся ни по заголовку, ни по номеру — сказать прямо, а не угадать место.
  if (!anchor) return `${pathOnly} (not found in the skill's steps: place it by the text)`;
  return `this sub-step goes right after step ${at + 1} "${anchor.title}" of skill ${within.skillId}`;
}

function knowledgeLines(def: StepDef, flows: SkillFlows): string[] {
  const k = def.knowledge;
  const refs = [
    ...k.skills.map((id) => `skill ${id}`),
    ...k.rules.map((id) => `rule ${id}`),
    ...k.hooks.map((id) => `hook ${id}`),
    ...k.scripts.map((id) => `script ${id}`),
  ];
  const shown = new Set<string>();
  for (const id of [...k.skills, ...(def.within ? [def.within.skillId] : [])]) {
    const flow = flows.get(id);
    if (!flow || shown.has(id)) continue;
    shown.add(id);
    refs.push(...flowLines(id, flow));
  }
  if (def.within) refs.push(withinLine(def.within, flows.get(def.within.skillId)));
  return refs;
}

/** Порядки навыков описи; навык без `agentdeck.steps` порядка не даёт. */
export function skillFlowsOf(inventory: UserLayerInventory | null | undefined): SkillFlows {
  if (!inventory) return NO_FLOWS;
  return new Map(inventory.skills.flatMap((s) => (s.flow ? [[s.name, s.flow] as const] : [])));
}

/** Части сценария для шага; чистая — тест зовёт её без загрузки. */
export function scenarioSections(
  state: TaskFoldState,
  s: StepCtx,
  flows: SkillFlows = NO_FLOWS,
): BriefSection[] {
  const out: BriefSection[] = [];
  const title = state.created?.title;
  if (title) out.push({ id: 'task', text: title, from: FROM });
  const ref = state.scenario?.ref;
  const step = [
    `${s.def.title} (${s.def.kind}, step ${s.def.id}${ref ? ` of ${ref.id}@${ref.version}` : ''}, round ${s.round})`,
    ...(s.def.knowledge.text ? [s.def.knowledge.text] : []),
    ...(s.def.gate.length > 0 ? ['Done when:', ...gateLines(s.def)] : []),
  ];
  out.push({ id: 'step', text: step.join('\n'), from: FROM });
  const knowledge = knowledgeLines(s.def, flows);
  if (knowledge.length > 0) out.push({ id: 'knowledge', text: knowledge.join('\n'), from: FROM });
  return out;
}

export function scenarioHooks(deps: ScenarioWiringDeps): ConductorHooks {
  return {
    async preStep(s) {
      const state = deps.registry.view(s.taskId);
      if (!state)
        return {
          verdict: { ok: false, stop: 'step', code: 'task-unknown', reason: `no task ${s.taskId}` },
          sections: [],
        };
      // Опись не прочлась — шаг не стоит: бриф идёт с местом из «Пути», причина названа (F25).
      const read = await Promise.resolve()
        .then(() => deps.userLayerInventory?.(s))
        .then(
          (inv) => ({ flows: skillFlowsOf(inv), note: null }),
          (e: unknown) => ({
            flows: NO_FLOWS,
            note: `skill steps unknown: user layer inventory unread (${e instanceof Error ? e.message : String(e)})`,
          }),
        );
      const sections = scenarioSections(state, s, read.flows);
      const known = sections.find((x) => x.id === 'knowledge');
      if (read.note && known) known.text = `${known.text}\n${read.note}`;
      else if (read.note) sections.push({ id: 'knowledge', text: read.note, from: FROM });
      return { verdict: { ok: true }, sections };
    },
  };
}
