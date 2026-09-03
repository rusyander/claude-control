import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { BackupsCard } from './BackupsCard';
import { SecretEncryptionCard } from './SecretEncryptionCard';
import { SettingToggleRow } from './SettingToggleRow';
import { NumberSettingRow } from './NumberSettingRow';
import type { SettingsTabProps } from './SettingsTabs.types';
import styles from './SettingsPage.module.scss';

/**
 * Раздел «Безопасность»: что панель делает перед записью в конфигурацию и что
 * остаётся на диске после. Тумблеры, шифрование копий и сами копии идут одной
 * цепочкой — там их включают, здесь применяют.
 */
export function SafetyTab({ settings, patch }: SettingsTabProps) {
  const { t } = useTranslation();

  return (
    <Stack gap="var(--spacing-lg)">
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
            label={t('settings.previewProviderWrites')}
            hint={t('settings.previewProviderWritesHint')}
            checked={settings.previewProviderWrites}
            onChange={(previewProviderWrites) => patch({ previewProviderWrites })}
          />
          <NumberSettingRow
            label={t('settings.backupKeep')}
            hint={t('settings.backupKeepHint')}
            value={settings.backupKeep}
            min={1}
            max={100}
            inputClassName={styles.numberInput}
            onChange={(backupKeep) => patch({ backupKeep })}
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

      {/* Шифрование копий секретов: держим рядом с самими копиями. */}
      <SecretEncryptionCard />

      {/* Сразу под тумблером резервных копий: там их включают, здесь — применяют. */}
      <BackupsCard />
    </Stack>
  );
}
