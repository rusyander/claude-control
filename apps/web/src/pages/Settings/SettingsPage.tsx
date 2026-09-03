import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { AppSettings } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { PageHeader } from '@shared/ui/page-header';
import { useSettings, useUpdateSettings } from '@entities/AppConfig';
import { SettingsTabs } from './SettingsTabs';
import { SettingsLoadError } from './SettingsLoadError';
import { GeneralTab } from './GeneralTab';
import { AccessTab } from './AccessTab';
import { ProvidersTab } from './ProvidersTab';
import { ModelsTab } from './ModelsTab';
import { SpendTab } from './SpendTab';
import { SafetyTab } from './SafetyTab';
import { TransferTab } from './TransferTab';
import { findSettingsTab, settingsPanelDomId, settingsTabDomId } from './model/tabs';
import type { SettingsTabId } from './model/tabs';
import styles from './SettingsPage.module.scss';

/**
 * Настройки приложения, разложенные по разделам.
 *
 * Двадцать с лишним карточек в одной колонке нельзя было просмотреть глазами:
 * нужное искали прокруткой на десять экранов. Разделы решают это, а открытый
 * раздел живёт в адресе (`/settings?tab=…`) — так на него можно сослаться из
 * справки и вернуться к нему после перезагрузки.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const { tab: tabParam } = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const { data: settings, isError, refetch } = useSettings();
  const updateSettings = useUpdateSettings();

  const activeTab = findSettingsTab(tabParam);

  // Замена записи в истории, а не новая: «назад» должно уводить со страницы, а
  // не отматывать по одной открытой вкладке.
  const selectTab = (tab: SettingsTabId): void => {
    void navigate({ to: '.', search: { tab }, replace: true });
  };

  // Сервер не ответил — говорим об этом, а не крутим скелет без конца.
  if (isError && !settings) {
    return (
      <Stack gap="var(--spacing-lg)" className={styles.page}>
        <PageHeader
          title={t('settings.title')}
          subtitle={t('settings.subtitle')}
          helpTopic="settings"
        />
        <SettingsLoadError onRetry={() => void refetch()} />
      </Stack>
    );
  }

  if (!settings) return <SkeletonList rows={4} withActions={false} />;

  const patch = (change: Partial<AppSettings>): void => {
    updateSettings.mutate(change);
  };

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('settings.title')}
        subtitle={t('settings.subtitle')}
        helpTopic="settings"
      />

      <SettingsTabs active={activeTab} onSelect={selectTab} />

      <Stack gap="var(--spacing-lg)">
        {/* Подпись раздела: полоса вкладок отвечает «где я», а строка под ней —
            «что здесь лежит», иначе короткие ярлыки приходится угадывать. */}
        <Typography variant="body-sm" color="subtle" className={styles.hint}>
          {t(`settings.tabHint_${activeTab}`)}
        </Typography>

        <div
          role="tabpanel"
          id={settingsPanelDomId(activeTab)}
          aria-labelledby={settingsTabDomId(activeTab)}
        >
          {activeTab === 'general' && <GeneralTab settings={settings} patch={patch} />}
          {activeTab === 'access' && <AccessTab />}
          {activeTab === 'providers' && <ProvidersTab />}
          {activeTab === 'models' && <ModelsTab settings={settings} patch={patch} />}
          {activeTab === 'spend' && <SpendTab settings={settings} patch={patch} />}
          {activeTab === 'safety' && <SafetyTab settings={settings} patch={patch} />}
          {activeTab === 'transfer' && <TransferTab />}
        </div>
      </Stack>
    </Stack>
  );
}
