import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProviderChatMessages } from './ProviderChatMessages';

/**
 * Блок критического замечания (`agentdeck:escalate`) в ленте чужого провайдера.
 * Чужие дочерние чаты его пишут (строки группы звена), сервер подбирает, а
 * человеку нужна карточка/строка, не сырой JSON — та же чистка, что у ленты
 * Claude (`MessageBubble`, `StreamedAnswer`) и у телефона.
 */

const BLOCK = [
  '```agentdeck:escalate',
  '{"severity":"critical","text":"Миграция ломает прод"}',
  '```',
].join('\n');

describe('лента чужого провайдера — блок эскалации не показывается', () => {
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
    const html = renderForeign(`Отчёт готов.\n\n${BLOCK}\n\nКонец.`);

    expect(html).not.toContain('agentdeck:escalate');
    expect(html).not.toContain('severity');
    expect(html).toContain('Конец.');
  });

  // Ревью 28.09 (F-226, сосед ленты Claude): блок вырезался и из текста
  // человека — тот, кто описывал формат, видел свой пример пустым.
  it('в реплике человека блок не вырезается', () => {
    const html = renderToStaticMarkup(
      <ProviderChatMessages
        messages={[
          { id: 'u1', role: 'user', content: `Формат:\n\n${BLOCK}`, at: '2026-09-25T00:00:00Z' },
        ]}
        providerName="Codex"
        partial=""
        isRunning={false}
        isEmptyState={false}
        onCreate={() => {}}
        isCreating={false}
      />,
    );

    expect(html).toContain('Миграция ломает прод');
    expect(html).toContain('agentdeck:escalate');
  });

  it('в недописанной реплике — с открывающей кавычки', () => {
    const html = renderForeign('', 'Отчёт.\n\n```agentdeck:escalate\n{"severity":"crit');

    expect(html).not.toContain('agentdeck:escalate');
    expect(html).not.toContain('severity');
    expect(html).toContain('Отчёт.');
  });
});
