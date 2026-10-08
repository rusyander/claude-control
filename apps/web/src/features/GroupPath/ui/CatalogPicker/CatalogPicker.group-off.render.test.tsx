import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';

/**
 * F-100: скилл, правило или хук, выбранный шагом в ВЫКЛЮЧЕННОЙ группе,
 * становится её участником, и сервер держит его выключенным везде
 * (`group-toggle.ts` `reconcileMembers`), а не только в этой группе. Выбор
 * обязан сказать это до щелчка — у включённой группы строки нет.
 */
vi.mock('@entities/Group', () => ({
  useResourceCatalog: () => ({
    data: { items: [{ type: 'skill', id: 'review', scope: 'global' }] },
    isLoading: false,
    isError: false,
  }),
}));

const { CatalogPicker } = await import('./CatalogPicker');

const render = (isGroupOff?: boolean): string =>
  renderToStaticMarkup(
    <CatalogPicker isSaving={false} hasFailed={false} onPick={() => {}} isGroupOff={isGroupOff} />,
  );

describe('выбор готового ресурса в выключенной группе', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it('группа выключена — предупреждение, что ресурс выключится везде', () => {
    const html = render(true);
    expect(html).toContain(i18n.t('groupBuilder.catalog.groupOff'));
    expect(html).toContain('data-group-off-warning');
  });

  it('группа включена — предупреждения нет', () => {
    expect(render(false)).not.toContain('data-group-off-warning');
    expect(render()).not.toContain('data-group-off-warning');
  });
});
