import {
  SIGNAL_VIEW,
  isSignalId,
  signalDetail,
  type SignalDetailView,
  type SignalFact,
} from '@agentdeck/contracts/core/signal-view';
import type { RowItem } from './fold.types';

export type SignalItem = Extract<RowItem, { type: 'signal' }>;

export interface SignalView {
  /** Сигнал есть в каталоге ядра — заголовок по шаблону; нет — назван своим id. */
  known: boolean;
  title: { key: string; params: Record<string, string> };
  /** Подпись предмета (ключ перевода) и сам предмет; пустой предмет не показывается. */
  subject: { key: string; value: string } | null;
  detail: SignalDetailView;
}

/**
 * Строка сигнала → что видит человек: заголовок из шаблона по id каталога, подпись предмета по
 * его виду и деталь — проза дословно, JSON известного сигнала фактами, неизвестного — ключами.
 */
export function signalView(item: SignalItem): SignalView {
  const known = isSignalId(item.signal);
  const subjectKey = known
    ? `coreTimeline.signals.subjects.${SIGNAL_VIEW[item.signal as keyof typeof SIGNAL_VIEW].subject}`
    : 'coreTimeline.signal.subject';
  return {
    known,
    title: known
      ? { key: `coreTimeline.signals.titles.${item.signal}`, params: {} }
      : { key: 'coreTimeline.signal.unknown', params: { signal: item.signal } },
    subject: item.subject ? { key: subjectKey, value: item.subject } : null,
    detail: signalDetail(item.signal, item.detail),
  };
}

/** Подпись факта: ключ перевода из закрытого списка или имя из самих данных как есть. */
export function factLabel(fact: SignalFact): { key: string } | { raw: string } {
  return 'key' in fact ? { key: `coreTimeline.signals.facts.${fact.key}` } : { raw: fact.label };
}
