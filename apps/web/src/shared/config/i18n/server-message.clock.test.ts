import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from './instance';
import { serverFieldText, serverMessageFromPayload } from './server-message';

type Notice = { notice: string; noticeCode?: string; noticeParams?: unknown };

/**
 * Срок лимита подписки (W3-5): сервер шлёт момент ISO, а часы считает клиент —
 * в поясе ЧЕЛОВЕКА. Раньше сервер слал готовое «ЧЧ:ММ» своего пояса, и панель на
 * удалённой машине показывала чужое время.
 */
const UNTIL = '2026-09-25T10:07:00.000Z';
const pad = (value: number): string => String(value).padStart(2, '0');
const at = new Date(UNTIL);
const LOCAL = `${pad(at.getHours())}:${pad(at.getMinutes())}`;

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('срок лимита — в местном времени', () => {
  it('отказ с кодом: ISO превращается в местные ЧЧ:ММ', () => {
    const text = serverMessageFromPayload({
      message: 'x',
      messageCode: 'split-limit-active',
      params: { until: UNTIL },
    });

    expect(text).toBe(`Лимит подписки исчерпан до ${LOCAL}`);
    expect(text).not.toContain('2026-09-25');
  });

  it('заметка об ожидании сброса — тоже местные часы', () => {
    const text = serverFieldText<'notice'>(
      {
        notice: 'x',
        noticeCode: 'split-limit-wait-notice',
        noticeParams: { until: UNTIL },
      } as Notice,
      'notice',
    );

    expect(text).toContain(LOCAL);
    expect(text).not.toContain('T10:07');
  });
});
