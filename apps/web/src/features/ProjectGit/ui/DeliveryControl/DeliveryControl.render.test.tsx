import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { i18n } from '@shared/config/i18n';
import { DeliveryControl } from './DeliveryControl';

/**
 * Кнопка «До MR» в шапке чата на настоящих запросах настроек: подпись — настройка
 * проекта. Решения плана разделения у шапки больше нет — дерево его не отдаёт.
 */

/** Настройки проекта: доставка `deliver`, удалённый репозиторий есть. */
function serveProject(deliver: boolean): void {
  vi.spyOn(apiClient, 'get').mockImplementation(async (url: string) => ({
    data: url.includes('split-settings')
      ? { deliver, profile: { enabled: true, repo: true, remote: true } }
      : { deliverToMr: true },
  }));
}

/** Рендер с настоящими хуками: первый проход заводит запросы, второй видит данные. */
async function render(element: ReactElement): Promise<string> {
  const client = new QueryClient();
  const tree = <QueryClientProvider client={client}>{element}</QueryClientProvider>;
  const settle = () =>
    Promise.all(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.fetch()),
    );
  renderToStaticMarkup(tree);
  await settle();
  // Запрос настроек разделения заводится, только когда настройки панели уже есть.
  renderToStaticMarkup(tree);
  await settle();
  return renderToStaticMarkup(tree);
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

afterEach(() => vi.restoreAllMocks());

describe('шапка чата — «До MR»', () => {
  it('доставка проекта включена — «До MR: вкл» и подсказка про проект', async () => {
    serveProject(true);
    const html = await render(<DeliveryControl path="C:/work/probe" />);
    expect(html).toContain('До MR: вкл');
    expect(html).toContain('Доставка задач этого проекта до готового MR');
  });

  it('доставка проекта выключена — «До MR: выкл»', async () => {
    serveProject(false);
    const html = await render(<DeliveryControl path="C:/work/probe" />);
    expect(html).toContain('До MR: выкл');
    expect(html).not.toContain('До MR: вкл');
  });
});
