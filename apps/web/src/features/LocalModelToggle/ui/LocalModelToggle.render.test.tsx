import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LocalModelsInfo } from '@agentdeck/contracts/local-models';
import { i18n } from '@shared/config/i18n';
import { queryKeys } from '@shared/api/query-keys';
import { LocalModelToggle } from './LocalModelToggle';

/**
 * Кнопка локальной модели в шапке чата: снимок раздела — в кеше запроса тем ключом,
 * которым его спрашивает настоящий хук; сама кнопка не подменяется.
 */

const TAG = 'qwen3.8:27b';

function render(over: Partial<LocalModelsInfo>): string {
  const client = new QueryClient();
  client.setQueryData(queryKeys.localModels, {
    runtime: { source: 'panel' },
    installed: [{ tag: TAG }],
    catalog: { models: [{ tag: TAG, title: 'Qwen3.8 27B' }] },
    connect: { configured: true, active: false, model: TAG },
    server: { running: false },
    jobs: [],
    ...over,
  } as unknown as LocalModelsInfo);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <LocalModelToggle />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('LocalModelToggle', () => {
  it('выключено: «Локальная», не нажата, подсказка называет модель, которую включит', () => {
    const html = render({});
    expect(html).toContain('Локальная');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('Включить локальную модель Qwen3.8 27B');
  });

  it('включено и модель грузится: нажата, имя модели и «загружается»', () => {
    const html = render({
      connect: { configured: true, active: true, model: TAG },
      server: { running: false } as LocalModelsInfo['server'],
    });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Qwen3.8 27B');
    expect(html).toContain('загружается');
  });

  it('включено и готово: без «загружается»', () => {
    const html = render({
      connect: { configured: true, active: true, model: TAG },
      server: { running: true, model: TAG } as LocalModelsInfo['server'],
    });
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain('загружается');
  });

  it('нечего включать: кнопка есть и обещает объяснить, чего не хватает', () => {
    const html = render({ installed: [] });
    expect(html).toContain('Локальная');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('чего не хватает');
  });
});
