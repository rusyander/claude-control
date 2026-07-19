import { useTranslation } from 'react-i18next';
import type { AppSettings } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { PageHeader } from '@shared/ui/page-header';
import { SelectField } from '@shared/ui/select-field';
import { MODEL_OPTIONS, EFFORT_LEVELS, modelLabel } from '@shared/lib/chat-model';
import { useSettings, useUpdateSettings } from '@entities/AppConfig';
import { AccountCard } from './AccountCard';
import { ClaudeDirField } from './ClaudeDirField';
import { CredentialsCard } from './CredentialsCard';
import { EditorCard } from './EditorCard';
import { PricingCard } from './PricingCard';
import { BackupsCard } from './BackupsCard';
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

  const modelOptions = MODEL_OPTIONS.map((value) => ({
    value,
    label: value ? modelLabel(value) : t('settings.chatModelAuto'),
  }));
  const effortOptions = EFFORT_LEVELS.map((level) => ({
    value: level,
    label: level ? t(`chat.effort_${level}`) : t('settings.chatEffortAuto'),
  }));

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('settings.title')}
        subtitle={t('settings.subtitle')}
        helpTopic="settings"
      />

      <AccountCard />

      <ClaudeDirField />

      <CredentialsCard />

      <EditorCard />

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
            {t('settings.spendTitle')}
          </Typography>

          <SettingToggleRow
            label={t('settings.spendMoney')}
            hint={t('settings.spendHint')}
            checked={settings.costUnit === 'money'}
            onChange={(inMoney) => patch({ costUnit: inMoney ? 'money' : 'tokens' })}
          />
        </Stack>
      </Card>

      {/* Модель и глубина по умолчанию для чата — централизованно здесь; в самом
          чате их можно переопределить локально для одного разговора. */}
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Typography variant="body" weight="medium">
            {t('settings.chatDefaultsTitle')}
          </Typography>
          <Typography variant="body-sm" color="subtle">
            {t('settings.chatDefaultsHint')}
          </Typography>

          <SelectField
            label={t('settings.chatModel')}
            value={settings.chatModel}
            onChange={(chatModel) => patch({ chatModel })}
            options={modelOptions}
            hint={t('settings.chatModelHint')}
          />
          <SelectField
            label={t('settings.chatEffort')}
            value={settings.chatEffort}
            onChange={(value) => patch({ chatEffort: value as AppSettings['chatEffort'] })}
            options={effortOptions}
            hint={t('settings.chatEffortHint')}
          />
        </Stack>
      </Card>

      {/* Тарифы показываем рядом с переключателем единиц: они про одно и то же. */}
      <PricingCard />

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

      {/* Сразу под тумблером резервных копий: там их включают, здесь — применяют. */}
      <BackupsCard />
    </Stack>
  );
}
