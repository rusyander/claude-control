import { useTranslation } from 'react-i18next';
import { HelpSection } from './HelpSection';
import { FieldTable } from './FieldTable';
import type { PageTabsSectionProps } from './help-kit.types';

/**
 * «Вкладки раздела» — таблица вкладок страницы с тем, что на каждой.
 *
 * Названия и описания берутся из ТЕХ ЖЕ ключей, что рисует сама страница
 * (`pageTabs.<раздел>.tab|hint.<id>`): справка и полоса вкладок не могут
 * разойтись в словах, переименованная вкладка переименуется и здесь.
 */
export function PageTabsSection({ page, tabs, labelOf }: PageTabsSectionProps) {
  const { t } = useTranslation();
  return (
    <HelpSection title={t('help.common.tabsTitle')} caption={t('help.common.tabsCaption')}>
      <FieldTable
        nameHeader={t('help.common.tabName')}
        descriptionHeader={t('help.common.tabWhat')}
        rows={tabs.map((id) => ({
          name: labelOf ? labelOf(id) : t(`pageTabs.${page}.tab.${id}`),
          description: t(`pageTabs.${page}.hint.${id}`),
          isMono: false,
        }))}
      />
    </HelpSection>
  );
}
