import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskSplitProposal } from '@agentdeck/contracts/task-split';
import { i18n } from '@shared/config/i18n';
import { TaskSplitCard } from './TaskSplitCard';

const proposal = {
  reason: 'два независимых дефекта',
  shared: 'Ветки от main.',
  groups: [
    { title: 'Формат цены', branch: 'fix/format-price', tasks: ['formatPrice', 'parsePrice'] },
    {
      title: 'Ревью MR',
      branch: 'review/mr-12',
      tasks: ['Ревью MR'],
      review: { url: 'https://tracker.example.com/group/app/-/merge_requests/12' },
    },
  ],
  dropped: { tasks: 3 },
} as TaskSplitProposal;

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

/**
 * Разделение из чата снято вместе с маршрутом — карточка осталась записью
 * истории. Проверяется настоящая отрисовка: состав и ветки видны, решать по
 * карточке нечем (ни кнопки, ни переключателя, ни выбора модели).
 */
describe('TaskSplitCard — запись истории', () => {
  it('показывает группы, ветки, ссылку ревью и отброшенное, без элементов управления', () => {
    const html = renderToStaticMarkup(<TaskSplitCard proposal={proposal} />);

    expect(html).toContain('fix/format-price');
    expect(html).toContain('parsePrice');
    expect(html).toContain('merge_requests/12');
    expect(html).toContain('Ветки от main.');
    expect(html).toContain('data-split-dropped="tasks"');
    // Единственный пункт, равный заголовку, вторым списком не печатается.
    expect(html.match(/Ревью MR/g)).toHaveLength(1);
    expect(html).not.toMatch(/<button|<select|role="switch"/);
  });
});
