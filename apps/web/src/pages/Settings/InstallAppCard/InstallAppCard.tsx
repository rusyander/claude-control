import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { promptInstall, useInstallApp } from '@shared/lib/install-app';
import type { InstallAppState } from '@shared/lib/install-app';

const STATE_TEXT: Record<InstallAppState, string> = {
  installed: 'settings.installAppInstalled',
  available: 'settings.installAppHint',
  unavailable: 'settings.installAppManual',
};

/**
 * Панель как приложение: своё окно без вкладок, значок в панели задач, запуск
 * со стартом Windows. Кнопка есть, только когда браузер готов установить;
 * иначе — где это сделать руками.
 */
export function InstallAppCard() {
  const { t } = useTranslation();
  const state = useInstallApp();

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body" weight="medium">
          {t('settings.installAppTitle')}
        </Typography>
        <Typography variant="body-sm" color="muted">
          {t(STATE_TEXT[state])}
        </Typography>

        {state === 'available' && (
          <Stack direction="row" gap="var(--spacing-xs)">
            <Button variant="primary" size="sm" onClick={() => void promptInstall()}>
              {t('settings.installAppAction')}
            </Button>
          </Stack>
        )}

        <Typography variant="body-sm" color="muted">
          {t('settings.installAppStartup')}
        </Typography>
      </Stack>
    </Card>
  );
}
