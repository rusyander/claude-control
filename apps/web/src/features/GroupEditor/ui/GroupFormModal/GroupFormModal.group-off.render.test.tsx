import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Group } from '@agentdeck/contracts';
import { i18n } from '@shared/config/i18n';

/**
 * Сосед F-100: окно правки группы добавляет участников так же, как выбор шага,
 * и у ВЫКЛЮЧЕННОЙ группы сервер держит нового участника выключенным везде
 * (`reconcileMembers`). Окно обязано сказать это до отметки — у включённой
 * группы и у новой строки нет.
 */
vi.mock('@shared/ui/modal', () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@entities/Group', () => ({
  useSaveGroup: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock('@entities/Permission', () => ({
  permissionApi: { useList: () => ({ data: [] }) },
}));
vi.mock('../MemberPicker/MemberPicker', () => ({ MemberPicker: () => null }));
// Каталог участников и реестр проектов — для помощника формы; здесь не нужны.
vi.mock('../../model/useMemberCatalog', () => ({ useMemberCatalog: () => ({ items: [] }) }));
vi.mock('@entities/Project', () => ({ useProjectRegistry: () => ({ data: [] }) }));
vi.mock('../ProjectBinding/ProjectBinding', () => ({ ProjectBinding: () => null }));

const { GroupFormModal } = await import('./GroupFormModal');

const group = (isEnabled: boolean): Group =>
  ({
    id: 'g1',
    name: 'Ревью',
    members: [],
    isEnabled,
    scope: 'global',
  }) as unknown as Group;

const render = (value?: Group): string =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <GroupFormModal isOpen onOpenChange={() => {}} group={value} />
    </QueryClientProvider>,
  );

describe('окно группы: состав выключенной группы', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it('группа выключена — предупреждение, что новый участник выключится везде', () => {
    const html = render(group(false));
    expect(html).toContain(i18n.t('groups.membersGroupOff'));
    expect(html).toContain('data-group-off-warning');
  });

  it('группа включена или новая — предупреждения нет', () => {
    expect(render(group(true))).not.toContain('data-group-off-warning');
    expect(render()).not.toContain('data-group-off-warning');
  });
});
