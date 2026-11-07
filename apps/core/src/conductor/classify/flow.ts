import type { LeadSection } from '@agentdeck/contracts/core/lead';
import type { LiveTask } from '../../journal/resume.ts';
import { readCoreConfig } from '../../platform/core-config/read.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import {
  resolveLeadSettings,
  type EffectiveLeadSettings,
} from '../../economy/lead-settings/index.ts';
import type { SplitEnv } from '../estimate/estimate.types.ts';
// Не `intake/index.ts`: приём на оценке (`estimate-seed`) сам читает настройки отсюда — кольца нет.
import { settleIntakeAnswer } from '../intake/judge.ts';
import { classAnswerOf, classifyDedupe, intakeDedupe } from '../intake/questions.ts';
import { resolveScenario } from '../scenario/index.ts';
import { afterAccept, deliverableOf, proposeSplit } from '../split/index.ts';
import type { AfterAccept } from '../split/split.types.ts';
import { decideClass } from './classify.ts';
import { journalClass, lastClassDecision, proposalOf } from './journal.ts';
import { soloSplitDue, soloUnitOf } from './shape.ts';

/**
 * Ход ведущего вне крючков шага (W2-6, W2-8): действующие настройки задачи с её профилем, ответ
 * человека на вопрос карточки или класса и деление «одна единица», когда класс снял план. Зовут
 * крючки ведущего (`bootstrap/conductor-wiring/lead.ts`) и команда ответа (`commands/answer.ts`).
 */

/** Раздел `lead` настройки ядра и политика машины, как их прочёл вызывающий. */
export interface LeadConfigRead {
  section: LeadSection | undefined;
  sessionSlots?: number;
}

/** Раздел `lead` и `queue.sessionSlots` из настройки ядра; не прочиталась — одни умолчания. */
export function leadConfigOf(layout: Pick<CoreHomeLayout, 'config'>): LeadConfigRead {
  const read = readCoreConfig(layout);
  if (!('value' in read)) return { section: undefined };
  const { lead, queue } = read.value.doc;
  const slots = queue?.sessionSlots;
  return { section: lead, ...(typeof slots === 'number' ? { sessionSlots: slots } : {}) };
}

/**
 * Действующие настройки задачи: профиль, с которым её запустили (`task.created.lead.profile`),
 * стоит профилем её проекта — смена умолчаний машины посреди задачи её профиль не меняет.
 */
export function leadSettingsFor(
  state: TaskFoldState | null,
  read: LeadConfigRead,
): EffectiveLeadSettings {
  const created = state?.created ?? null;
  const repoKey = created?.repos[0]?.repoKey ?? null;
  const pinned = created?.lead?.profile;
  const section = read.section;
  const project = repoKey === null ? undefined : section?.projects?.[repoKey];
  const pinnedSection: LeadSection | undefined =
    pinned && repoKey !== null
      ? {
          ...section,
          projects: { ...section?.projects, [repoKey]: { ...project, profile: pinned } },
        }
      : section;
  return resolveLeadSettings({
    section: pinnedSection,
    repoKey,
    machine: read.sessionSlots === undefined ? {} : { sessionSlots: read.sessionSlots },
  });
}

/**
 * Деление «одна единица» от ядра, когда всё, что осталось до точки деления, пропускается (S без
 * плана). Не нужно — `null`; иначе — политика запуска после принятого деления.
 */
export async function proposeSoloIfDue(
  task: LiveTask,
  env: SplitEnv,
  current: { stepId: string | null; defId: string | null },
): Promise<AfterAccept | { kind: 'refused'; reasons: string[] } | null> {
  const created = task.state.created;
  if (!created) return null;
  const ref = task.state.scenario?.ref ?? created.scenario;
  const got = await resolveScenario(ref, created.repos, { libraryDir: env.libraryDir });
  if (!got.ok || !soloSplitDue(task.state, got.scenario, current.defId)) return null;
  const outcome = proposeSplit(
    task,
    soloUnitOf(task.state),
    { by: 'core', stepId: current.stepId },
    { deliverable: deliverableOf(ref.id, null) },
    env,
  );
  if (outcome.decision.verdict !== 'accepted')
    return { kind: 'refused', reasons: outcome.decision.reasons };
  return afterAccept(task, outcome, env);
}

/** Ответ человека на вопрос ведущего (`intake:` / `classify:`); чужой вопрос — `undefined`. */
export async function settleLeadAnswer(
  task: LiveTask,
  ask: { askId: string; dedupe: string | null; answer: string; cause: number },
  env: SplitEnv | undefined,
  read: LeadConfigRead,
): Promise<string | undefined> {
  let settled: string | undefined;
  if (ask.dedupe === intakeDedupe(task.taskId)) {
    settled = settleIntakeAnswer(task, ask);
    if (settled === 'stop') return settled;
  } else if (ask.dedupe === classifyDedupe(task.taskId)) {
    const human = classAnswerOf(ask.answer);
    const last = lastClassDecision(task);
    if (!human || !last) return undefined;
    const thresholds = leadSettingsFor(task.state, read).settings.classThresholds;
    journalClass(
      task,
      decideClass({ signals: last.signals, thresholds, proposal: proposalOf(last), human }),
      [ask.cause],
    );
    settled = human;
  } else return undefined;
  if (env) await proposeSoloIfDue(task, env, { stepId: null, defId: null });
  return settled;
}
