import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LocalActivity } from '@agentdeck/contracts/local-models';
import { i18n } from '@shared/config/i18n';
import { queryKeys } from '@shared/api/query-keys';
import { LocalRunStatus } from './LocalRunStatus';

/**
 * Строка локальной модели под ходом (L6, этап 10 C3d; этап 11 W2-5): сервер, этап хода по ленте
 * звена ядра и кнопка перезапуска — у отказа сервера, у «молчит» и у застоя.
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

describe('LocalRunStatus: этапы хода по ленте звена ядра (этап 11, W2-5)', () => {
  const flying = (over: Partial<LocalActivity>): LocalActivity => ({
    model: 'qwen3',
    context: 32768,
    lastRequestAt: NOW - 30_000,
    inFlight: 1,
    startedAt: NOW - 30_000,
    lastMoveAt: NOW,
    stalled: false,
    stallMs: 120_000,
    ...over,
  });
  /** Текст разметки без тегов, пробелы свёрнуты (число по-русски — с неразрывным пробелом). */
  const text = (html: string): string =>
    html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  it.each([
    ['starting', flying({ phase: 'starting' }), 'сервер моделей поднимается'],
    ['loading', flying({ phase: 'loading' }), 'модель загружается в память'],
    ['queued', flying({ phase: 'queued' }), 'запрос ждёт, пока сервер его возьмёт'],
    [
      'prompt',
      flying({ phase: 'prompt', prompt: { filled: 2048, total: 4096 }, decoded: 0 }),
      'читает промпт: 2 048 из 4 096 токенов',
    ],
    [
      'prompt',
      flying({ phase: 'prompt', prompt: { filled: 2048 }, decoded: 0 }),
      'читает промпт: 2 048 токенов',
    ],
    ['generating', flying({ phase: 'generating', decoded: 120 }), 'пишет ответ: 120 токенов'],
  ])('этап %s — своя строка', (stage, activity, says) => {
    const html = render(activity);
    expect(html).toContain(`data-stage="${stage}"`);
    expect(text(html)).toContain(says);
    expect(html).not.toContain(i18n.t('chat.localRun.restart'));
  });

  it('разбор промпта с известным итогом — полоса доли 50 %', () => {
    const html = render(flying({ phase: 'prompt', prompt: { filled: 2048, total: 4096 } }));
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="50"');
  });

  it('тишина дольше 20 с — «молчит» и кнопка перезапуска', () => {
    const html = render(
      flying({ phase: 'prompt', prompt: { filled: 10 }, lastMoveAt: NOW - 45_000 }),
    );
    expect(text(html)).toMatch(/сервер молчит 4\d с — застоем это станет через 7\d с/);
    expect(html).toContain(i18n.t('chat.localRun.restart'));
  });

  it('застой — «движения нет» и кнопка перезапуска', () => {
    const html = render(
      flying({ phase: 'prompt', prompt: { filled: 10 }, lastMoveAt: NOW - 130_000, stalled: true }),
    );
    expect(text(html)).toMatch(/движения нет 13\d с — сервер моделей, похоже, завис/);
    expect(html).toContain(i18n.t('chat.localRun.restart'));
  });
});
