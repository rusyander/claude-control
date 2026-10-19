import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LedgerSummary } from '@agentdeck/contracts/verify-ledger';
import { i18n } from '@shared/config/i18n';
import { VerifyLedgerCard } from './VerifyLedgerCard';

/**
 * Плитка журнала рисуется настоящим компонентом под клиентом запросов, в кэше
 * которого лежит ответ `GET /api/verify-ledger`. Ловит сырой ключ перевода,
 * повтор, не сложенный с тенью, расхождение без красного и неработающий журнал,
 * который выглядит как работающий.
 */
function render(summary?: LedgerSummary): string {
  const client = new QueryClient();
  if (summary) client.setQueryData(['project-git', 'verify-ledger'], summary);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <VerifyLedgerCard />
    </QueryClientProvider>,
  );
}

const textOf = (html: string): string => html.replace(/<[^>]+>/g, '|');

const base: LedgerSummary = {
  active: true,
  reason: null,
  version: 'abc123def456',
  mode: 'shadow',
  windowDays: 7,
  records: 12,
  wouldSkip: 5,
  hits: 2,
  mismatches: 0,
  savedMs: 30 * 60_000,
  repos: 3,
  offReasons: {},
  seen: [
    { cli: 'claude', at: 1 },
    { cli: 'codex', at: 2 },
  ],
};

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('плитка журнала проверок', () => {
  it('работающий журнал: режим, окно, счётчики и пульс CLI — словами, без сырых ключей', () => {
    const html = render(base);
    const text = textOf(html);

    expect(text).not.toMatch(/settings\.verifyLedger\./);
    expect(html).toContain(i18n.t('settings.verifyLedger.mode.shadow'));
    expect(html).toContain(i18n.t('settings.verifyLedger.window', { count: 7 }));
    expect(text).toContain('|12|');
    // Повторы тени и настоящие повторы — одно число: человек решает по сумме.
    expect(text).toContain('|7|');
    expect(html).toContain(i18n.t('settings.verifyLedger.minutes', { count: 30 }));
    expect(html).toContain(i18n.t('settings.verifyLedger.seen', { list: 'claude, codex' }));
  });

  it('расхождение с прогоном — красным, без расхождений — обычным цветом', () => {
    const clean = render(base);
    const dirty = render({ ...base, mismatches: 1 });

    expect(dirty).toMatch(/danger[^>]*>1</);
    expect(clean).not.toMatch(/danger[^>]*>0</);
  });

  it('неработающий журнал — «Не работает» с причиной, а не режим', () => {
    const html = render({ ...base, active: false, reason: 'самопроверка не прошла' });

    expect(html).toContain(i18n.t('settings.verifyLedger.inactive'));
    expect(html).toContain('самопроверка не прошла');
    expect(html).not.toContain(i18n.t('settings.verifyLedger.mode.shadow'));
  });

  it('ни одного срабатывания — честная строка, а не пустой список', () => {
    const html = render({ ...base, seen: [] });
    expect(html).toContain(i18n.t('settings.verifyLedger.seenNone'));
  });

  it('пока ответа нет — строка загрузки', () => {
    expect(render()).toContain(i18n.t('settings.verifyLedger.loading'));
  });
});
