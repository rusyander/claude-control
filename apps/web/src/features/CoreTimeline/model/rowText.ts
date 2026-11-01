import type { RowItem } from './fold.types';
import { signalView } from './signalView';

/** Тон строки ленты: сигнал «стоп» и отказ видны цветом, обычные строки — приглушённые. */
export type RowTone = 'default' | 'muted' | 'success' | 'warning' | 'danger' | 'info';

export interface RowText {
  key: string;
  params: Record<string, string | number>;
  tone: RowTone;
}

const SEVERITY_TONE = { info: 'info', warn: 'warning', stop: 'danger' } as const;
const END_TONE = { done: 'success', cancelled: 'muted', failed: 'danger' } as const;
const STEP_END_TONE = { done: 'success', failed: 'danger', skipped: 'muted' } as const;

/**
 * Простая строка ленты → ключ перевода и его параметры. Решения, шаги, сессии и проверки рисуются
 * своими компонентами; здесь — остальное, чтобы каждый вид строки имел одну подпись и её можно
 * было проверить без отрисовки.
 */
export function rowText(item: Exclude<RowItem, { type: 'decision' }>): RowText {
  switch (item.type) {
    case 'task-created':
      return { key: 'coreTimeline.timeline.task', params: { title: item.title }, tone: 'default' };
    case 'step-started':
      return {
        key: 'coreTimeline.timeline.stepStarted',
        params: { kind: item.stepKind, def: item.stepDefId, round: item.round },
        tone: 'default',
      };
    case 'step-ended':
      return {
        key: `coreTimeline.timeline.stepEnded.${item.outcome}`,
        params: {},
        tone: STEP_END_TONE[item.outcome],
      };
    case 'session-started':
      return { key: 'coreTimeline.timeline.session', params: { cli: item.cli }, tone: 'default' };
    case 'check-requested':
      return {
        key: 'coreTimeline.timeline.checkRequested',
        params: { check: item.checkId },
        tone: 'muted',
      };
    case 'signal': {
      // Заголовок — шаблон каталога (или «вне каталога» с id); предмет и деталь рисует `SignalLine`.
      const { title } = signalView(item);
      return { key: title.key, params: title.params, tone: SEVERITY_TONE[item.severity] };
    }
    case 'asked':
      return { key: 'coreTimeline.timeline.asked', params: { point: item.point }, tone: 'warning' };
    case 'answered':
      return {
        key: 'coreTimeline.timeline.answered',
        params: { channel: item.channel, answer: item.answer },
        tone: 'default',
      };
    case 'budget':
      return {
        key: 'coreTimeline.timeline.budget',
        params: { scope: item.scope, spent: item.spent },
        tone: 'muted',
      };
    case 'window':
      return {
        key: 'coreTimeline.timeline.window',
        params: { route: item.routeId, verdict: item.verdict },
        tone: item.verdict === 'open' ? 'muted' : 'warning',
      };
    case 'report':
      return { key: 'coreTimeline.timeline.report', params: {}, tone: 'success' };
    case 'task-ended':
      return {
        key: `coreTimeline.timeline.taskEnded.${item.outcome}`,
        params: {},
        tone: END_TONE[item.outcome],
      };
    case 'command-rejected':
      return {
        key: 'coreTimeline.timeline.commandRejected',
        params: { code: item.code },
        tone: 'danger',
      };
    case 'error':
      return { key: 'coreTimeline.timeline.error', params: { code: item.code }, tone: 'danger' };
    case 'in-artifact':
      return { key: 'coreTimeline.timeline.inArtifact', params: {}, tone: 'muted' };
  }
}

/** Пояснение под подписью — дословный текст ядра, если строка его несёт (причина, деталь). */
export function rowDetail(item: Exclude<RowItem, { type: 'decision' }>): string | null {
  switch (item.type) {
    case 'step-ended':
      return item.reason || null;
    case 'asked':
      return item.question || null;
    case 'command-rejected':
      return item.reason || null;
    case 'error':
      return item.detail || null;
    default:
      return null;
  }
}
