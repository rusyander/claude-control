import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BuiltinGroupsStatus } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';
import { queryKeys } from '@shared/api/query-keys';
import { BuiltinRestoreButton } from './BuiltinRestoreButton';

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

function render(status: BuiltinGroupsStatus): string {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(queryKeys.groupBuiltin, status);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <BuiltinRestoreButton />
    </QueryClientProvider>,
  );
}

describe('«Вернуть встроенные»', () => {
  it('называет число удалённых человеком встроенных групп', () => {
    const html = render({ removed: ['builtin-mr-review', 'builtin-delivery'], edited: [] });
    expect(html).toContain('Вернуть встроенные (2)');
  });

  it('удалённых нет — кнопки нет, даже если есть изменённые', () => {
    expect(render({ removed: [], edited: ['builtin-delivery'] })).toBe('');
  });
});
