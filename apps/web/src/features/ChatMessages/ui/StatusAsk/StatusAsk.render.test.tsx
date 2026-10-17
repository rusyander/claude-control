import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatTreeView, SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { i18n } from '@shared/config/i18n';
import { mergeSplitGroups } from '../../lib/mergeSplitGroups';
import { ChildStages } from '../ChildStages/ChildStages';

const plan = (): SplitPlanView =>
  ({
    parentChatId: 'parent',
    order: [0],
    groups: [{ index: 0, title: 'Вход', branch: 'agent/g0', after: [], status: 'started' }],
  }) as unknown as SplitPlanView;

/**
 * «Спросить о ходе групп» в хабе разделения (5.1 плана экономии): настоящая
 * карточка `ChildStages`, как её видит человек. Поле — у своего разделения;
 * у чужого CLI вопрос завести нечем, а у разговора без плана — не о чем.
 */
function render(split: SplitPlanView, { foreign = false, withPlan = true } = {}): string {
  // Строки групп те же, а плана в дереве нет — хаб старых связей без записи конвейера.
  const tree = { root: 'parent', running: 0, split: withPlan ? split : undefined };
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages
        groups={mergeSplitGroups(new Map(), split)}
        onOpen={() => {}}
        tree={tree as unknown as ChatTreeView}
        foreign={foreign}
      />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('«Спросить о ходе групп» в хабе разделения', () => {
  it('своё разделение — поле с подписью, подсказкой и кнопкой, пустой вопрос не отправить', () => {
    const html = render(plan());

    expect(html).toContain('data-status-ask');
    expect(html).toContain(i18n.t('chat.cascade.hub.statusAsk.label'));
    expect(html).toContain(i18n.t('chat.cascade.hub.statusAsk.hint'));
    expect(html).toContain(i18n.t('chat.cascade.hub.statusAsk.send'));
    // Кнопка заперта, пока вопрос пуст.
    const submit = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0];
    expect(submit).toContain('disabled=""');
  });

  it('чужой CLI — поля нет', () => {
    expect(render(plan(), { foreign: true })).not.toContain('data-status-ask');
  });

  it('группы без записи плана — поля нет: спросить сервер не о чем', () => {
    const html = render(plan(), { withPlan: false });

    expect(html).toContain('Вход');
    expect(html).not.toContain('data-status-ask');
  });
});
