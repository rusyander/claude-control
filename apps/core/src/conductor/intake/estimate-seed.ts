import type { EstimateFields, EstimateReply } from '@agentdeck/contracts/core/estimate';
import type { IntakeDecision, IntakeSource } from '@agentdeck/contracts/core/intake';
import type { ScenarioRef } from '@agentdeck/contracts/core/scenario';
import { resolveLeadSettings } from '../../economy/lead-settings/index.ts';
import { linesAfter } from '../../journal/read-view.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { textLines } from '../../platform/encoding.ts';
import type { LeadConfigRead } from '../classify/flow.ts';
import { leadSettingsFor } from '../classify/flow.ts';
import type { CreateSeed } from '../estimate/estimate.types.ts';
import { PROCESS_RULES } from '../lint/lint-rules.ts';
import { acceptanceProblem, cardFromSources } from './card.ts';
import { decideIntake, journalCard, journalIntakeDecision } from './judge.ts';
import type { AcceptanceRow } from './intake.types.ts';
import { recordedSessionWait } from './session-wait.ts';
import {
  maskedSource,
  sourceDigestOf,
  sourcesOf,
  structuredAcceptanceOf,
  trackerSourceProblem,
} from './source.ts';

/**
 * Приём на оценке (W2-6): у задачи ведущего (`lead`, `tracker-ticket@2`) — профиль в
 * `task.created.lead`, источники под маской DLP, структурные критерии — строками
 * `requirement.extracted{source:'ticket'}` (одна нумерация с разбором, P134), решение `intake` по
 * источникам и, когда понимать нечего, `intake.card{by:'auto'}` — шаг разбора тогда пропускается.
 * Тело источника — данные: ни одно его слово не меняет настройку или политику публикации; фразы,
 * которые просят сессию делать работу ядра, только показываются (`intake-lint`, P36).
 */

export const INTAKE_LINT_SIGNAL = 'intake-lint';
/** Карточка из источников не собралась (схема): её соберёт шаг разбора, причина — в детали. */
export const INTAKE_DEFERRED_SIGNAL = 'intake-deferred';
const LINT_TEXT_MAX = 200;

export type LeadEstimate =
  | { kind: 'not-lead' }
  | { kind: 'refused'; problem: string }
  | {
      kind: 'lead';
      seed: CreateSeed;
      replyLead(task: LiveTask | undefined): EstimateReply['lead'];
    };

/** Сценарий ведущего: `lead` любой версии, `tracker-ticket` со второй (первая заморожена). */
export function isLeadScenario(ref: ScenarioRef): boolean {
  return ref.id === 'lead' || (ref.id === 'tracker-ticket' && ref.version >= 2);
}

/** Строки источников, которые просят сессию сделать работу ядра: правило, строка, текст. */
function lintRows(sources: readonly IntakeSource[], request: string) {
  const out: { rule: string; source: string; line: number; text: string; instead: string }[] = [];
  const texts = [
    { name: 'request', text: request },
    ...sources.map((s, i) => ({ name: s.key ?? `${s.kind}#${i + 1}`, text: s.body })),
  ];
  for (const { name, text } of texts)
    textLines(text).forEach((line, index) => {
      for (const def of PROCESS_RULES) {
        if (!def.patterns.some((p) => p.test(line))) continue;
        const t = line.trim();
        out.push({
          rule: def.rule,
          source: name,
          line: index + 1,
          text: t.length > LINT_TEXT_MAX ? `${t.slice(0, LINT_TEXT_MAX - 1)}…` : t,
          instead: def.instead,
        });
      }
    });
  return out;
}

function journalAcceptance(task: LiveTask, sources: readonly IntakeSource[], cmdId: string) {
  const rows: AcceptanceRow[] = [];
  const seqs: number[] = [];
  structuredAcceptanceOf(sources).forEach((text, i) => {
    const id = newId();
    seqs.push(
      task.append({
        kind: 'requirement.extracted',
        actor: 'core',
        cmdId,
        data: { requirementId: id, ordinal: i + 1, text, source: 'ticket', stepId: null },
      }).seq,
    );
    rows.push({ id, text, source: 'ticket' });
  });
  return { rows, seqs };
}

/** Решение `intake` для карточки, которую источники не собрали: всегда «спросить», причина названа. */
function deferredDecision(
  sources: readonly IntakeSource[],
  alwaysAsk: boolean,
  why: string,
): IntakeDecision {
  return {
    verdict: 'ask',
    sourceKinds: sources.map((s) => s.kind),
    structuredAcceptance: structuredAcceptanceOf(sources).length,
    unknowns: 0,
    alwaysAsk,
    reasons: [why],
  };
}

/** Строки приёма после единицы 0: критерии, решение `intake`, карточка «сама», линт текста. */
function afterUnitZero(
  task: LiveTask,
  sources: readonly IntakeSource[],
  maskedRequest: string,
  read: LeadConfigRead,
  cmdId: string,
): void {
  const lint = lintRows(sources, maskedRequest);
  if (lint.length > 0)
    task.append({
      kind: 'signal',
      actor: 'core',
      cmdId,
      data: {
        signal: INTAKE_LINT_SIGNAL,
        severity: 'warn',
        subject: 'intake',
        detail: JSON.stringify(lint),
      },
    });
  // Без снимка (текст запроса) судить на оценке нечего: карточку соберёт шаг разбора.
  if (sources.length === 0) return;
  const { rows, seqs } = journalAcceptance(task, sources, cmdId);
  const built = cardFromSources(
    sources,
    rows,
    sourceDigestOf(sources, maskedRequest),
    maskedRequest,
  );
  const alwaysAsk = leadSettingsFor(task.state, read).settings.alwaysAsk;
  if (!built.ok) {
    const detail = `card from the source refused, the intake step builds it: ${built.issues.join('; ')}`;
    task.append({
      kind: 'signal',
      actor: 'core',
      cmdId,
      data: { signal: INTAKE_DEFERRED_SIGNAL, severity: 'warn', subject: 'intake', detail },
    });
    // Решение «спросить» без карточки всё равно пишется: источники задачи читают из него и класс
    // (пунктов столько же, сколько источников), и шаг разбора — без строки они пропали бы.
    journalIntakeDecision(
      task,
      deferredDecision(sources, alwaysAsk.includes('intake'), detail),
      null,
      seqs,
      undefined,
      sources,
    );
    return;
  }
  const decision = decideIntake({ sources, card: built.card, alwaysAsk });
  if (decision.verdict === 'ask')
    decision.reasons.push('the intake step builds the card after recon and asks once');
  const seq = journalIntakeDecision(task, decision, built.card, seqs, undefined, sources);
  if (decision.verdict === 'auto') journalCard(task, built.card, null, seq);
}

/**
 * Приём оценки: не ведущий — ничего; противоречие источников или трекер-сценарий без снимка
 * трекера — отказ 422 (задачи нет); иначе — дополнения создания.
 */
export function leadEstimate(
  fields: EstimateFields,
  ref: ScenarioRef,
  mask: (text: string) => string,
  read: LeadConfigRead,
): LeadEstimate {
  const got = sourcesOf(fields);
  if (!got.ok) return { kind: 'refused', problem: got.problem };
  // Снимок источника читает только приём ведущего: у прочих сценариев он пропал бы молча, а
  // человек считал бы, что задача видит тикет. Отказ с причиной — задачи нет, ничего не потеряно.
  if (!isLeadScenario(ref) && got.sources.length > 0)
    return {
      kind: 'refused',
      problem: `scenario ${ref.id}@${ref.version} does not read a source snapshot: use the lead scenario or tracker-ticket@2, or send the text as request`,
    };
  if (!isLeadScenario(ref)) return { kind: 'not-lead' };
  const sources = got.sources.map((s) => maskedSource(s, mask));
  const tracker = trackerSourceProblem(ref.id, ref.version, sources);
  if (tracker) return { kind: 'refused', problem: tracker };
  const overflow = acceptanceProblem(sources);
  if (overflow) return { kind: 'refused', problem: overflow };
  const maskedRequest = mask(fields.request);
  const machine = read.sessionSlots === undefined ? {} : { sessionSlots: read.sessionSlots };
  return {
    kind: 'lead',
    seed: {
      created: (pinned) => {
        const repoKey = pinned[0]?.repoKey ?? null;
        const settings = resolveLeadSettings({ section: read.section, repoKey, machine });
        // D25: `split` в `alwaysAsk` — та же политика `confirm`, что выбирает человек: деление ждёт
        // точку 10, даже если оценка просила `auto`. Пишется в `task.created` — журнал говорит, почему.
        const confirm = settings.settings.alwaysAsk.includes('split');
        return {
          lead: { profile: settings.settings.profile },
          ...(confirm ? { launchPolicy: 'confirm' as const } : {}),
        };
      },
      afterUnitZero: (task, _zero, cmdId) =>
        afterUnitZero(task, sources, maskedRequest, read, cmdId),
    },
    replyLead: (task) => leadReplyOf(task, read),
  };
}

/**
 * Блок `lead` ответа оценки по задаче: есть только у задачи ведущего (`task.created.lead`). Его
 * зовёт и первый ответ, и повтор того же `cmdId` — повтор без блока выглядел бы задачей не ведущего.
 */
export function leadReplyOf(
  task: LiveTask | undefined,
  read: LeadConfigRead,
): EstimateReply['lead'] {
  if (!task?.state.created?.lead) return undefined;
  const effective = leadSettingsFor(task.state, read);
  return {
    profile: effective.settings.profile,
    class: task.state.lead?.taskClass?.class ?? null,
    parallelism: effective.settings.parallelism,
    warnings: effective.warnings,
    // Записано на оценке (`lead-session-wait`): первый ответ и повтор читают одну строку.
    sessionWaitMs: recordedSessionWait(linesAfter(task.dir, task.taskId, 0)),
  };
}
