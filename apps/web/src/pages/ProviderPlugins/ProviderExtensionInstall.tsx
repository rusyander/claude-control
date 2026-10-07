import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { useInstallProviderExtension } from '@entities/ProviderPlugins';

/**
 * Установка расширения Qwen (MAP 25): источник — как у `qwen extensions install
 * <source>` (адрес git, `owner/repo`, путь к папке). Панель передаёт согласие
 * `--consent` за человека, поэтому предупреждение о доверии стоит прямо над
 * кнопкой, а не в справке: расширение запускает свой код и MCP-серверы.
 */
export function ProviderExtensionInstall() {
  const { t } = useTranslation();
  const install = useInstallProviderExtension();
  const [source, setSource] = useState('');

  const trimmed = source.trim();
  // Те же правила, что у сервера: флаг в начале или вторая строка не уйдут в CLI.
  const invalid = trimmed.startsWith('-') || /[\r\n]/.test(source);

  const submit = (): void => {
    if (!trimmed || invalid) return;
    install.mutate(trimmed, { onSuccess: () => setSource('') });
  };

  return (
    <Card padding="sm">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body" weight="medium">
          {t('providerPlugins.extensions.installTitle')}
        </Typography>
        <TextField
          label={t('providerPlugins.extensions.sourceLabel')}
          value={source}
          onChange={setSource}
          placeholder="https://github.com/owner/repo"
          isMono
          hint={t('providerPlugins.extensions.sourceHint')}
          error={invalid ? t('providerPlugins.extensions.sourceInvalid') : undefined}
          disabled={install.isPending}
        />
        <Stack direction="row" align="center" gap="var(--spacing-xs)">
          <Icon name="warning" size={18} />
          <Typography variant="body-sm" color="warning">
            {t('providerPlugins.extensions.trust')}
          </Typography>
        </Stack>
        <Stack direction="row" justify="end">
          <Button
            onClick={submit}
            disabled={!trimmed || invalid}
            isLoading={install.isPending}
            leftIcon={<Icon name="plus" size={16} />}
          >
            {install.isPending
              ? t('providerPlugins.extensions.installing')
              : t('providerPlugins.extensions.install')}
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}
