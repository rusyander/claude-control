import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SplitSettingsView } from '@agentdeck/contracts/task-split';
import '@shared/config/i18n/instance';
import { SplitSettings } from './SplitSettings';

/**
 * Подпись подготовки копии (W3-5, L1): человек должен отличить команду,
 * которую задал сам, от той, что панель вывела по lock-файлу. Рисуется
 * настоящий компонент с настоящим русским словарём.
 */
function view(profile: Partial<SplitSettingsView['profile']>): SplitSettingsView {
  return {
    deliver: true,
    parallel: 2,
    parallelAuto: true,
    permissions: {} as SplitSettingsView['permissions'],
    permissionsOwn: [],
    profile: {
      enabled: true,
      repo: true,
      remote: true,
      bootstrapConfigured: false,
      heavy: false,
      ...profile,
    },
  };
}

const render = (value: SplitSettingsView): string =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <SplitSettings path="C:/work/probe" view={value} />
    </QueryClientProvider>,
  );

describe('подготовка новой копии в настройках доставки', () => {
  it('выведенная панелью — «определена автоматически» и сама команда', () => {
    const html = render(view({ bootstrap: 'pnpm install --frozen-lockfile' }));

    expect(html).toContain('Подготовка новой копии — определена автоматически:');
    expect(html).toContain('pnpm install --frozen-lockfile');
    expect(html).not.toContain('задана на проекте');
  });

  it('заданная на проекте — так и подписана', () => {
    const html = render(view({ bootstrap: 'npm ci', bootstrapConfigured: true }));

    expect(html).toContain('Подготовка новой копии — задана на проекте:');
    expect(html).not.toContain('определена автоматически');
  });

  it('без lock-файла — «ничего», а не пустая строка', () => {
    expect(render(view({}))).toContain('ничего: lock-файла нет');
  });
});
