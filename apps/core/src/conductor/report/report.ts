import { join } from 'node:path';
import {
  FINAL_REPORT_SUGGESTIONS,
  finalReportSchema,
  type FinalReport,
  type FinalReportSuggestion,
} from '@agentdeck/contracts/core/report';
import type { RequirementVerdict } from '@agentdeck/contracts/core/journal';
import { sha256OfText } from '../../journal/line.ts';
import { TASK_FILES } from '../../journal/journal.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { pathExists } from '../../platform/safe-io/files.ts';
import type { HumanLedger } from '../human/human.types.ts';
import { readHumanLedger } from '../human/ledger.ts';
import { CROSS_SKIP } from '../next/lead-gate.ts';
import type { ReportInput, WriteReportOutcome } from './report.types.ts';

/**
 * Итоговый отчёт задачи (00 §Words «Final report», 06 §Human points, P96): единицы, требования
 * с доказательствами, развилки, решённые по умолчанию (вопросы вне списка, `step_done.forks`,
 * умолчания ядра без модели), непроверенное, остатки, предложения, поздние ответы. Сборка чистая —
 * из проекции журнала; тело ложится артефактом по sha256, в журнале `report.final` со ссылкой.
 */

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const nonEmpty = (s: string, max: number) => cut(s.trim() || '—', max);

const SUGGESTION_KINDS = FINAL_REPORT_SUGGESTIONS as readonly string[];

/**
 * Второе ревью пропущено без другого CLI (этап 12, P185): изменение смотрел один ревьюер — это
 * непроверенное, человек видит причину. Повтор пропуска на новом круге ревью — та же строка.
 */
function crossSkipsOf(ledger: HumanLedger): { what: string; why: string }[] {
  const byReason = new Map<string, { what: string; why: string }>();
  for (const [stepId, s] of Object.entries(ledger.steps)) {
    if (s.state !== 'skipped' || !s.reason?.startsWith(`${CROSS_SKIP}:`)) continue;
    byReason.set(s.reason, {
      what: `step ${stepId} (${s.stepKind}) skipped`,
      why: nonEmpty(s.reason, 2000),
    });
  }
  return [...byReason.values()];
}

export function buildFinalReport(ledger: HumanLedger, input: ReportInput): FinalReport {
  const outcome = input.at === 'ready-to-publish' ? 'ready-to-publish' : (input.ended ?? 'failed');
  const units = Object.entries(ledger.units).map(([unitId, u]) => ({
    unitId,
    name: nonEmpty(u.name, 200),
    state: u.state,
    branch: u.branch,
  }));
  const requirements = Object.entries(ledger.requirements)
    .map(([requirementId, r]) => ({
      requirementId,
      ordinal: r.ordinal,
      text: cut(r.text, 16_000),
      verdict: r.verdict as RequirementVerdict,
      evidence: r.evidence,
    }))
    .sort((a, b) => a.ordinal - b.ordinal);
  const forks = [
    ...ledger.forks.map((f) => ({
      stepId: f.stepId,
      source: f.source,
      question: nonEmpty(f.question, 2000),
      options: f.options.map((o) => nonEmpty(o, 300)),
      chosen: nonEmpty(f.chosen, 300),
      reason: cut(f.reason, 1000),
    })),
    ...ledger.coreDefaults.map((c) => ({
      stepId: c.stepId,
      source: 'core' as const,
      question: nonEmpty(`How to decide «${c.class}» before its model exists`, 2000),
      options: [nonEmpty(c.basis, 300)],
      chosen: nonEmpty(c.basis, 300),
      reason: cut(c.reason, 1000),
    })),
  ];
  const unverified = [
    ...requirements
      .filter((r) => r.verdict === 'unknown')
      .map((r) => ({
        what: nonEmpty(`R${r.ordinal}: ${r.text}`, 2000),
        why: 'closed by a derived step outcome; no review typed this requirement',
      })),
    ...Object.entries(ledger.steps)
      .filter(([, s]) => s.basis === 'derived')
      .map(([stepId, s]) => ({
        what: `step ${stepId} (${s.stepKind})`,
        why: nonEmpty(
          `outcome derived from git and records, no step_done: ${s.reason ?? ''}`,
          2000,
        ),
      })),
    ...crossSkipsOf(ledger),
  ];
  const residuals = [
    ...Object.entries(ledger.resources)
      .filter(([, r]) => r.status === 'leak' || r.status === 'live')
      .map(([rid, r]) => ({
        what: nonEmpty(`${r.kind} ${r.ref} (${rid})`, 2000),
        why:
          r.status === 'leak'
            ? 'release could not be read back'
            : typeof r.release === 'object'
              ? nonEmpty(`kept: ${r.release.keep}`, 2000)
              : `still live at ${input.at}`,
      })),
    ...Object.values(ledger.asks)
      .filter((a) => a.state === 'open')
      .map((a) => ({
        what: nonEmpty(`open question: ${a.question}`, 2000),
        why: `item ${a.point} still waits for the human`,
      })),
    ...Object.entries(ledger.steps)
      .filter(([, s]) => s.basis === 'not-implemented')
      .map(([stepId, s]) => ({
        what: `step ${stepId} (${s.stepKind}) skipped`,
        why: nonEmpty(s.reason ?? 'not implemented in this phase', 2000),
      })),
  ];
  const lateAnswers = Object.values(ledger.asks)
    .filter((a) => a.answers[0]?.late)
    .map((a) => ({ askId: a.askId, delivered: Boolean(ledger.deliveries[a.askId]) }));
  const suggestions = [
    ...ledger.signals
      .filter((s) => SUGGESTION_KINDS.includes(s.signal))
      .map((s) => ({
        kind: s.signal as FinalReportSuggestion,
        detail: nonEmpty(`${s.subject}: ${s.detail}`, 2000),
      })),
    ...lateAnswers
      .filter((l) => !l.delivered)
      .map((l) => ({
        kind: 'late-answer' as const,
        detail: `answer to ${l.askId} came after the question closed and reached no step`,
      })),
  ];
  return finalReportSchema.parse({
    taskId: input.taskId,
    at: input.at,
    outcome,
    units,
    requirements,
    forks,
    unverified,
    residuals,
    suggestions,
    lateAnswers,
  });
}

/**
 * Запись отчёта: артефакт по содержимому, затем строка `report.final`. Раз на точку — повтор
 * крючка после краха находит строку и не пишет вторую. Артефакт атомарен и пишется ДО строки:
 * строка без тела невозможна, тело без строки безвредно (тот же sha при повторе).
 */
export function writeFinalReport(
  task: LiveTask,
  input: Omit<ReportInput, 'taskId'>,
  ledger: HumanLedger = readHumanLedger(task),
): WriteReportOutcome {
  if (ledger.reports.includes(input.at)) return { kind: 'exists' };
  const report = buildFinalReport(ledger, { ...input, taskId: task.taskId });
  const payload = JSON.stringify(report);
  const sha256 = sha256OfText(payload);
  const bytes = Buffer.byteLength(payload);
  const file = join(task.dir, TASK_FILES.artifacts, `${sha256}.json`);
  if (!pathExists(file)) writeFileAtomic(file, payload);
  const line = task.append({
    kind: 'report.final',
    actor: 'core',
    data: { at: input.at, report: { sha256, bytes } },
  });
  ledger.reports.push(input.at);
  return { kind: 'written', sha256, bytes, seq: line.seq };
}
