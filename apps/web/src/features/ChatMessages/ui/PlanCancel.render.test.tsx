import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatTreeView, SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { i18n } from '@shared/config/i18n';
import { mergeSplitGroups } from '../lib/mergeSplitGroups';
import { ChildStages } from './ChildStages';

type Group = SplitPlanView['groups'][number];

const group = (index: number, status: Group['status']): Group => ({
  index,
  title: `Группа ${index}`,
  branch: `agent/g${index}`,
  after: [],
  status,
});

const plan = (groups: Group[], extra: Partial<SplitPlanView> = {}): SplitPlanView =>
  ({
    parentChatId: 'parent',
    order: groups.map((g) => g.index),
    groups,
    ...extra,
  }) as SplitPlanView;

/**
 * «Отменить план» в шапке хаба (W3-5): настоящая карточка `ChildStages` с
 * деревом, как её видит человек. Кнопка — только у идущего и не отменённого
 * плана: отменять закрытый нечего, а лишняя кнопка звала бы гасить пустоту.
 */
function render(split: SplitPlanView): string {
  const tree = { root: 'parent', running: 0, split } as unknown as ChatTreeView;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages groups={mergeSplitGroups(new Map(), split)} onOpen={() => {}} tree={tree} />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('«Отменить план» в хабе разделения', () => {
  it('идущий план — кнопка есть и подписана', () => {
    const html = render(plan([group(0, 'started'), group(1, 'pending')]));

    expect(html).toContain('data-plan-cancel');
    expect(html).toContain('Отменить план');
  });

  // Отметка отмены важнее статусов: строка группы может отстать от записи на
  // такт опроса, и кнопка не должна звать отменить уже отменённое.
  it('отменённый план — кнопки нет, даже если статус группы отстал', () => {
    const html = render(
      plan([group(0, 'failed'), group(1, 'started')], { cancelledAt: '2026-09-25T10:00:00.000Z' }),
    );

    expect(html).not.toContain('data-plan-cancel');
  });

  it('все группы закончились — кнопки нет', () => {
    const html = render(plan([group(0, 'done'), group(1, 'failed')]));

    expect(html).not.toContain('data-plan-cancel');
  });
});
