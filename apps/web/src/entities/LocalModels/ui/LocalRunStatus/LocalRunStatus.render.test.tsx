import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LocalActivity } from '@agentdeck/contracts/local-models';
import { i18n } from '@shared/config/i18n';
import { queryKeys } from '@shared/api/query-keys';
import { LocalRunStatus } from './LocalRunStatus';

/**
 * Строка локальной модели под ходом (L6, этап 10 C3d): сервер, этап хода и отказ сервера с кнопкой
 * перезапуска — кнопка теперь стоит у отказа, а не у «молчит», которого без ленты звена нет.
 * Ответ `/local-models/activity` кладётся в кэш запроса; сеть не нужна.
 */

const NOW = Date.now();

function render(activity: LocalActivity, waitingPermission = false, since?: number): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.localActivity, activity);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <LocalRunStatus waitingPermission={waitingPermission} since={since} />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('LocalRunStatus: строка локальной модели под ходом', () => {
  it('отказ сервера в этом ходе: код и текст красным и кнопка «Перезапустить сервер», этап failed', () => {
    const html = render(
      {
        model: 'qwen3',
        quant: 'Q4_K_M',
        context: 32768,
        lastRequestAt: NOW,
        lastError: { at: NOW, status: 500, message: 'template error' },
      },
      false,
      NOW - 5_000,
    );
    expect(html).toContain('data-stage="failed"');
    expect(html).toContain('500');
    expect(html).toContain('template error');
    expect(html).toContain(i18n.t('chat.localRun.restart'));
  });

  it('ход без отказа: сервер назван, кнопки перезапуска нет', () => {
    const html = render({ model: 'qwen3', context: 32768, lastRequestAt: NOW }, false, NOW - 5_000);
    expect(html).toContain('data-stage="idle"');
    expect(html).toContain('qwen3');
    expect(html).not.toContain(i18n.t('chat.localRun.restart'));
  });
});
