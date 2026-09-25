import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StreamState } from '@shared/lib/chat-stream';
import { i18n } from '@shared/config/i18n';
import { ChatMessages } from './ChatMessages';
import type { ChatMessagesProps } from './ChatMessages.types';

/**
 * Карточка ошибки для известных ошибок CLI (живой прогон 25.09.2026):
 * переполненный родитель разделения и устаревший CLI показывались сырой
 * строкой API, а «Повторить» и «Продолжить» упирались в тот же переполненный
 * контекст. Теперь — объяснение словами интерфейса, сведения о CLI и выход.
 */

// Кнопки — по полному тексту: «Продолжить» входит в «Продолжить в новой сессии».
const RAW = 'Prompt is too long · automatic compaction failed: API Error: 400';

function render(extra: Partial<StreamState>): string {
  const stream: StreamState = {
    text: '',
    thinking: '',
    tools: [],
    isRunning: false,
    error: RAW,
    ...extra,
  };
  const props = {
    messages: [],
    stream,
    isLoading: false,
    onRetry: () => {},
    onContinue: () => {},
    onDismissError: () => {},
    onCompact: () => {},
    onFreshSession: () => {},
  } as unknown as ChatMessagesProps;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChatMessages {...props} />
    </QueryClientProvider>,
  );
}

describe('карточка ошибки — известные ошибки CLI', () => {
  it('устаревший CLI при переполнении: объяснение, сведения о CLI, выход вместо повтора', () => {
    const html = render({
      errorCode: 'cli-outdated',
      errorParams: { current: '2.1.278', required: '2.1.280' },
      errorOverflow: true,
    });

    expect(html).toContain('data-chat-error-explained');
    expect(html).toContain('2.1.278');
    expect(html).toContain('2.1.280');
    expect(html).toContain(i18n.t('chat.cli.loading'));
    expect(html).toContain(i18n.t('chat.overflow.compact'));
    expect(html).toContain(i18n.t('chat.overflow.fresh'));
    expect(html).not.toContain(`${i18n.t('chat.retry')}</button>`);
    expect(html).not.toContain(`${i18n.t('chat.continue')}</button>`);
    // Сырой текст остаётся — его несут в тикет.
    expect(html).toContain('Prompt is too long');
  });

  it('просто переполнение: объяснение и выход, сведений о CLI нет', () => {
    const html = render({ errorCode: 'prompt-too-long', errorOverflow: true });

    expect(html).toContain(i18n.t('serverMessages.prompt-too-long'));
    expect(html).toContain(i18n.t('chat.overflow.fresh'));
    expect(html).not.toContain(i18n.t('chat.cli.loading'));
  });

  it('обычная ошибка — как раньше: повтор и продолжение, без выхода из переполнения', () => {
    const html = render({ error: 'claude завершился с кодом 1' });

    expect(html).not.toContain('data-chat-error-explained');
    expect(html).toContain(`${i18n.t('chat.retry')}</button>`);
    expect(html).toContain(`${i18n.t('chat.continue')}</button>`);
    expect(html).not.toContain(i18n.t('chat.overflow.compact'));
    expect(html).not.toContain(i18n.t('chat.overflow.fresh'));
  });
});
