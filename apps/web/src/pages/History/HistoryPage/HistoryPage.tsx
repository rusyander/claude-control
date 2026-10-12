import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PageHeader } from '@shared/ui/page-header';
import { PageTabs, PageTabPanel } from '@shared/ui/page-tabs';
import { usePageTab } from '@shared/hooks/use-page-tab';
import { ChangelogTab } from '../ChangelogTab/ChangelogTab';
import { ConfigHistoryTab } from '../ConfigHistoryTab/ConfigHistoryTab';
import { HISTORY_TABS, HISTORY_TAB_ICONS } from '../model/tabs';
import styles from './HistoryPage.module.scss';

/**
 * «История изменений» — две вкладки: «Что нового» (выпуски самой панели, по
 * умолчанию) и «Настройки» (временная лента правок вашей конфигурации с диффом).
 * Вкладка живёт в адресе (`?tab=`) и помнится между заходами.
 */
export function HistoryPage() {
  const { t } = useTranslation();
  const { active, select } = usePageTab('history', HISTORY_TABS);

  const tabs = HISTORY_TABS.map((id) => ({
    id,
    label: t(`pageTabs.history.tab.${id}`),
    icon: HISTORY_TAB_ICONS[id],
  }));

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader title={t('history.title')} subtitle={t('history.subtitle')} helpTopic="history" />

      <PageTabs
        page="history"
        label={t('pageTabs.history.tabsLabel')}
        tabs={tabs}
        active={active}
        onSelect={select}
      />

      <PageTabPanel page="history" tab={active} hint={t(`pageTabs.history.hint.${active}`)}>
        {active === 'changelog' && <ChangelogTab />}
        {active === 'config' && <ConfigHistoryTab />}
      </PageTabPanel>
    </Stack>
  );
}
