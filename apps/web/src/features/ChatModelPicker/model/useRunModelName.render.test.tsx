import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@shared/config/i18n/instance';
import { useRunModelName, type RunModelNameInput } from './useRunModelName';

/**
 * Подпись ожидания «<модель> думает над ответом» (ревью W3-17a, M-F2): чат любого CLI теперь в
 * `/chat`, и разговор Qwen без выбранной модели подписывался моделью Claude по умолчанию —
 * «Opus 4.8 (1M) думает», хотя пишет Qwen. План контура в этом рендере не приходит (запроса нет),
 * значит считается дорога без контура.
 */
function Caption(input: RunModelNameInput) {
  return <output>{useRunModelName(input)}</output>;
}

const caption = (input: RunModelNameInput): string =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <Caption {...input} />
    </QueryClientProvider>,
  ).replace(/<\/?output>/g, '');

describe('имя модели в подписи ожидания', () => {
  it('Claude без выбора — модель Claude по умолчанию', () => {
    expect(caption({ model: '' })).toBe('Opus 4.8 (1M)');
    expect(caption({ model: '', cli: 'claude' })).toBe('Opus 4.8 (1M)');
  });

  it('другой CLI без выбора — не модель Claude, а «Агент»', () => {
    expect(caption({ model: '', cli: 'qwen' })).toBe('Агент');
  });

  it('другой CLI с выбранной моделью — её имя', () => {
    expect(caption({ model: '', defaultModel: 'qwen3-coder-plus', cli: 'qwen' })).toBe(
      'Qwen3-coder-plus',
    );
  });
});
