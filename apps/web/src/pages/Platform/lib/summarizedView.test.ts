import { describe, expect, it } from 'vitest';
import type { PlatformSummarizedReport } from '@agentdeck/contracts';
import { isSummarizedReport, showsSummarized, summarizedLinkOf } from './summarizedView';

const report: PlatformSummarizedReport = {
  total: 1,
  recent: [
    { at: '2026-09-17T10:00:00.000Z', platformId: 'c', path: '/c/v1/messages', link: 'message' },
  ],
};

describe('summarizedView', () => {
  it('сводка без полей от сервера другой версии не принимается за пустую', () => {
    expect(isSummarizedReport(undefined)).toBe(false);
    expect(isSummarizedReport({ total: 1 } as unknown as PlatformSummarizedReport)).toBe(false);
    expect(isSummarizedReport(report)).toBe(true);
  });

  it('карточка только при включённом контуре и живом шлюзе', () => {
    expect(showsSummarized(true, true, report)).toBe(true);
    expect(showsSummarized(false, true, report)).toBe(false);
    expect(showsSummarized(true, false, report)).toBe(false);
    expect(showsSummarized(true, true, undefined)).toBe(false);
  });

  it('незнакомая привязка читается как «подписать негде», а не как подписанный ответ', () => {
    expect(summarizedLinkOf('message')).toBe('message');
    expect(summarizedLinkOf('run')).toBe('run');
    expect(summarizedLinkOf('session')).toBe('none');
    expect(summarizedLinkOf(undefined)).toBe('none');
  });
});
