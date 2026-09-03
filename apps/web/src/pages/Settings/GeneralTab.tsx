import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { ACCENT_OPTIONS, accentLabelKey } from '@shared/lib/accent';
import { EditorCard } from './EditorCard';
import { SettingToggleRow } from './SettingToggleRow';
import type { SettingsTabProps } from './SettingsTabs.types';

/** Раздел «Общие»: как панель выглядит, читается и чем открывает файлы. */
export function GeneralTab({ settings, patch }: SettingsTabProps) {
  const { t } = useTranslation();

  return (
    <Stack gap="var(--spacing-lg)">
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
                aria-pressed={settings.theme === theme}
                size="sm"
                onClick={() => patch({ theme })}
              >
                {t(`settings.theme${theme[0]?.toUpperCase()}${theme.slice(1)}`)}
              </Button>
            ))}
          </Stack>

          <Typography variant="body" weight="medium">
            {t('settings.accent')}
          </Typography>
          <Typography variant="body-sm" color="subtle">
            {t('settings.accentHint')}
          </Typography>

          <Stack direction="row" gap="var(--spacing-xs)" wrap>
            {ACCENT_OPTIONS.map((accent) => (
              <Button
                key={accent}
                variant={settings.accent === accent ? 'primary' : 'secondary'}
                aria-pressed={settings.accent === accent}
                size="sm"
                onClick={() => patch({ accent })}
              >
                {t(accentLabelKey(accent))}
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
                aria-pressed={settings.language === language}
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

      <EditorCard />
    </Stack>
  );
}
