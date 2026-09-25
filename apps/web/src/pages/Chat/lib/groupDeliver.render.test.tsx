import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatTreeView, SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { apiClient } from '@shared/api/client';
import { i18n } from '@shared/config/i18n';
import { DeliveryControl } from '@features/ProjectGit';
import { groupDeliverOf } from './childStages';

/**
 * Живой прогон 25.09 (O2): план шёл с «До MR» выключенным, а шапка чата группы
 * писала «До MR: вкл» — настройку проекта по пути копии. Путь шапки: дерево
 * родителя → `groupDeliverOf` → кнопка на настоящих запросах настроек.
 */

/** Настройки проекта: доставка включена, удалённый репозиторий есть. */
function serveProjectDeliverOn(): void {
  vi.spyOn(apiClient, 'get').mockImplementation(async (url: string) => ({
    data: url.includes('split-settings')
      ? { deliver: true, profile: { enabled: true, repo: true, remote: true } }
      : { deliverToMr: true },
  }));
}

/** Рендер с настоящими хуками: первый проход заводит запросы, второй видит данные. */
async function render(element: ReactElement): Promise<string> {
  const client = new QueryClient();
  const tree = <QueryClientProvider client={client}>{element}</QueryClientProvider>;
  renderToStaticMarkup(tree);
  await Promise.all(
    client
      .getQueryCache()
      .getAll()
      .map((query) => query.fetch()),
  );
  // Запрос настроек разделения заводится, только когда настройки панели уже есть.
  renderToStaticMarkup(tree);
  await Promise.all(
    client
      .getQueryCache()
      .getAll()
      .map((query) => query.fetch()),
  );
  return renderToStaticMarkup(tree);
}

const split: SplitPlanView = {
  parentChatId: 'parent',
  order: [1],
  groups: [
    { index: 1, title: 'Группа 1', branch: 'fix/g1', after: [], status: 'started', deliver: false },
  ],
};
const tree: ChatTreeView = { root: 'parent', running: 1, nodes: [], split };

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

afterEach(() => vi.restoreAllMocks());

describe('шапка чата группы — «До MR»', () => {
  it('чат группы показывает решение плана, а не настройку проекта', async () => {
    serveProjectDeliverOn();
    const groupDeliver = groupDeliverOf(tree, { parentId: 'parent', groupIndex: 1 });

    const html = await render(
      <DeliveryControl
        path="C:/work/probe-g1"
        {...(groupDeliver === undefined ? {} : { groupDeliver })}
      />,
    );

    expect(html).toContain('До MR: выкл');
    expect(html).not.toContain('До MR: вкл');
  });

  it('обычный чат проекта — по-прежнему настройка проекта', async () => {
    serveProjectDeliverOn();
    const groupDeliver = groupDeliverOf(tree, { parentId: 'other', groupIndex: 1 });

    expect(groupDeliver).toBeUndefined();
    expect(await render(<DeliveryControl path="C:/work/probe" />)).toContain('До MR: вкл');
  });
});
