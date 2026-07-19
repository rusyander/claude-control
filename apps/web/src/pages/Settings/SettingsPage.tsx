import { useTranslation } from 'react-i18next';
import type { AppSettings } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { PageHeader } from '@shared/ui/page-header';
import { useSettings, useUpdateSettings } from '@entities/AppConfig';
import { AccountCard } from './AccountCard';
import { ClaudeDirField } from './ClaudeDirField';
import { SettingToggleRow } from './SettingToggleRow';
import styles from './SettingsPage.module.scss';

/** Настройки приложения: оформление, доступность, путь к конфигурации, безопасность правок. */
export function SettingsPage() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();

  if (!settings) return <SkeletonList rows={4} withActions={false} />;

  const patch = (change: Partial<AppSettings>): void => {
    updateSettings.mutate(change);
  };

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />

      <AccountCard />

      <ClaudeDirField />

      <Card padding="md">
        <Stack gap="var(--spacing-md)">
          <Typography variant="body" weight="medium">
            {t('settings.theme')}
          </Typography>

          <Stack direction="row" gap="var(--spacing-xs)" wrap>
            {(['light', 'dark', 'system'] as const).map((theme) => (
              <Button
                key={theme}
                variant={settings.theme === theme ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => patch({ theme })}
              >
                {t(`settings.theme${theme[0]?.toUpperCase()}${theme.slice(1)}`)}
              </Button>
            ))}
          </Stack>

          <Typography variant="body" weight="medium">
            {t('settings.language')}
          </Typography>

          <Stack direction="row" gap="var(--spacing-xs)">
            {(['ru', 'en'] as const).map((language) => (
              <Button
                key={language}
                variant={settings.language === language ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => patch({ language })}
              >
                {language === 'ru' ? 'Русский' : 'English'}
              </Button>
            ))}
          </Stack>
        </Stack>
      </Card>

      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('settings.accessibility')}
          </Typography>

          <SettingToggleRow
            label={t('settings.largeText')}
            hint={t('settings.largeTextHint')}
            checked={settings.largeText}
            onChange={(largeText) => patch({ largeText })}
          />
          <SettingToggleRow
            label={t('settings.reduceMotion')}
            hint={t('settings.reduceMotionHint')}
            checked={settings.reduceMotion}
            onChange={(reduceMotion) => patch({ reduceMotion })}
          />
          <SettingToggleRow
            label={t('settings.highContrast')}
            hint={t('settings.highContrastHint')}
            checked={settings.highContrast}
            onChange={(highContrast) => patch({ highContrast })}
          />
        </Stack>
      </Card>

      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('settings.safety')}
          </Typography>

          <SettingToggleRow
            label={t('settings.backupBeforeWrite')}
            hint={t('settings.backupHint')}
            checked={settings.backupBeforeWrite}
            onChange={(backupBeforeWrite) => patch({ backupBeforeWrite })}
          />
          <SettingToggleRow
            label={t('settings.watchFiles')}
            hint={t('settings.watchHint')}
            checked={settings.watchFiles}
            onChange={(watchFiles) => patch({ watchFiles })}
          />
          <SettingToggleRow
            label={t('settings.revealSecrets')}
            hint={t('settings.revealSecretsHint')}
            checked={settings.revealSecretsByDefault}
            onChange={(revealSecretsByDefault) => patch({ revealSecretsByDefault })}
          />
        </Stack>
      </Card>
    </Stack>
  );
}
