import type { Fact } from '@agentdeck/contracts/core/facts';
import type { JournalLine, RequirementVerdict } from '@agentdeck/contracts/core/journal';
import type { RedBeforeResult } from '@agentdeck/contracts/core/records';
import { evaluateGates, type GatesDecision } from '../../conductor/gates/index.ts';
import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import {
  applyExtraction,
  postStepFacts,
  requirementsInputOf,
  type PostStepFacts,
} from '../../conductor/requirements/index.ts';
import type { ConductorHooks, StepCtx } from '../../conductor/run/run.types.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';

/**
 * Зона C этапа 4 — требования: вердикты, ворота шага, сверка извлечения (P93). Зона подключает
 * свои крючки здесь и только здесь; `boot.ts` и `index.ts` она не трогает.
 *
 * - `preStep` — раздел брифа `requirements`: id, текст и текущий вердикт каждого пункта; шагу
 *   разбора и плана — что извлечь, шагу плана и ревью — что сверить (G3 G4).
 * - `postStep` — извлечение шага дописывается, если крах прервал `step_done` между `step.claimed`
 *   и `requirement.extracted` (запись идемпотентна); факты после шага (записи на текущем дереве,
 *   дифф единицы); суд требований — строка `decision` класса `requirements` и `requirement.verdict`
 *   на каждый изменившийся вердикт; суд ворот шага — строка `decision` класса `gates` (вход — строка
 *   решения требований). Решает следующий шаг `next` (зона B) по
 *   фактам — крючок ничего не останавливает, кроме сомнения: факты не прочитались — шаг стоит.
 *
 * «Красный до» пока не читается здесь (доказательство гонит исход проверок, зона B): ворото
 * `regression-red-before` закрыто с названной причиной, а не открыто молча.
 */

const MODULE = 'conductor/requirements';
const EXTRACTING = new Set(['intake', 'plan']);
const REVIEWING = new Set(['plan', 'review']);

export interface RequirementsHooksDeps extends ConductorWiringDeps {
  /** Доказательство «красный до» задачи (04:68-71); нет — ворото закрыто с причиной. */
  redBefore?: (taskId: string) => Promise<Fact<RedBeforeResult[]>>;
}

function bindingOf(s: StepCtx): SessionBinding {
  return {
    taskId: s.taskId,
    sessionId: s.sessionId ?? '',
    stepId: s.stepId,
    unitId: s.unitId,
    stepKind: s.def.kind,
  };
}

/** Последний записанный вердикт по id: вердикт выносит только судья, строки — его след. */
function journaledVerdicts(lines: readonly JournalLine[]): Map<string, RequirementVerdict> {
  const out = new Map<string, RequirementVerdict>();
  for (const line of lines)
    if (line.kind === 'requirement.verdict') {
      const d = line.data as { requirementId: string; verdict: RequirementVerdict };
      out.set(d.requirementId, d.verdict);
    }
  return out;
}

export function briefOf(lines: readonly JournalLine[], stepKind: string): string | null {
  const input = requirementsInputOf(lines);
  const verdicts = journaledVerdicts(lines);
  const rows = [...input.requirements]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((r) => `- R${r.ordinal} id ${r.id} [${verdicts.get(r.id) ?? 'open'}]: ${r.text}`);
  const notes: string[] = [];
  if (EXTRACTING.has(stepKind) && rows.length === 0)
    notes.push(
      'No requirements yet: list every point of the request or ticket in step_done.extracted; the core assigns the ids.',
    );
  if (REVIEWING.has(stepKind) && rows.length > 0)
    notes.push(
      'Compare this list with the source; report requirementsReview {complete, added} — an omitted point keeps the gate closed.',
    );
  if (rows.length > 0)
    notes.push(
      'Report each requirement by its id (never by R-number): covered with record ids, or n/a with a reason.',
    );
  if (rows.length === 0 && notes.length === 0) return null;
  return [...(rows.length > 0 ? ['Requirements:', ...rows] : []), ...notes].join('\n');
}

function journalJudgement(
  task: LiveTask,
  s: StepCtx,
  facts: PostStepFacts,
  previous: Map<string, RequirementVerdict>,
): number {
  const { input, decision } = facts;
  const inputs = [
    ...input.requirements.map((r) => r.seq),
    ...input.claims.map((c) => c.seq),
    ...input.reviews.map((r) => r.seq),
    ...input.waivers.map((w) => w.seq),
    ...input.derived.map((d) => d.seq),
  ];
  const line = task.append({
    kind: 'decision',
    actor: 'core',
    stepId: s.stepId,
    data: {
      decisionId: newId(),
      class: 'requirements',
      inputs: [...new Set(inputs)].sort((a, b) => a - b),
      facts: [
        { readClass: 'git.diff-unit', kind: 'value' },
        { readClass: 'check.records', kind: 'value' },
      ],
      numbers: { requirements: decision.requirements.length, changed: facts.changed.length },
      reasons: decision.missing,
      output: JSON.parse(JSON.stringify(decision)) as never,
    },
  });
  for (const r of decision.requirements) {
    // `waived` пишет только команда человека; судья его лишь повторяет.
    if (r.verdict === 'waived' || previous.get(r.id) === r.verdict) continue;
    if (!previous.has(r.id) && r.verdict === 'open') continue;
    task.append({
      kind: 'requirement.verdict',
      actor: 'core',
      stepId: s.stepId,
      data: {
        requirementId: r.id,
        verdict: r.verdict,
        evidence: r.evidence,
        reason: r.reason.slice(0, 2000),
        decisionSeq: line.seq,
      },
    });
  }
  return line.seq;
}

/**
 * Строка решения класса `gates`: вход — решение требований этого же шага (его строка), факты —
 * записи проверок и «красный до» с видом чтения; причины — каждое закрытое ворото (P01).
 */
function journalGates(
  task: LiveTask,
  s: StepCtx,
  gates: GatesDecision,
  requirementsSeq: number,
  redBefore: Fact<RedBeforeResult[]> | null,
): number {
  // «Красный до» выводится из записей проверок — отдельного класса чтения нет: вид чтения записей
  // худший из двух, если шагу нужно это ворото.
  let kind: 'value' | 'unknown' | 'absent' = 'value';
  if (redBefore !== null && !('value' in redBefore))
    kind = 'unknown' in redBefore ? 'unknown' : 'absent';
  return task.append({
    kind: 'decision',
    actor: 'core',
    stepId: s.stepId,
    data: {
      decisionId: newId(),
      class: 'gates',
      inputs: [requirementsSeq],
      facts: [{ readClass: 'check.records', kind }],
      numbers: { gates: s.def.gate.length, unmet: gates.unmet.length },
      reasons: gates.unmet.map((u) => `${u.kind}: ${u.reason}`),
      output: JSON.parse(JSON.stringify(gates)) as never,
    },
  }).seq;
}

export function requirementsHooks(deps: RequirementsHooksDeps): ConductorHooks {
  const lines = (task: LiveTask) => readJournalLines(task.dir, task.taskId).lines;
  return {
    async preStep(s) {
      const task = deps.registry.live(s.taskId);
      if (!task) return { verdict: { ok: true }, sections: [] };
      const text = briefOf(lines(task), s.def.kind);
      return {
        verdict: { ok: true },
        sections: text ? [{ id: 'requirements', text, from: MODULE }] : [],
      };
    },
    async postStep(s, claim) {
      const task = deps.registry.live(s.taskId);
      if (!task)
        return {
          verdict: {
            ok: false,
            stop: 'step',
            code: 'task-not-live',
            reason: `task ${s.taskId} is not live`,
          },
          facts: {},
        };
      // Крах между `step.claimed` и извлечением: дописать (идемпотентно по шагу).
      if (claim) applyExtraction(task, s.stepId, claim);
      const evidence = deps.verifier.verify.evidence;
      if (!evidence)
        return {
          verdict: {
            ok: false,
            stop: 'step',
            code: 'facts-unknown',
            reason: 'no evidence reader wired',
          },
          facts: {},
        };
      const before = lines(task);
      const facts = await postStepFacts(task, bindingOf(s), before, s.def.id, {
        records: deps.verifier.verify.records,
        evidence,
      });
      if (!('value' in facts))
        return {
          verdict: {
            ok: false,
            stop: 'step',
            code: 'facts-unknown',
            reason: 'unknown' in facts ? facts.unknown : 'absent',
          },
          facts: {},
        };
      const decisionSeq = journalJudgement(task, s, facts.value, journaledVerdicts(before));
      const needsRed = s.def.gate.some((g) => g.kind === 'regression-red-before');
      const redBefore: Fact<RedBeforeResult[]> =
        needsRed && deps.redBefore
          ? await deps.redBefore(s.taskId)
          : { unknown: 'red-before proof is not read by the requirements hook yet' };
      const gates = evaluateGates(s.def.gate, {
        ...facts.value.gates,
        stepDefId: s.def.id,
        redBefore,
      });
      const gatesDecisionSeq = journalGates(
        task,
        s,
        gates,
        decisionSeq,
        needsRed ? redBefore : null,
      );
      return {
        verdict: { ok: true },
        facts: {
          requirements: facts.value.decision,
          requirementsDecisionSeq: decisionSeq,
          gates,
          gatesDecisionSeq,
          changed: facts.value.changed,
        },
      };
    },
  };
}
