import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { ExplainBox } from '@shared/ui/explain-box';
import { ProviderInstalledPluginRow } from '../ProviderInstalledPluginRow/ProviderInstalledPluginRow';
import { ProviderExtensionInstall } from '../ProviderExtensionInstall/ProviderExtensionInstall';
import { ProviderCodexMarketplaces } from '../ProviderCodexMarketplaces/ProviderCodexMarketplaces';
import { ProviderCodexAvailable } from '../ProviderCodexAvailable/ProviderCodexAvailable';
import type { ProviderInstalledPluginsProps } from './ProviderInstalledPlugins.types';
import { sectionModel } from '../lib/sectionModel';

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
