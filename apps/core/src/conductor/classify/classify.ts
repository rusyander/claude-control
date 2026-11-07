import {
  TASK_CLASSES,
  type ClassSignals,
  type ClassThresholds,
  type TaskClass,
  type TaskClassDecision,
} from '@agentdeck/contracts/core/lead';
import { riskWhy } from './signals.ts';

/**
 * Класс задачи (класс решений `classify`, W2-8, D5, P135) — чистая функция записанных признаков
 * и порогов `lead.classThresholds`:
 * - XL — пунктов ≥ `XL.items` ИЛИ единиц ≥ `XL.units` со связями между ними;
 * - S — файлов ≤ `S.files`, единиц ≤ `S.units`, без риска;
 * - M — файлов ≤ `M.files`, единиц ≤ `M.units`;
 * - иначе L.
 * Покрытие проверкой не доказано (`checkCovered` не `true`) — класс на одну ступень вверх, но не
 * выше L (`no-check`: XL — про ширину, а не про проверку). Модель класс только поднимает; ниже
 * расчёта — отказ (`refusedLower`). Понижает только человек.
 */

export interface ClassifyInput {
  signals: ClassSignals;
  thresholds: ClassThresholds;
  /** Класс, предложенный моделью (`step_done.classProposal`); нет — `null`. */
  proposal: TaskClass | null;
  /** Ответ человека на вопрос класса; нет — `null`. */
  human: TaskClass | null;
}

const rank = (c: TaskClass): number => TASK_CLASSES.indexOf(c);
const at = (r: number): TaskClass => TASK_CLASSES[r] as TaskClass;

function fromSignalsOf(s: ClassSignals, t: ClassThresholds, reasons: string[]): TaskClass {
  if (s.items >= t.XL.items) {
    reasons.push(`items ${s.items} ≥ ${t.XL.items}: independent goals`);
    return 'XL';
  }
  if (s.units >= t.XL.units && s.crossUnitDeps > 0) {
    reasons.push(
      `units ${s.units} ≥ ${t.XL.units} with ${s.crossUnitDeps} cross-unit dependencies`,
    );
    return 'XL';
  }
  if (s.files <= t.S.files && s.units <= t.S.units && s.risk.length === 0) {
    reasons.push(`files ${s.files} ≤ ${t.S.files}, units ${s.units} ≤ ${t.S.units}, no risk`);
    return 'S';
  }
  if (s.files <= t.M.files && s.units <= t.M.units) {
    const risk = s.risk.length > 0 ? `; risk ${s.risk.map(riskWhy).join(', ')}` : '';
    reasons.push(`files ${s.files} ≤ ${t.M.files}, units ${s.units} ≤ ${t.M.units}${risk}`);
    return 'M';
  }
  reasons.push(`files ${s.files} > ${t.M.files} or units ${s.units} > ${t.M.units}`);
  return 'L';
}

export function decideClass(input: ClassifyInput): TaskClassDecision {
  const { signals } = input;
  const reasons: string[] = [];
  const raised: TaskClassDecision['raised'] = [];
  const fromSignals = fromSignalsOf(signals, input.thresholds, reasons);
  let cls = fromSignals;
  const noCheck = signals.checkCovered === null ? 'registry unread' : 'not covered';
  if (signals.checkCovered !== true && rank(cls) < rank('L')) {
    const to = at(rank(cls) + 1);
    raised.push({ cause: 'no-check', from: cls, to });
    reasons.push(`no check proven over the touched files (${noCheck}): ${cls} → ${to}`);
    cls = to;
  } else if (signals.checkCovered !== true) {
    // Потолок назван в причине: иначе L без проверки неотличим от L с проверкой, и читатель журнала
    // не видит, что подъём был, но упёрся в L (решение 05.11: XL — про ширину, а не про риск).
    reasons.push(
      `no check proven over the touched files (${noCheck}): raisedBy no-check capped at L, ${cls} stays ${cls}`,
    );
  }
  let refusedLower: TaskClassDecision['refusedLower'] = null;
  if (input.proposal !== null && rank(input.proposal) > rank(cls)) {
    raised.push({ cause: 'model', from: cls, to: input.proposal });
    reasons.push(`the model raised the class: ${cls} → ${input.proposal}`);
    cls = input.proposal;
  } else if (input.proposal !== null && rank(input.proposal) < rank(cls)) {
    refusedLower = { proposed: input.proposal };
    reasons.push(
      `the model proposed ${input.proposal}, lower than ${cls}: refused, only a human lowers`,
    );
  }
  if (input.human !== null && input.human !== cls) {
    raised.push({ cause: 'human', from: cls, to: input.human });
    reasons.push(`the human set the class: ${cls} → ${input.human}`);
    cls = input.human;
  }
  return { class: cls, fromSignals, signals, raised, refusedLower, reasons };
}
