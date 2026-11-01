import { describe, expect, it } from 'vitest';
import { i18n } from '@shared/config/i18n';
import type { RowItem } from './fold.types';
import { rowDetail, rowText } from './rowText';

/** Каждая простая строка ленты имеет подпись, которая есть в обоих языках, и свой тон. */

const ITEMS: Exclude<RowItem, { type: 'decision' }>[] = [
  { type: 'task-created', title: 't' },
  { type: 'step-started', stepKind: 'implement', stepDefId: 'i', round: 1 },
  { type: 'step-ended', outcome: 'failed', reason: 'no step_done' },
  { type: 'session-started', cli: 'claude' },
  { type: 'check-requested', checkRunId: 'c', checkId: 'unit' },
  { type: 'signal', signal: 's', severity: 'stop', subject: 'a', detail: 'b', action: null },
  { type: 'asked', askId: 'a', point: 3, question: 'why?' },
  { type: 'answered', askId: 'a', answer: 'ok', channel: 'panel' },
  { type: 'budget', scope: 'task', spent: 1, limit: null },
  { type: 'window', routeId: 'r', verdict: 'refused' },
  { type: 'report', sha256: 'x' },
  { type: 'task-ended', outcome: 'cancelled' },
  { type: 'command-rejected', code: 'c', reason: 'r' },
  { type: 'error', code: 'e', detail: 'd' },
  { type: 'in-artifact', kind: 'decision' },
];

describe('подписи простых строк ленты', () => {
  it.each(['ru', 'en'])('каждый ключ есть в %s', (lang) => {
    const t = i18n.getFixedT(lang);
    for (const item of ITEMS) {
      const { key } = rowText(item);
      expect(i18n.exists(key, { lng: lang }), `${lang}:${key}`).toBe(true);
      expect(t(key, rowText(item).params)).not.toBe(key);
    }
  });

  it('тон: стоп и отказ — опасность, окно не открыто — внимание', () => {
    expect(rowText(ITEMS[5]!).tone).toBe('danger');
    expect(rowText(ITEMS[9]!).tone).toBe('warning');
    expect(rowText(ITEMS[2]!).tone).toBe('danger');
  });

  it('пояснение — дословный текст ядра, если он есть', () => {
    expect(rowDetail(ITEMS[2]!)).toBe('no step_done');
    // Деталь сигнала рисует `SignalLine` (предмет с подписью, проза или факты) — не общая строка.
    expect(rowDetail(ITEMS[5]!)).toBeNull();
    expect(rowDetail(ITEMS[6]!)).toBe('why?');
    expect(rowDetail(ITEMS[0]!)).toBeNull();
  });
});
