import { afterAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { i18n } from '@shared/config/i18n';
import { mergeSplitGroups } from '../../lib/mergeSplitGroups';
import type { ChildStageGroup } from '../ChildStages.types';
import { ChildStages } from '../ChildStages/ChildStages';
import { splitGroupKey } from '../../lib/splitGroupKey';

/**
 * @covers apps/web/src/features/ChatMessages/ui/GroupText/GroupText.tsx
 * @covers apps/web/src/features/ChatMessages/lib/tokenLedgerText.ts
 * @covers apps/web/src/features/ChatMessages/lib/mergeSplitGroups.ts
 * @scenario Счёт токенов закрытой группы (E4) на её карточке: числа — языком
 * интерфейса, флаги утечки — фишками, медиана проекта — по наведению.
 */

type ViewGroup = SplitPlanView['groups'][number];

const LEDGER: NonNullable<ViewGroup['tokenLedger']> = {
  at: '2026-10-12T10:00:00.000Z',
  usage: {
    sessions: 3,
    turns: 276,
    coldStart: 70_619,
    avgCtx: 204_099,
    compactions: 4,
    cacheHitPct: 98,
    instructionPct: 48,
  },
  duplicates: ['C:/copy/CLAUDE.md', 'C:/copy/pkg/CLAUDE.md'],
};

function render(extra: Partial<ViewGroup>): string {
  const split: SplitPlanView = {
    parentChatId: 'parent',
    triage: { at: '2026-10-12T09:00:00.000Z', received: true, repairs: [], conflicts: [] },
    order: [0],
    groups: [
      {
        index: 0,
        title: 'Форма входа',
        branch: 'feature/login',
        after: [],
        status: 'done',
        chatId: 'c0',
        path: 'C:/copies/0',
        ...extra,
      },
    ],
  };
  const rows = new Map<string, ChildStageGroup>([
    [
      splitGroupKey({ groupIndex: 0, id: 'c0' }),
      { chatId: 'c0', title: 'Форма входа', stages: ['work'], isRunning: false },
    ],
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages groups={mergeSplitGroups(rows, split)} onOpen={() => {}} />
    </QueryClientProvider>,
  );
}

function tokensBlock(html: string): string {
  const at = html.indexOf('data-hub-tokens');
  if (at < 0) return '';
  const start = html.lastIndexOf('<span', at);
  return html.slice(start, html.indexOf('</span></span>', at) + 14);
}

afterAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('счёт токенов на карточке группы', () => {
  it('ru: числа компактно, флаги фишками, дубли в строке, медиана — по наведению', async () => {
    await i18n.changeLanguage('ru');
    const block = tokensBlock(
      render({
        tokenLedger: LEDGER,
        tokenFlags: ['instructions', 'duplicate'],
        tokenMedian: 52_000,
      }),
    );
    expect(block).toContain(
      // Русский компактный формат ставит неразрывный пробел перед «тыс.».
      'токены: старт 71 тыс. · ходов 276 · средний контекст 204 тыс. · из кэша 98% · сжатий 4 · инструкции 48%',
    );
    expect(block).toContain('инструкции — больше четверти контекста');
    expect(block).toContain('инструкции загружены дважды');
    expect(block).toContain('title="медиана старта по проекту 52 тыс."');
    expect(block).toContain(
      'один текст инструкций под разными путями: C:/copy/CLAUDE.md, C:/copy/pkg/CLAUDE.md',
    );
  });

  it('en: те же числа языком интерфейса; без флагов — без фишек', async () => {
    await i18n.changeLanguage('en');
    const block = tokensBlock(render({ tokenLedger: { at: '', usage: LEDGER.usage } }));
    expect(block).toContain(
      'tokens: start 71K · turns 276 · average context 204K · from cache 98% · compactions 4 · instructions 48%',
    );
    expect(block).not.toContain('chipAsk');
    expect(block).not.toContain('title=');
  });

  it('счёта нет — строки нет', async () => {
    await i18n.changeLanguage('ru');
    expect(render({})).not.toContain('data-hub-tokens');
  });
});
