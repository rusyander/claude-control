import type { JournalDataV1, JournalLine } from '@agentdeck/contracts/core/journal';
import { ASK_MACHINE, STEP_MACHINE } from '@agentdeck/contracts/core/states';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { HumanLedger, StepEntry } from './human.types.ts';

/**
 * Проекция журнала для зоны человека (`HumanLedger`): чистая функция строк. Читает только то,
 * что написал подъём, команды человека и доставка, — второй свёртки состояния тут нет: машины
 * шагов и вопросов идут той же таблицей, что у `reduce`, и ошибочная строка здесь просто
 * пропускается (её аномалию показывает свёртка).
 */

/** Сигнал напоминания о вопросе: тема — askId (06 §Human points, «reminders on a schedule»). */
export const ASK_REMINDER = 'ask-reminder';

type Data<K extends keyof JournalDataV1> = JournalDataV1[K];

export function emptyLedger(): HumanLedger {
  return {
    asks: {},
    messages: {},
    deliveries: {},
    grants: [],
    forks: [],
    steps: {},
    units: {},
    requirements: {},
    resources: {},
    externalEdits: [],
    signals: [],
    coreDefaults: [],
    reports: [],
  };
}

/**
 * Умолчание самого ядра (G7, G8): решение, чьё основание — «модели ещё нет». В отчёт — один раз
 * на класс и основание, а не на каждый шаг: человеку важна развилка, а не её счёт.
 */
function coreDefault(line: JournalLine, d: Data<'decision'>, out: HumanLedger): void {
  const o = d.output as { basis?: unknown } | null;
  const basis = o && typeof o.basis === 'string' ? o.basis : null;
  if (!basis || !/not-(modelled|implemented)/.test(basis)) return;
  if (out.coreDefaults.some((c) => c.class === d.class && c.basis === basis)) return;
  out.coreDefaults.push({
    class: d.class,
    basis,
    reason: d.reasons.join('; '),
    stepId: line.stepId ?? null,
  });
}

function forkFromDecision(line: JournalLine, out: HumanLedger): void {
  const d = line.data as Data<'decision'>;
  coreDefault(line, d, out);
  if (d.class !== 'human-point') return;
  const o = d.output as {
    point?: unknown;
    source?: string;
    fork?: { question: string; options: string[]; recommendation: string };
  } | null;
  if (!o || o.point !== null || !o.fork) return;
  const source =
    o.source === 'blocker' ? 'blocker' : o.source === 'ask_human' ? 'ask_human' : 'core';
  out.forks.push({
    stepId: line.stepId ?? null,
    source,
    question: o.fork.question,
    options: o.fork.options,
    chosen: o.fork.recommendation,
    reason: d.reasons.join('; '),
  });
}

/**
 * Этап 12 (P161, P162): доработка идущей задачи и записка возврата после перехвата — тоже слово
 * человека шагу. Шаг выбирает команда (`stepId` в её исходе), текст — поле команды; исхода без
 * `stepId` (носитель доработки, возврат без записки) — сообщения нет.
 */
function toStepFromOutcome(
  r: Data<'command.received'>,
  line: JournalLine,
): { stepId: string; text: string } | undefined {
  if (r.kind !== 'rework' && r.kind !== 'hand-back') return undefined;
  const stepId = (line.data as { outcome?: { stepId?: unknown } }).outcome?.stepId;
  const f = r.fields as { text?: unknown; note?: unknown };
  const body = r.kind === 'rework' ? f.text : f.note;
  if (typeof stepId !== 'string' || typeof body !== 'string' || body.trim() === '')
    return undefined;
  const text =
    r.kind === 'hand-back'
      ? `The human took this unit over by hand and handed it back with a note:\n${body.trim()}`
      : body;
  return { stepId, text };
}

function onCommand(line: JournalLine, out: HumanLedger, received: Map<string, JournalLine>): void {
  if (!line.cmdId) return;
  if (line.kind === 'command.received') {
    received.set(line.cmdId, line);
    return;
  }
  const got = received.get(line.cmdId);
  if (line.kind !== 'command.applied' || !got) return;
  const r = got.data as Data<'command.received'>;
  const fromOutcome = toStepFromOutcome(r, line);
  if (fromOutcome) {
    out.messages[line.cmdId] = { cmdId: line.cmdId, ...fromOutcome, seq: line.seq };
    return;
  }
  if (r.kind !== 'message-to-step') return;
  const f = r.fields as { stepId?: unknown; text?: unknown };
  if (typeof f.stepId !== 'string' || typeof f.text !== 'string') return;
  out.messages[line.cmdId] = { cmdId: line.cmdId, stepId: f.stepId, text: f.text, seq: line.seq };
}

function onAsk(line: JournalLine, out: HumanLedger): void {
  if (line.kind === 'human.asked') {
    const d = line.data as Data<'human.asked'>;
    out.asks[d.askId] = {
      askId: d.askId,
      point: d.point,
      source: d.source,
      dedupe: d.dedupe,
      stepId: line.stepId ?? null,
      sessionId: line.sessionId ?? null,
      question: d.question,
      options: d.options,
      defaultAction: d.defaultAction,
      blocking: d.defaultAction === null,
      askedAt: line.at,
      askedSeq: line.seq,
      state: ASK_MACHINE.initial,
      reminders: 0,
      lastReminderAt: null,
      answers: [],
    };
  } else if (line.kind === 'ask.transition') {
    const d = line.data as Data<'ask.transition'>;
    const ask = out.asks[d.askId];
    if (ask) ask.state = d.to;
  } else if (line.kind === 'human.answered') {
    const d = line.data as Data<'human.answered'>;
    const ask = out.asks[d.askId];
    // Поздний — ответ на вопрос, который к этой строке уже не открыт (P71); переход `answer`
    // открытого вопроса пишется раньше ответа, поэтому сверяется и `answered` без прежнего ответа.
    const late = ask ? !(ask.state === 'answered' && ask.answers.length === 0) : true;
    ask?.answers.push({
      text: d.answer,
      seq: line.seq,
      late,
      channel: d.channel,
      cmdId: line.cmdId ?? null,
    });
  }
}

const STEP_TERMINAL: ReadonlySet<string> = new Set(STEP_MACHINE.terminal);

/** Первая строка, приведшая шаг в конец, — граница: вопрос, заданный позже, шагу уже не принадлежит. */
function moveStep(step: StepEntry, to: string, seq: number): void {
  step.state = to;
  if (STEP_TERMINAL.has(to)) step.endedSeq ??= seq;
}

function onStepOrUnit(line: JournalLine, out: HumanLedger): void {
  switch (line.kind) {
    case 'unit.created': {
      const d = line.data as Data<'unit.created'>;
      out.units[d.unitId] = {
        name: d.name,
        repoKey: d.repoKey,
        branch: d.branch,
        state: 'created',
      };
      return;
    }
    case 'unit.transition': {
      const d = line.data as Data<'unit.transition'>;
      const unit = out.units[d.unitId];
      if (unit) unit.state = d.to;
      return;
    }
    case 'step.started': {
      const d = line.data as Data<'step.started'>;
      out.steps[d.stepId] = {
        unitId: d.unitId,
        stepKind: d.stepKind,
        state: 'queued',
        sessionIds: [],
        basis: null,
        reason: null,
        endedSeq: null,
      };
      return;
    }
    case 'step.transition': {
      const d = line.data as Data<'step.transition'>;
      const step = out.steps[d.stepId];
      if (step) moveStep(step, d.to, line.seq);
      return;
    }
    case 'step.ended': {
      const d = line.data as Data<'step.ended'>;
      const step = out.steps[d.stepId];
      if (step) {
        moveStep(step, d.outcome, line.seq);
        step.basis = d.basis;
        step.reason = d.reason;
      }
      return;
    }
    case 'session.started': {
      const d = line.data as Data<'session.started'>;
      out.steps[d.stepId]?.sessionIds.push(d.sessionId);
      return;
    }
    case 'step.claimed': {
      const d = line.data as Data<'step.claimed'>;
      for (const f of d.claim.forks ?? []) {
        out.forks.push({ stepId: d.stepId, source: 'step_done', ...f });
      }
      return;
    }
  }
}

function onResource(line: JournalLine, out: HumanLedger): void {
  switch (line.kind) {
    case 'resource.created': {
      const d = line.data as Data<'resource.created'>;
      out.resources[d.rid] = {
        kind: d.kind,
        unitId: line.unitId ?? null,
        stepId: line.stepId ?? null,
        owner: d.owner,
        release: d.release,
        status: 'live',
        ref: d.ref,
      };
      return;
    }
    case 'resource.released':
    case 'resource.verified':
    case 'resource.leak': {
      const rid = (line.data as { rid: string }).rid;
      const r = out.resources[rid];
      if (!r) return;
      r.status =
        line.kind === 'resource.released'
          ? 'released'
          : line.kind === 'resource.verified'
            ? 'verified'
            : 'leak';
      return;
    }
  }
}

function onRequirement(line: JournalLine, out: HumanLedger): void {
  if (line.kind === 'requirement.extracted') {
    const d = line.data as Data<'requirement.extracted'>;
    out.requirements[d.requirementId] = {
      ordinal: d.ordinal,
      text: d.text,
      verdict: 'open',
      evidence: [],
    };
  } else if (line.kind === 'requirement.verdict') {
    const d = line.data as Data<'requirement.verdict'>;
    const r = out.requirements[d.requirementId];
    if (r) {
      r.verdict = d.verdict;
      r.evidence = d.evidence;
    }
  }
}

export function humanLedger(lines: readonly JournalLine[]): HumanLedger {
  const out = emptyLedger();
  const received = new Map<string, JournalLine>();
  for (const line of lines) {
    onAsk(line, out);
    onStepOrUnit(line, out);
    onResource(line, out);
    onRequirement(line, out);
    switch (line.kind) {
      case 'command.received':
      case 'command.applied':
        onCommand(line, out, received);
        break;
      case 'decision':
        forkFromDecision(line, out);
        break;
      case 'message.delivered': {
        const d = line.data as Data<'message.delivered'>;
        out.deliveries[d.ref.id] ??= { stepId: d.stepId, seq: line.seq };
        break;
      }
      case 'report.final':
        out.reports.push((line.data as Data<'report.final'>).at);
        break;
      case 'grant.given': {
        const d = line.data as Data<'grant.given'>;
        out.grants.push({ cmdId: d.cmdId, project: d.project, globs: d.globs, ops: d.ops });
        break;
      }
      case 'copy.changed-externally': {
        const d = line.data as Data<'copy.changed-externally'>;
        out.externalEdits.push({ unitId: d.unitId, files: d.files, seq: line.seq });
        break;
      }
      case 'signal': {
        const d = line.data as Data<'signal'>;
        out.signals.push({ ...d, seq: line.seq });
        const ask = d.signal === ASK_REMINDER ? out.asks[d.subject] : undefined;
        if (ask) {
          ask.reminders += 1;
          ask.lastReminderAt = line.at;
        }
        break;
      }
    }
  }
  return out;
}

/** Журнал задачи как он есть на диске сейчас: каждая строка пишется одним `write` до возврата. */
export function readHumanLedger(task: Pick<LiveTask, 'dir' | 'taskId'>): HumanLedger {
  return humanLedger(readJournalLines(task.dir, task.taskId).lines);
}
