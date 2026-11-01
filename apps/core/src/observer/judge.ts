import type { SignalDecision, SignalDef, SignalVerdict } from './observer.types.ts';

/**
 * Единственный судья класса `observer` (P01, F1 этапа 8): вердикт предиката + строка каталога →
 * решение. Серьёзность, действие и точка человека — только из каталога, предикат их не выбирает:
 * так один и тот же факт судится одинаково, откуда бы ни пришёл. Повтор после подсказки
 * (`escalated`) берёт вторую ступень сигнала, если она в каталоге есть.
 */
export function judgeSignal(verdict: SignalVerdict, def: SignalDef): SignalDecision {
  const base = { signal: def.id, severity: def.severity, action: def.action };
  if (verdict.signal !== def.id)
    return {
      ...base,
      fired: false,
      subject: '',
      detail: '',
      reasons: [`verdict ${verdict.signal} is not judged by the catalog row ${def.id}`],
      humanPoint: null,
    };
  if (!verdict.fired)
    return {
      ...base,
      fired: false,
      subject: '',
      detail: '',
      reasons: verdict.reasons,
      humanPoint: null,
    };
  const level = verdict.escalated === true && def.escalated ? def.escalated : def;
  const step = level === def ? 'first' : 'escalated';
  return {
    fired: true,
    signal: def.id,
    severity: level.severity,
    action: level.action,
    subject: verdict.subject,
    detail: verdict.detail,
    reasons: [
      ...verdict.reasons,
      `catalog ${def.id} (${step}): ${level.severity} → ${level.action}`,
    ],
    humanPoint: def.humanPoint,
  };
}
