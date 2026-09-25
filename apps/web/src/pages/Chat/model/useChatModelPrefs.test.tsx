import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatSummary } from '@agentdeck/contracts';
import '@shared/config/i18n/instance';
import { ChatModelPicker } from '@features/ChatModelPicker';
import { useChatModelPrefs } from './useChatModelPrefs';

/**
 * Глубина в шапке чата (находка 17 живого прогона 24.09): разбор шёл на xhigh —
 * так его завела панель, — а шапка показывала «Высокая» из настроек. Проверяется
 * тот же путь, что на странице: хук настроек разговора → выбор в шапке, с
 * настоящим русским словарём, а не с одними ключами.
 */

type Chat = Pick<ChatSummary, 'effort' | 'assignedModel'> | undefined;

function Header({
  chat,
  chatEffort,
  chatModel,
}: {
  chat: Chat;
  chatEffort: string;
  chatModel: string;
}) {
  const models = useChatModelPrefs('k', { chatModel, chatEffort }, chat);
  return (
    <>
      <ChatModelPicker
        model={models.modelOverride}
        effort={models.effortOverride}
        defaultModel={models.defaultModel}
        defaultEffort={models.defaultEffort}
        onModelChange={() => {}}
        onEffortChange={() => {}}
      />
      <output
        data-effective-effort={models.effective.effort}
        data-effective-model={models.effective.model}
      />
    </>
  );
}

const render = (chat: Chat, chatEffort = 'high', chatModel = ''): string =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <Header chat={chat} chatEffort={chatEffort} chatModel={chatModel} />
    </QueryClientProvider>,
  );

/** Подпись пункта «по умолчанию» в выборе глубины — то, что человек видит в шапке. */
const defaultEffortLabel = (html: string): string | undefined =>
  html.match(/aria-label="Глубина продумывания"[^>]*>\s*<option[^>]*value=""[^>]*>([^<]*)</)?.[1];

describe('глубина в шапке чата', () => {
  it('разговор с назначенной xhigh показывает «Оч. высокая», а не настройку', () => {
    const html = render({ effort: 'xhigh' });

    expect(defaultEffortLabel(html)).toBe('Оч. высокая');
    expect(html).toContain('data-effective-effort="xhigh"');
  });

  it('у каждой глубины своя подпись', () => {
    const labels = ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) =>
      defaultEffortLabel(render({ effort }, 'medium')),
    );

    expect(labels).toEqual(['Низкая', 'Средняя', 'Высокая', 'Оч. высокая', 'Максимум']);
  });

  it('без назначения — глубина из настроек', () => {
    const html = render({}, 'high');

    expect(defaultEffortLabel(html)).toBe('Высокая');
    expect(html).toContain('data-effective-effort="high"');
  });

  it('без разговора — глубина из настроек', () => {
    expect(defaultEffortLabel(render(undefined, 'low'))).toBe('Низкая');
  });
});

/** Подпись пункта «по умолчанию» в выборе модели. */
const defaultModelLabel = (html: string): string | undefined =>
  html.match(/aria-label="Модель"[^>]*>s*<option[^>]*value=""[^>]*>([^<]*)</)?.[1];

// Модель — по тому же правилу, что глубина (W3-5, владелец 25.09): группа,
// заведённая на haiku, не должна отвечать человеку на модели из настроек.
describe('модель в шапке чата', () => {
  it('назначенная разговору модель важнее настройки', () => {
    const html = render({ assignedModel: 'claude-haiku-4-5' }, 'high', 'claude-opus-4-1');

    expect(html).toContain('data-effective-model="claude-haiku-4-5"');
    expect(defaultModelLabel(html)).toContain('haiku');
  });

  it('без назначения — модель из настроек', () => {
    const html = render({}, 'high', 'claude-opus-4-1');

    expect(html).toContain('data-effective-model="claude-opus-4-1"');
    expect(defaultModelLabel(html)).toContain('opus');
  });
});
