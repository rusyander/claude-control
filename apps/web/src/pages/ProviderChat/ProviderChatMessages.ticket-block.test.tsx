import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SPLIT_TICKET_TAG } from '@agentdeck/contracts/split-tickets';
import { ProviderChatMessages } from './ProviderChatMessages';

/**
 * Блок тикета группы (95b) в ленте чужого провайдера — та же чистка, что и у
 * ленты Claude (`ChatMessages.ticket-block.test.tsx`): список держит хаб, сырой
 * тег в реплике читается мусором.
 */

const TICKET = [
  `<${SPLIT_TICKET_TAG}>`,
  'title: Кнопка съезжает',
  'where: src/Foo.tsx:12',
  'why: перекрывает поле',
  `</${SPLIT_TICKET_TAG}>`,
].join('\n');

describe('лента чужого провайдера — блок тикета группы не показывается', () => {
  const renderForeign = (content: string, partial = ''): string =>
    renderToStaticMarkup(
      <ProviderChatMessages
        messages={
          content ? [{ id: 'm1', role: 'assistant', content, at: '2026-09-25T00:00:00Z' }] : []
        }
        providerName="Codex"
        partial={partial}
        isRunning={Boolean(partial)}
        isEmptyState={false}
        onCreate={() => {}}
        isCreating={false}
      />,
    );

  it('в записанной реплике', () => {
    const html = renderForeign(`Отчёт готов.\n\n${TICKET}\n\nКонец.`);

    expect(html).not.toContain('Кнопка съезжает');
    expect(html).toContain('Конец.');
  });

  it('в недописанной реплике', () => {
    const html = renderForeign('', `Отчёт.\n\n<${SPLIT_TICKET_TAG}>\ntitle: Кнопка съезжает`);

    expect(html).not.toContain('Кнопка съезжает');
    expect(html).toContain('Отчёт.');
  });
});
