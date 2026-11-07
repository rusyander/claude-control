import type { ReconMap, TaskClass } from '@agentdeck/contracts/core/lead';
import type { StepDoneCall } from '@agentdeck/contracts/core/model-tools';
import type { CheckRegistry } from '@agentdeck/contracts/core/records';
import {
  classSignalsOf,
  decideClass,
  humanClassOf,
  journalClass,
  lastClassDecision,
  leadConfigOf,
  leadSettingsFor,
  proposeSoloIfDue,
  touchedUnitsOf,
} from '../../conductor/classify/index.ts';
import { chatOpeningOf } from '../../conductor/estimate/index.ts';
import { raiseHumanPoint } from '../../conductor/human/raise.ts';
import { isLedTask } from '../../conductor/split/index.ts';
import {
  cardFromClaim,
  classAsk,
  decideIntake,
  intakeAsk,
  intakeSourcesOf,
  journalCard,
  journalIntakeDecision,
  sourceDigestOf,
  type AcceptanceRow,
} from '../../conductor/intake/index.ts';
import type {
  BriefSection,
  ConductorHooks,
  HookVerdict,
  StepCtx,
} from '../../conductor/run/run.types.ts';
import { previousAttemptPart, reconMapPart } from '../../context/brief/index.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';
import type { SplitEnv } from '../../conductor/estimate/index.ts';
import { splitEnvFor } from './split.ts';

/**
 * Зона F этапа 11 — ведущий: приём (W2-6), карта разведки (W2-7), класс и форма (W2-8). Крючки
 * подключаются здесь и только здесь (порядок — `ZONE_ORDER`, после требований: строки требований
 * шага разбора уже записаны, когда собирается карточка).
 *
 * - `preStep` — карта разведки в бриф плана (и работы, если плана не было), прошлая попытка шага,
 *   поднятого после провала (W2-10: запись провала по id, не пересказ).
 * - `postStep` разведки — признаки по карте и реестру профиля → суд класса (`classify`), вопрос
 *   класса при `classify` в `alwaysAsk`, деление «одна единица», если класс снял план.
 * - `postStep` разбора — карточка из заявления → суд приёма (`intake`): сама или ОДИН вопрос.
 *
 * Работают только у задач ведущего (`task.created.lead` — его пишет оценка `lead` и
 * `tracker-ticket@2`): у прочих сценариев форма не меняется.
 */

const ok: HookVerdict = { ok: true };
const SHAPED_KINDS = new Set(['plan', 'work']);

function mapOf(state: TaskFoldState): { map: ReconMap; stepId: string } | null {
  let best: { seq: number; map: ReconMap; stepId: string } | null = null;
  for (const [stepId, step] of Object.entries(state.steps)) {
    const map = step.claim?.call.map;
    if (step.stepKind === 'research' && map && (!best || step.claim!.seq > best.seq))
      best = { seq: step.claim!.seq, map, stepId };
  }
  return best ? { map: best.map, stepId: best.stepId } : null;
}

function planRan(state: TaskFoldState): boolean {
  return Object.values(state.steps).some((s) => s.stepKind === 'plan' && s.state === 'done');
}

async function registryOf(
  deps: ConductorWiringDeps,
  task: LiveTask,
): Promise<CheckRegistry | null> {
  const repo = task.state.created?.repos[0];
  if (!repo) return null;
  const profile = await deps.verifier.profile.profileOf(repo);
  return 'value' in profile ? profile.value.registry : null;
}

function rowsOf(state: TaskFoldState): AcceptanceRow[] {
  return Object.entries(state.requirements)
    .sort((a, b) => a[1].ordinal - b[1].ordinal)
    .map(([id, r]) => ({ id, text: r.text, source: r.source }));
}

/** Карта и прошлая попытка в бриф шага. */
function briefSections(task: LiveTask, s: StepCtx): BriefSection[] {
  const out: BriefSection[] = [];
  const found = mapOf(task.state);
  if (found && SHAPED_KINDS.has(s.def.kind) && (s.def.kind === 'plan' || !planRan(task.state))) {
    const part = reconMapPart(found.map, found.stepId);
    if (part) out.push(part);
  }
  const tier = s.routing?.tier;
  const cause = tier?.ok ? tier.escalation?.cause : undefined;
  if (tier?.ok && cause) {
    const part = previousAttemptPart({
      stepId: cause.stepId,
      recordId: cause.recordId,
      why: cause.why === 'red-check' ? 'a check went red' : 'a lowered tier failed this step',
      tier: [tier.model, tier.effort].filter((x) => x !== null).join(' ') || null,
    });
    if (part) out.push(part);
  }
  return out;
}

/** Суд класса и, если нужно, вопрос класса; возвращает решённый класс. */
function judgeClass(
  task: LiveTask,
  deps: ConductorWiringDeps,
  input: { map: ReconMap | null; registry: CheckRegistry | null; proposal: TaskClass | null },
  inputs: readonly number[],
  stepId: string,
): TaskClass {
  const settings = leadSettingsFor(task.state, leadConfigOf(deps.layout)).settings;
  const items = Math.max(1, intakeSourcesOf(task).length);
  const signals = classSignalsOf({ map: input.map, registry: input.registry, items });
  // Человек уже назвал класс — его ответ остаётся входом и повторного суда: модель ниже него не
  // опустит, и второй вопрос о том же не нужен.
  const human = humanClassOf(task.state, task.taskId);
  const decision = decideClass({
    signals,
    thresholds: settings.classThresholds,
    proposal: input.proposal,
    human,
  });
  journalClass(task, decision, inputs, stepId);
  if (human === null && settings.alwaysAsk.includes('classify'))
    raiseHumanPoint(
      task,
      classAsk(task.taskId, decision.class, decision.reasons.join('; '), task.state.created?.lang),
    );
  return decision.class;
}

async function afterRecon(
  task: LiveTask,
  deps: ConductorWiringDeps,
  env: () => SplitEnv,
  s: StepCtx,
  claim: StepDoneCall | null,
): Promise<Record<string, unknown>> {
  const map = claim?.map ?? null;
  // Карты нет — класса нет: судить по пустому списку файлов значило бы «S» без единого признака.
  if (!map) return { lead: 'recon step reported no map: the class stays undecided' };
  const registry = await registryOf(deps, task);
  const seq = task.state.steps[s.stepId]?.claim?.seq;
  const cls = judgeClass(
    task,
    deps,
    { map, registry, proposal: claim?.classProposal ?? null },
    seq === undefined ? [] : [seq],
    s.stepId,
  );
  const solo = await proposeSoloIfDue(task, env(), {
    stepId: s.stepId,
    defId: s.def.id,
  });
  return { taskClass: cls, solo: solo?.kind ?? null };
}

async function afterIntake(
  task: LiveTask,
  deps: ConductorWiringDeps,
  env: () => SplitEnv,
  s: StepCtx,
  claim: StepDoneCall,
): Promise<{ verdict: HookVerdict; facts: Record<string, unknown> }> {
  const state = task.state;
  const sources = intakeSourcesOf(task);
  const found = mapOf(state);
  const registry = await registryOf(deps, task);
  const units = touchedUnitsOf(found?.map ?? null, registry);
  const digest = sourceDigestOf(sources, chatOpeningOf(task) ?? state.created?.title ?? '');
  const built = cardFromClaim(claim, found?.map ?? null, rowsOf(state), units, digest);
  if (!built.ok)
    return {
      verdict: {
        ok: false,
        stop: 'step',
        code: 'intake-card-refused',
        reason: built.issues.join('; '),
      },
      facts: {},
    };
  const settings = leadSettingsFor(state, leadConfigOf(deps.layout)).settings;
  const decision = decideIntake({ sources, card: built.card, alwaysAsk: settings.alwaysAsk });
  const claimSeq = state.steps[s.stepId]?.claim?.seq;
  const inputs = claimSeq === undefined ? [] : [claimSeq];
  const decisionSeq = journalIntakeDecision(task, decision, built.card, inputs, s.stepId, sources);
  // Модель подняла класс на разборе: повторный суд над теми же признаками (понизить не может).
  const proposal = claim.classProposal ?? null;
  const last = lastClassDecision(task);
  if (proposal !== null && last !== null && proposal !== last.class)
    judgeClass(task, deps, { map: found?.map ?? null, registry, proposal }, inputs, s.stepId);
  if (decision.verdict === 'ask') {
    const raised = raiseHumanPoint(task, intakeAsk(task.taskId, built.card, state.created?.lang));
    return { verdict: ok, facts: { intake: 'ask', ask: raised.kind } };
  }
  journalCard(task, built.card, null, decisionSeq);
  const solo = await proposeSoloIfDue(task, env(), {
    stepId: s.stepId,
    defId: s.def.id,
  });
  return { verdict: ok, facts: { intake: 'auto', solo: solo?.kind ?? null } };
}

export function leadHooks(deps: ConductorWiringDeps): ConductorHooks {
  return leadHooksWith(deps, () => splitEnvFor(deps));
}

/** Те же крючки над данной средой деления (тест подставляет стенд зоны D, как `splitHooksWith`). */
export function leadHooksWith(deps: ConductorWiringDeps, env: () => SplitEnv): ConductorHooks {
  return {
    async preStep(s) {
      const task = deps.registry.live(s.taskId);
      if (!task) return { verdict: ok, sections: [] };
      // Прошлая попытка — любой задаче; карта — только задаче ведущего (её нет у прочих).
      return { verdict: ok, sections: briefSections(task, s) };
    },
    async postStep(s, claim) {
      const task = deps.registry.live(s.taskId);
      if (!isLedTask(task) || task.state.task !== 'estimating') return { verdict: ok, facts: {} };
      if (s.def.kind === 'research')
        return { verdict: ok, facts: await afterRecon(task, deps, env, s, claim) };
      if (s.def.kind === 'intake' && claim && !task.state.lead?.card)
        return afterIntake(task, deps, env, s, claim);
      return { verdict: ok, facts: {} };
    },
  };
}
