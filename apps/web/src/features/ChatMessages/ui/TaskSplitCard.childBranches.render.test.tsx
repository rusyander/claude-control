import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TaskSplitProposal } from '@agentdeck/contracts/task-split';
import { i18n } from '@shared/config/i18n';
import { TaskSplitCard } from './TaskSplitCard';
import type { ChildBranch } from './TaskSplitCard.types';

const proposal: TaskSplitProposal = {
  reason: 'три независимых дефекта',
  groups: [
    { title: 'Формат цены', branch: 'fix/format-price', tasks: ['formatPrice'] },
    { title: 'Комментарий', branch: 'fix/index-entry', tasks: ['index.js'] },
    { title: 'Сумма', branch: 'fix/math-sum-validation', tasks: ['sum'] },
  ],
} as TaskSplitProposal;

const PROPOSED_AT = '2026-09-25T12:30:00.000Z';

function render(childBranches: readonly ChildBranch[]): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TaskSplitCard
        proposal={proposal}
        onSplit={() => {}}
        childBranches={childBranches}
        proposedAt={PROPOSED_AT}
      />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

/**
 * Живой прогон 25.09 (N3): план отменён, его чаты остались под родителем, новое
 * предложение агента назвало те же ветки — карточка сочла его «уже разделённым»
 * и спрятала «Разделить на 3». Отработанным предложение делают только чаты,
 * заведённые ПОСЛЕ него: раньше заведённые из него не рождались.
 */
describe('TaskSplitCard: какие чаты делают предложение отработанным', () => {
  it('ветки прошлого плана, заведённые до предложения, кнопку не прячут', () => {
    const html = render([
      { branch: 'fix/format-price', createdAt: '2026-09-25T12:10:00.000Z' },
      { branch: 'fix/index-entry', createdAt: '2026-09-25T12:10:01.000Z' },
    ]);

    expect(html).not.toContain('Уже разделено');
    expect(html).toContain('Разделить на 3');
  });

  it('чаты, заведённые после предложения, — отработано, кнопки нет', () => {
    const html = render([
      { branch: 'fix/format-price', createdAt: '2026-09-25T12:31:00.000Z' },
      { branch: 'fix/index-entry-2', createdAt: '2026-09-25T12:31:01.000Z' },
    ]);

    expect(html).toContain('Уже разделено: 2 из 3');
    expect(html).not.toContain('Разделить на 3');
  });
});
