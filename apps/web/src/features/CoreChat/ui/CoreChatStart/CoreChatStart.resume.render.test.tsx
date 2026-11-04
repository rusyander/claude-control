import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { i18n } from '@shared/config/i18n';
import { CoreChatStart } from './CoreChatStart';

/**
 * Форма чата ядра, открытая «Продолжить через ядро» (этап 10, F2): заголовок и подпись называют
 * продолжаемый разговор, выбор CLI закреплён — разговор продолжает только тот CLI, чей он.
 * Новый чат — как был: CLI выбирается, подписи о продолжении нет.
 */

const ID = '0d3c2b1a-9e8f-4a7b-8c6d-5e4f3a2b1c0d';

const render = (resume?: string): string =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <CoreChatStart
        onStarted={() => {}}
        initialProject="C:/w/app"
        initialCli="claude"
        {...(resume !== undefined ? { resume } : {})}
      />
    </QueryClientProvider>,
  );

const cliSelect = (html: string): string =>
  /<div data-core-chat-cli[^>]*>[\s\S]*?<select[^>]*>/.exec(html)?.[0] ?? '';

describe('форма чата ядра — продолжение разговора', () => {
  it('продолжение: заголовок и подпись с id, CLI закреплён', async () => {
    await i18n.changeLanguage('ru');
    const html = render(ID);
    expect(html).toContain('Продолжить разговор через ядро');
    expect(html).toContain('data-core-chat-resume');
    expect(html).toContain(ID);
    expect(cliSelect(html)).toMatch(/disabled/);
  });

  it('новый чат: ни подписи, ни закрепления', async () => {
    await i18n.changeLanguage('ru');
    const html = render();
    expect(html).toContain('Новый чат');
    expect(html).not.toContain('data-core-chat-resume');
    expect(cliSelect(html)).not.toMatch(/disabled/);
    expect(cliSelect(html)).not.toBe('');
  });
});
