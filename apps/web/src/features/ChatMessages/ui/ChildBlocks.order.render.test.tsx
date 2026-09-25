import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { i18n } from '@shared/config/i18n';
import { mergeSplitGroups, splitGroupKey } from '../lib/mergeSplitGroups';
import type { ChildStageGroup } from './ChildStages.types';
import { ChildBlocks } from './ChildBlocks';

type Group = SplitPlanView['groups'][number];

/**
 * Хаб родителя настоящей карточкой: полоса запросов детей стоит НАД строками
 * групп (аудит 25.09, L153 — под хабом из десятка групп карточку права не
 * находили), а отметки «разрешено автоматически» строки «с отметкой» видны в
 * строке своей группы (L51).
 */

const group = (index: number, extra: Partial<Group> = {}): Group => ({
  index,
  title: `Группа ${index}`,
  branch: `agent/g${index}`,
  after: [],
  status: 'started',
  ...extra,
});

function render(groups: Group[], withAsk: boolean): string {
  // Строки идущих групп — как их собирает хаб из чатов детей.
  const rows = new Map<string, ChildStageGroup>(
    groups
      .filter((item) => item.chatId)
      .map((item) => [
        splitGroupKey({ groupIndex: item.index, id: '' }),
        { chatId: item.chatId ?? '', title: item.title, stages: ['work'], isRunning: true },
      ]),
  );
  const stages = mergeSplitGroups(rows, {
    parentChatId: 'parent',
    triage: { at: '2026-09-25T10:00:00.000Z', received: true, repairs: [], conflicts: [] },
    order: groups.map((item) => item.index),
    groups,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildBlocks
        stages={stages}
        onOpenChild={() => {}}
        {...(withAsk
          ? {
              permissions: [
                {
                  chatId: 'g1',
                  title: 'Группа 1',
                  permissions: [
                    { toolUseId: 'tu-1', toolName: 'Bash', input: { command: 'git push -f' } },
                  ],
                },
              ] as never,
              onPermissionDecide: () => {},
            }
          : {})}
      />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('хаб родителя: порядок и отметки', () => {
  it('полоса запросов детей — над строками хаба', () => {
    const html = render([group(0), group(1)], true);
    const asks = html.indexOf('data-child-asks');
    const hub = html.indexOf('data-child-hub');
    expect(asks).toBeGreaterThanOrEqual(0);
    expect(hub).toBeGreaterThan(asks);
  });

  it('без запросов полосы нет вовсе', () => {
    expect(render([group(0)], false)).not.toContain('data-child-asks');
  });

  it('отметки «разрешено автоматически» — в строке своей группы, с кнопкой «Убрать»', () => {
    const html = render(
      [
        group(0, {
          chatId: 'c0',
          autoNotices: [
            { at: '2026-09-25T10:01:00.000Z', summary: 'pnpm build' },
            { at: '2026-09-25T10:02:00.000Z', summary: 'git commit -m fix' },
          ],
        }),
        group(1, { chatId: 'c1' }),
      ],
      false,
    );
    expect(html).toContain('data-auto-notices="2"');
    expect(html).toContain('Разрешено автоматически: pnpm build; git commit -m fix');
    expect(html).toContain('Убрать');
    expect(html.split('data-auto-notices').length - 1).toBe(1);
  });
});
