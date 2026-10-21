import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { GroupSignal } from '@agentdeck/contracts/group-watch';
import { i18n } from '@shared/config/i18n';
import { mergeSplitGroups } from '../../lib/mergeSplitGroups';
import type { ChildStageGroup } from '../ChildStages.types';
import { ChildStages } from '../ChildStages/ChildStages';
import { splitGroupKey } from '../../lib/splitGroupKey';

/**
 * Сигналы сторожа групп (фаза 2, W.4) — остров в карточке группы и фишка в
 * сводке хаба. Рисуется настоящей сводкой `ChildStages` из вида плана, как его
 * отдаёт сервер (`watchSignals`), — без подмены промежуточных слоёв.
 */
const signal = (over: Partial<GroupSignal>): GroupSignal => ({
  id: over.rule ?? 'x',
  rule: 'R4',
  severity: 'warn',
  groupIndex: 0,
  chatId: 'c0',
  stage: 'work',
  at: '2026-10-20T10:00:00.000Z',
  numbers: { runs: 3 },
  textKey: 'groupWatch.rule.R4',
  ...over,
});

function render(signals: GroupSignal[] | undefined): string {
  const split: SplitPlanView = {
    parentChatId: 'parent',
    order: [0],
    groups: [
      {
        index: 0,
        title: 'Работа',
        branch: 'feat/PROJ-1',
        after: [],
        status: 'started',
        chatId: 'c0',
        ...(signals ? { watchSignals: signals } : {}),
      },
    ],
  } as SplitPlanView;
  const rows = new Map<string, ChildStageGroup>([
    [
      splitGroupKey({ groupIndex: 0, id: 'c0' }),
      { chatId: 'c0', title: 'Работа', branch: 'feat/PROJ-1', stages: ['work'], isRunning: true },
    ],
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages groups={mergeSplitGroups(rows, split)} onOpen={() => {}} />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

/** Фишка сигналов в сводке хаба: её тон и её собственный текст, не текст острова. */
function hubChip(html: string): { tone?: string; text?: string } {
  const match = /<span[^>]*data-hub-count="signals"[^>]*data-hub-tone="(\w+)"[^>]*>([^<]*)</.exec(
    html,
  );
  return { tone: match?.[1], text: match?.[2] };
}

describe('сигналы сторожа в хабе', () => {
  it('активный сигнал — строкой с числами, ссылкой на чат и фишкой в сводке', () => {
    const html = render([signal({ params: { command: 'npx vitest run src/a.test.ts' } })]);
    expect(html).toContain('data-group-watch="1"');
    expect(html).toContain('Одна проверка по кругу без правки между: запусков 3');
    expect(html).toContain('команда: npx vitest run src/a.test.ts');
    expect(html).toContain('data-watch-open');
    expect(html).toContain('Открыть чат');
    expect(hubChip(html)).toEqual({ tone: 'warn', text: 'сигнал: 1' });
  });

  it('тревога красит остров; закрытые сигналы свёрнуты и в счётчик не идут', () => {
    const html = render([
      signal({
        id: 'a',
        rule: 'R1',
        severity: 'alert',
        numbers: { idleMin: 25 },
        textKey: 'groupWatch.rule.R1',
      }),
      signal({ id: 'b', clearedAt: '2026-10-20T10:05:00.000Z' }),
    ]);
    expect(html).toContain('Группа молчит 25 мин');
    expect(html).toContain('island-alert');
    expect(html).toContain('закрытый сигнал: 1');
    // Свёрнуто: строки закрытого сигнала в разметке нет.
    expect(html).not.toContain('data-watch-cleared=""');
    expect(hubChip(html)).toEqual({ tone: 'alarm', text: 'сигнал: 1' });
  });

  it('сигнал не сегодняшнего дня — время с датой, сегодняшний — только время', () => {
    const today = new Date();
    today.setHours(9, 30, 0, 0);
    const html = render([
      signal({ id: 'old', at: '2026-03-14T10:00:00.000Z' }),
      signal({ id: 'now', rule: 'R12', textKey: 'groupWatch.rule.R12', at: today.toISOString() }),
    ]);
    const times = [...html.matchAll(/class="[^"]*time[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(times).toHaveLength(2);
    expect(times[0]).toMatch(/14 мар/);
    expect(times[1]).toBe('09:30');
  });

  it('одни сведения — спокойная фишка, не выделение «ждёт вас»', () => {
    const html = render([
      signal({ id: 'i', rule: 'R12', severity: 'info', textKey: 'groupWatch.rule.R12' }),
    ]);
    expect(hubChip(html).tone).toBe('info');
  });

  it('без сигналов — ни острова, ни фишки', () => {
    const html = render(undefined);
    expect(html).not.toContain('data-group-watch');
    expect(html).not.toContain('data-hub-count="signals"');
  });
});
