import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { ExplainBox } from '@shared/ui/explain-box';
import { ProviderInstalledPluginRow } from './ProviderInstalledPluginRow';
import { ProviderExtensionInstall } from './ProviderExtensionInstall';
import { ProviderCodexMarketplaces } from './ProviderCodexMarketplaces';
import { ProviderCodexAvailable } from './ProviderCodexAvailable';
import type { ProviderInstalledPluginsProps } from './ProviderInstalledPlugins.types';

/**
 * Установленное у чужого CLI — две модели на одном экране, различает их
 * `installedActions` от сервера, а не имя провайдера.
 *
 * Kimi Code (KIMI-3) — ТОЛЬКО ПОКАЗ: список установленного и признак «включён»
 * лежат в `plugins/installed.json`, форма которого не описана, а ставят и
 * включают плагины командой `/plugins` внутри CLI. Кнопок записи нет.
 *
 * Qwen Code (MAP 25) — расширения: установить, включить, выключить, удалить.
 * Панель ничего не пишет сама, сервер зовёт `qwen extensions …`; `update` и
 * `link` всегда спрашивают [Y/n] в терминале, поэтому здесь их нет — пояснение
 * отсылает к терминалу.
 *
 * Codex (MAP 25) — плагины с рынков: рынки, «можно поставить», поставленные.
 * Ставит и удаляет `codex plugin …`, включение — строка `enabled` в config.toml.
 */
/** Модель раздела: Codex (рынки), Qwen (команды CLI) или Kimi (только показ). */
function sectionModel(data: ProviderInstalledPluginsProps['data']): string {
  if (data.format === 'codex-plugins') return 'codex';
  return data.installedActions ? 'extensions' : 'installed';
}

export function ProviderInstalledPlugins({ data }: ProviderInstalledPluginsProps) {
  const { t } = useTranslation();
  const actions = data.installedActions;
  const codex = data.format === 'codex-plugins';
  const params = { provider: data.providerName, pluginsDir: data.pluginsDir };
  const model = sectionModel(data);
  const explain = t(`providerPlugins.${model}.explain`, params);
  const uninstallConfirm = t(
    codex
      ? 'providerPlugins.codex.uninstallConfirm'
      : 'providerPlugins.extensions.uninstallConfirm',
  );
  const emptyText = t(`providerPlugins.${model}.empty`);

  return (
    <Stack gap="var(--spacing-md)">
      <ExplainBox title={t('providerPlugins.explainTitle')} text={explain} />

      <Card padding="sm">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Icon name="folder" size={18} />
          <Typography variant="body-sm" color="muted">
            {t('providerPlugins.pluginsDir')}
          </Typography>
          <Typography variant="mono" color="subtle" as="span" truncate>
            {data.pluginsDir}
          </Typography>
          {!data.dirExists && <Badge tone="neutral">{t('providerPlugins.dirMissing')}</Badge>}
        </Stack>
      </Card>

      {codex && (
        <>
          <ProviderCodexMarketplaces marketplaces={data.marketplaces} />
          <ProviderCodexAvailable plugins={data.available} />
        </>
      )}
      {actions && !codex && <ProviderExtensionInstall />}
      {!actions && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="info" size={18} />
            <Typography variant="body-sm" color="muted">
              {t('providerPlugins.installed.readOnly')}
            </Typography>
          </Stack>
        </Card>
      )}

      {data.installedError && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="warning" size={18} />
            <Typography variant="body-sm" color="warning">
              {t('providerPlugins.dirUnreadable', { path: data.pluginsDir })}
            </Typography>
          </Stack>
        </Card>
      )}

      {data.installedStateError && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="warning" size={18} />
            <Typography variant="body-sm" color="warning">
              {t(
                codex
                  ? 'providerPlugins.codex.stateUnknown'
                  : 'providerPlugins.extensions.stateUnknown',
                { reason: data.installedStateError },
              )}
            </Typography>
          </Stack>
        </Card>
      )}

      {data.installed.length > 0 ? (
        <Card padding="none">
          <Stack>
            {data.installed.map((plugin) => (
              <ProviderInstalledPluginRow
                key={plugin.id}
                plugin={plugin}
                actions={actions}
                actionId={codex ? plugin.id : (plugin.name ?? plugin.id)}
                uninstallConfirm={uninstallConfirm}
              />
            ))}
          </Stack>
        </Card>
      ) : (
        <Typography color="subtle">{emptyText}</Typography>
      )}

      {data.installedRegistryPath && (
        <Typography variant="caption" color="subtle">
          {t('providerPlugins.installed.registry', { path: data.installedRegistryPath })}
        </Typography>
      )}
    </Stack>
  );
}
