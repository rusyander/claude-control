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
 * @covers apps/web/src/features/ChatMessages/ui/GroupText/GroupHead.tsx
 * @covers apps/web/src/features/ChatMessages/lib/mergeSplitGroups.ts
 * @scenario Пауза сторожа (F1) на карточке группы: метка называет, что паузу
 * поставил сторож и по какому правилу; пауза человека — прежняя метка «на паузе»;
 * после «Продолжить» поля автора в записи остаются, а метки нет.
 */

type ViewGroup = SplitPlanView['groups'][number];

function merged(extra: Partial<ViewGroup>) {
  const split: SplitPlanView = {
    parentChatId: 'parent',
    triage: { at: '2026-10-27T09:00:00.000Z', received: true, repairs: [], conflicts: [] },
    order: [0],
    groups: [
      {
        index: 0,
        title: 'Форма входа',
        branch: 'feature/login',
        after: [],
        status: 'paused',
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
  return mergeSplitGroups(rows, split);
}

function render(extra: Partial<ViewGroup>): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages groups={merged(extra)} onOpen={() => {}} />
    </QueryClientProvider>,
  );
}

/** Метка паузы сторожа: тег и его текст. */
const watchChip = (html: string): string =>
  /<span[^>]*data-hub-paused-by="watch"[^>]*>[^<]*<\/span>/.exec(html)?.[0] ?? '';

afterAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('метка паузы сторожа на карточке группы (F1)', () => {
  it('ru: пауза сторожа — метка с правилом и подсказкой, прежней метки паузы нет', async () => {
    await i18n.changeLanguage('ru');
    const html = render({ pausedBy: 'watch', pausedRule: 'R4' });
    const chip = watchChip(html);
    expect(chip).toContain('пауза сторожа: R4');
    expect(chip).toContain('title="');
    expect(html).not.toContain('>на паузе<');
  });

  it('en: тот же признак своим языком', async () => {
    await i18n.changeLanguage('en');
    expect(watchChip(render({ pausedBy: 'watch', pausedRule: 'R12' }))).toContain('R12');
  });

  it('пауза человека — метки сторожа нет; группа идёт — нет ни одной', async () => {
    await i18n.changeLanguage('ru');
    const human = render({ pausedBy: 'human' });
    expect(watchChip(human)).toBe('');
    expect(human).toContain('>на паузе<');
    expect(watchChip(render({ status: 'started', pausedBy: 'watch', pausedRule: 'R4' }))).toBe('');
    // Строка группы сама не несёт автора прошлой паузы: поля записи остаются после «Продолжить».
    expect(
      merged({ status: 'started', pausedBy: 'watch', pausedRule: 'R4' })[0],
    ).not.toHaveProperty('pausedByWatch');
    expect(merged({ pausedBy: 'watch', pausedRule: 'R4' })[0]).toMatchObject({
      pausedByWatch: 'R4',
    });
  });
});
