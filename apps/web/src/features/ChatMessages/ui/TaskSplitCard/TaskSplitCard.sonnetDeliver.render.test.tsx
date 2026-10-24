import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TaskSplitProposal } from '@agentdeck/contracts/task-split';
import { queryKeys } from '@shared/api/query-keys';
import { i18n } from '@shared/config/i18n';
import { TaskSplitCard } from './TaskSplitCard';

const proposal = {
  reason: 'две независимые задачи',
  groups: [
    { title: 'Формат цены', branch: 'fix/format-price', tasks: ['formatPrice'] },
    { title: 'Сумма', branch: 'fix/math-sum', tasks: ['sum'] },
  ],
} as TaskSplitProposal;

const CEILING = { model: 'claude-opus-5', effort: 'high' };

/** План групп через контур: карта моделей — та, что пришла бы с сервера. */
function routedPlan(map: Record<string, string>) {
  return {
    routed: true,
    title: 'Контур QA',
    rules: { model: 'qwen-large', source: 'default', map, catalog: ['qwen-mid', 'qwen-large'] },
    effort: false,
  };
}

function render(
  options: {
    ceiling?: typeof CEILING;
    sonnetDeliver?: boolean;
    groupsPlan?: ReturnType<typeof routedPlan>;
  } = {},
): string {
  const client = new QueryClient();
  if (options.sonnetDeliver !== undefined) {
    client.setQueryData(queryKeys.settings, {
      groupEconomy: { sonnetDeliver: options.sonnetDeliver },
    });
  }
  if (options.groupsPlan) {
    client.setQueryData(queryKeys.platformRunPlan('groups', ''), options.groupsPlan);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TaskSplitCard
        proposal={proposal}
        onSplit={() => {}}
        {...(options.ceiling ? { ceiling: options.ceiling } : {})}
      />
    </QueryClientProvider>,
  );
}

/** Состояния переключателей «Доставка на Sonnet» по порядку групп. */
function deliverStates(html: string): string[] {
  return [
    ...html.matchAll(/data-sonnet-deliver="\d+"[^>]*>\s*<button[^>]*aria-checked="(true|false)"/g),
  ].map((match) => match[1] ?? '');
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

/**
 * F-12 ревью П1: рычаг «Доставка на Sonnet» был только общим, и одну дорогую
 * группу среди механических нельзя было оставить доставлять на своей модели.
 */
describe('TaskSplitCard: своя доставка на Sonnet у группы', () => {
  it('при подборе модели у каждой группы переключатель, по умолчанию включён', () => {
    const html = render({ ceiling: CEILING });

    expect(deliverStates(html)).toEqual(['true', 'true']);
    expect(html).toContain('Доставка группы «Формат цены» на Sonnet');
  });

  it('общий рычаг выключен в настройках — переключатели групп стоят выключенными', () => {
    expect(deliverStates(render({ ceiling: CEILING, sonnetDeliver: false }))).toEqual([
      'false',
      'false',
    ]);
  });

  it('без подбора модели доставки конвейера нет — и переключателя нет', () => {
    expect(render()).not.toContain('data-sonnet-deliver');
  });

  /**
   * n6 (план экономии, 22.10): через контур доставка идёт строкой карты «sonnet»
   * — сервер пускает её только при такой строке. До правки карточка прятала
   * переключатель на любом маршруте через контур, и выбрать доставку группы
   * своей моделью было нельзя.
   */
  it('через контур со строкой «sonnet» — переключатель есть и называет модель карты', () => {
    const html = render({ ceiling: CEILING, groupsPlan: routedPlan({ Sonnet: 'qwen-mid' }) });

    expect(deliverStates(html)).toEqual(['true', 'true']);
    expect(html).toContain('Доставка на Sonnet — по карте контура qwen-mid');
    expect(html).toContain('доставка идёт строкой «sonnet» карты моделей — на qwen-mid');
  });

  it('через контур без строки «sonnet» — рычаг не действует, переключателя нет', () => {
    const html = render({ ceiling: CEILING, groupsPlan: routedPlan({ opus: 'qwen-large' }) });

    expect(html).not.toContain('data-sonnet-deliver');
  });

  it('строка «sonnet» с пустой моделью — не строка: переключателя нет', () => {
    const html = render({ ceiling: CEILING, groupsPlan: routedPlan({ sonnet: '  ' }) });

    expect(html).not.toContain('data-sonnet-deliver');
  });
});
