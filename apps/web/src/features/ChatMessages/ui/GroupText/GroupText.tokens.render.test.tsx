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
 * @covers apps/web/src/features/ChatMessages/ui/MetricList/MetricList.tsx
 * @covers apps/web/src/features/ChatMessages/lib/tokenLedgerText.ts
 * @covers apps/web/src/features/ChatMessages/lib/mergeSplitGroups.ts
 * @scenario Счёт токенов группы (E4) на её карточке: числа — колонками под
 * подписями и языком интерфейса, флаги утечки и итог подогрева — фишками,
 * медиана проекта — припиской под первым запросом.
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

/** Раздел «Токены» целиком — от его `<div` до парного `</div>` с учётом вложенных. */
function tokensBlock(html: string): string {
  const at = html.indexOf('data-hub-tokens');
  if (at < 0) return '';
  const start = html.lastIndexOf('<div', at);
  const tags = /<div\b|<\/div>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index + 6);
  }
  return html.slice(start);
}

/**
 * Колонки ряда словами: «подпись / значение / приписка» на колонку — ровно то,
 * что человек читает в карточке. Неразрывный пробел Intl — обычным.
 */
function cells(block: string, attr: string): string[] {
  const out: string[] = [];
  const cell = new RegExp(`<div[^>]*${attr}-cell="[^"]+"[^>]*>(.*?)</div>`, 'g');
  for (const match of block.matchAll(cell)) {
    const parts = (match[1] ?? '').split(/<[^>]+>/).filter(Boolean);
    out.push(parts.join(' / ').replace(/\u00a0/g, ' '));
  }
  return out;
}

afterAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('счёт токенов на карточке группы', () => {
  it('ru: числа колонками под подписями, флаги фишками, дубли строкой, медиана — под первым запросом', async () => {
    await i18n.changeLanguage('ru');
    const block = tokensBlock(
      render({
        tokenLedger: LEDGER,
        tokenFlags: ['instructions', 'duplicate'],
        tokenMedian: 52_000,
      }),
    );
    expect(cells(block, 'data-hub-usage')).toEqual([
      'Первый запрос / 71 тыс. / медиана проекта 52 тыс.',
      'Среднее окно / 204 тыс.',
      'Из кэша / 98 %',
      'Инструкции в окне / 48 %',
      'Ходов / 276',
      'Сжатий / 4',
      'Сессий / 3',
    ]);
    // Раздел под своим заголовком, ряд — под своей подписью; прозы через
    // запятую («первый запрос 71 тыс., в среднем …») больше нет.
    expect(block).toContain('>Токены</span>');
    expect(block).toContain('>Сессии</span>');
    expect(block).not.toContain('первый запрос');
    expect(block).toContain('инструкции — больше четверти контекста');
    expect(block).toContain('инструкции загружены дважды');
    expect(block).toContain(
      'один текст инструкций под разными путями: C:/copy/CLAUDE.md, C:/copy/pkg/CLAUDE.md',
    );
    expect(block).not.toContain('data-hub-keep-warm');
  });

  it('en: те же числа языком интерфейса; без флагов — без фишек, без медианы — без приписки', async () => {
    await i18n.changeLanguage('en');
    const block = tokensBlock(render({ tokenLedger: { at: '', usage: LEDGER.usage } }));
    expect(cells(block, 'data-hub-usage')).toEqual([
      'First request / 71K',
      'Average window / 204K',
      'From cache / 98%',
      'Instructions in window / 48%',
      'Turns / 276',
      'Compactions / 4',
      'Sessions / 3',
    ]);
    expect(block).not.toContain('chipAsk');
    expect(block).not.toContain('median');
  });

  it('пинги тёплого кэша ждущей группы — своим рядом, итог — фишкой у заголовка, расход ожидания — строкой', async () => {
    const keepWarm = {
      pings: 3,
      hits: 2,
      misses: 1,
      input: 6,
      cacheRead: 241_000,
      cacheWrite: 620,
      output: 4,
      saved: 190_000,
      settled: 1,
      realized: 1,
      pending: 1_200,
      lastAt: '2026-10-22T11:40:00.000Z',
    };
    await i18n.changeLanguage('ru');
    const waiting = { status: 'awaiting' as const, waitingFor: 'question' as const };
    const ru = tokensBlock(render({ ...waiting, tokenLedger: { at: keepWarm.lastAt, keepWarm } }));
    expect(cells(ru, 'data-hub-keep-warm')).toEqual([
      'Пингов / 3',
      'Попали в кэш / 2',
      'Мимо / 1',
      'Прочитано / 241 тыс.',
      'Записано / 620',
    ]);
    expect(ru).toContain('>Подогрев</span>');
    // Итог — фишкой своего тона в заголовке раздела, а не хвостом строки.
    expect(ru).toMatch(
      /data-hub-keep-warm-verdict="saved">сберёг ≈ 190\sтыс\. токенов по цене входа</,
    );
    // Между числом и «тыс.» Intl ставит неразрывный пробел.
    expect(ru).toMatch(
      /data-hub-keep-warm-pending="true">текущее ожидание стоит ≈ 1\sтыс\. токенов по цене входа; окупилось ли — станет ясно, когда группа продолжит</,
    );
    // Счёта сессий нет — нет и ряда «Сессии».
    expect(ru).not.toContain('data-hub-usage');
    await i18n.changeLanguage('en');
    const en = tokensBlock(render({ ...waiting, tokenLedger: { at: keepWarm.lastAt, keepWarm } }));
    expect(en).toContain('data-hub-keep-warm-verdict="saved">saved ≈ 190K tokens at input price<');
    expect(cells(en, 'data-hub-keep-warm')).toEqual([
      'Pings / 3',
      'Cache hits / 2',
      'Misses / 1',
      'Read / 241K',
      'Written / 620',
    ]);
    expect(en).toContain(
      'the current wait costs ≈ 1K tokens at input price; whether it paid off shows when the group resumes',
    );
  });

  it('итог ещё не подведён — только расход ожидания; прежний «сберёг» без итога не показывается', async () => {
    const waiting = { status: 'awaiting' as const, waitingFor: 'question' as const };
    const keepWarm = {
      pings: 1,
      hits: 1,
      misses: 0,
      input: 3,
      cacheRead: 120_000,
      cacheWrite: 300,
      output: 2,
      pending: 12_000,
      lastAt: '2026-10-22T11:40:00.000Z',
    };
    await i18n.changeLanguage('en');
    const pending = tokensBlock(
      render({ ...waiting, tokenLedger: { at: keepWarm.lastAt, keepWarm } }),
    );
    expect(pending).toContain('the current wait costs ≈ 12K tokens at input price');
    expect(pending).not.toContain('data-hub-keep-warm-verdict');
    // Запись прежнего счёта: «сбережено» за попадание, без итога продолжения.
    const stale = { ...keepWarm, pending: undefined, saved: 205_000 };
    const old = tokensBlock(
      render({ ...waiting, tokenLedger: { at: keepWarm.lastAt, keepWarm: stale } }),
    );
    expect(old).not.toContain('data-hub-keep-warm-verdict');
    expect(old).not.toContain('the current wait costs');
    expect(cells(old, 'data-hub-keep-warm')).toContain('Pings / 1');
  });

  it('пинги стоили дороже сбережённого — «переплатил»; старый счёт без попаданий — все дошедшие попали', async () => {
    const waiting = { status: 'awaiting' as const, waitingFor: 'question' as const };
    const lost = {
      pings: 1,
      hits: 0,
      misses: 1,
      input: 3,
      cacheRead: 9_000,
      cacheWrite: 111_000,
      output: 2,
      saved: -222_913,
      settled: 1,
      realized: 0,
      lastAt: '2026-10-22T11:40:00.000Z',
    };
    await i18n.changeLanguage('ru');
    const ru = tokensBlock(
      render({ ...waiting, tokenLedger: { at: lost.lastAt, keepWarm: lost } }),
    );
    expect(cells(ru, 'data-hub-keep-warm')).toContain('Мимо / 1');
    expect(ru).toMatch(
      /data-hub-keep-warm-verdict="lost">переплатил ≈ 223\sтыс\. токенов по цене входа</,
    );
    const legacy = {
      pings: 2,
      input: 6,
      cacheRead: 1,
      cacheWrite: 2,
      output: 4,
      lastAt: lost.lastAt,
    };
    const old = tokensBlock(
      render({ ...waiting, tokenLedger: { at: lost.lastAt, keepWarm: legacy } }),
    );
    expect(cells(old, 'data-hub-keep-warm').slice(0, 3)).toEqual([
      'Пингов / 2',
      'Попали в кэш / 2',
      'Мимо / 0',
    ]);
    expect(old).not.toContain('сберёг');
  });

  it('итог ноль: «сберёг» — только если продолжение прочло удержанный кэш; иначе «переплатил», без «−0»', async () => {
    const waiting = { status: 'awaiting' as const, waitingFor: 'question' as const };
    const zero = {
      pings: 1,
      hits: 1,
      misses: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      saved: 0,
      settled: 1,
      realized: 0,
      lastAt: '2026-10-22T11:40:00.000Z',
    };
    await i18n.changeLanguage('ru');
    const nothing = tokensBlock(
      render({ ...waiting, tokenLedger: { at: zero.lastAt, keepWarm: zero } }),
    );
    expect(nothing).toContain('переплатил ≈ 0 токенов по цене входа');
    expect(nothing).not.toContain('сберёг');
    expect(nothing).not.toContain('-0');
    const evened = { ...zero, realized: 1 };
    const even = tokensBlock(
      render({ ...waiting, tokenLedger: { at: zero.lastAt, keepWarm: evened } }),
    );
    expect(even).toContain('сберёг ≈ 0 токенов по цене входа');
  });

  it('счёта нет — раздела нет', async () => {
    await i18n.changeLanguage('ru');
    expect(render({})).not.toContain('data-hub-tokens');
  });
});
