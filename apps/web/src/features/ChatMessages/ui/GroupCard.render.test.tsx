import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { i18n } from '@shared/config/i18n';
import { mergeSplitGroups, splitGroupKey } from '../lib/mergeSplitGroups';
import type { ChildStageGroup } from './ChildStages.types';
import { ChildStages } from './ChildStages';

const MR = 'https://tracker.example.com/team/app/-/merge_requests/898';
const BRANCH = 'fix-PROJ-1459-PROJ-1444-PROJ-1402-PROJ-1399-PROJ-1362/docs-fixes';

const split: SplitPlanView = {
  parentChatId: 'parent',
  triage: { at: '2026-10-05T10:00:00.000Z', received: true, repairs: [], conflicts: [] },
  order: [0],
  groups: [
    {
      index: 0,
      title: 'Документация',
      branch: BRANCH,
      after: [],
      status: 'done',
      deliver: true,
      mr: MR,
      chatId: 'c0',
      path: 'C:/copies/0',
    },
  ],
};

/**
 * Карточка группы (владелец 05.10.2026): кнопки — внутри неё, MR — своей
 * кнопкой, а не ссылкой внутри кликабельной строки; ветка — одной строкой с
 * подсказкой. Рисуется настоящей сводкой `ChildStages`, как её видит человек.
 */
function render(): string {
  const rows = new Map<string, ChildStageGroup>([
    [
      splitGroupKey({ groupIndex: 0, id: 'c0' }),
      { chatId: 'c0', title: 'Документация', branch: BRANCH, stages: ['work'], isRunning: false },
    ],
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages groups={mergeSplitGroups(rows, split)} onOpen={() => {}} />
    </QueryClientProvider>,
  );
}

/** Кусок разметки от открывающего тега с атрибутом до его закрытия того же тега. */
function element(html: string, attr: string, tag: string): string {
  const at = html.indexOf(attr);
  if (at < 0) return '';
  const start = html.lastIndexOf(`<${tag}`, at);
  return html.slice(start, html.indexOf(`</${tag}>`, at) + tag.length + 3);
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('карточка группы в хабе', () => {
  it('MR — отдельная кнопка, а не ссылка внутри открывающей чат', () => {
    const html = render();
    const open = element(html, 'data-hub-open', 'button');
    expect(open).toContain('Документация');
    expect(open).not.toContain(MR);
    expect(open).not.toContain('<a ');
    const mr = element(html, 'data-hub-mr', 'button');
    expect(mr).toContain('MR !898');
    expect(html).not.toContain(`href="${MR}"`);
  });

  it('кнопки группы — внутри её карточки', () => {
    const html = render();
    const card = html.slice(html.indexOf('data-hub-row="chat"'));
    const actions = card.indexOf('data-recheck-group');
    expect(actions).toBeGreaterThan(0);
    expect(card.indexOf('data-accept-group')).toBeGreaterThan(0);
    // Ни одна кнопка группы не стоит после конца её карточки — до раздела пересечений.
    const overlap = card.indexOf('Пересечения веток');
    expect(actions).toBeLessThan(overlap < 0 ? card.length : overlap);
  });

  it('ветка — одной строкой, текст целиком в разметке', () => {
    const html = render();
    expect(html).toContain(BRANCH);
    const branch = element(html, BRANCH, 'span');
    expect(branch).toMatch(/truncate/);
  });
});
