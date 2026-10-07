import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { DeleteButton } from '@features/EntityDelete';
import {
  useSetProviderExtensionEnabled,
  useUninstallProviderExtension,
} from '@entities/ProviderPlugins';
import type { ProviderInstalledPluginRowProps } from './ProviderInstalledPluginRow.types';
import styles from './ProviderPluginsPage.module.scss';

/**
 * Одна строка установленного: что это и что приносит. Кнопки — только когда
 * сервер сказал `installedActions` (Qwen: `qwen extensions …`, Codex: `codex
 * plugin …`); у Kimi строка остаётся показом. Действие адресуется `actionId` —
 * у Codex это `имя@рынок`, у Qwen имя расширения. Отметку «включено» рисуем, только если CLI её назвал:
 * нет поля — состояние не известно, и выдумывать его панель не станет.
 */
export function ProviderInstalledPluginRow({
  plugin,
  actions,
  actionId,
  uninstallConfirm,
}: ProviderInstalledPluginRowProps) {
  const { t } = useTranslation();
  const setEnabled = useSetProviderExtensionEnabled();
  const uninstall = useUninstallProviderExtension();
  const name = plugin.name ?? plugin.id;
  const busy = setEnabled.isPending || uninstall.isPending;

  return (
    <Stack gap="var(--spacing-2xs)" padding="var(--spacing-sm)">
      <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
        <Typography variant="body" weight="medium">
          {plugin.displayName ?? name}
        </Typography>
        {plugin.version && <Badge tone="neutral">{plugin.version}</Badge>}
        {plugin.marketplace && (
          <Badge tone="neutral">
            {t('providerPlugins.codex.marketplace', { name: plugin.marketplace })}
          </Badge>
        )}
        {plugin.enabled === true && (
          <Badge tone="success">{t('providerPlugins.extensions.enabled')}</Badge>
        )}
        {plugin.enabled === false && (
          <Badge tone="neutral">{t('providerPlugins.extensions.disabled')}</Badge>
        )}
        {plugin.error && <Badge tone="warning">{t('providerPlugins.installed.broken')}</Badge>}
        {actions && !plugin.error && (
          <Stack direction="row" gap="var(--spacing-2xs)" className={styles.rowActions}>
            {plugin.enabled !== undefined && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                isLoading={setEnabled.isPending}
                onClick={() => setEnabled.mutate({ name: actionId, enabled: !plugin.enabled })}
              >
                {plugin.enabled
                  ? t('providerPlugins.extensions.disable')
                  : t('providerPlugins.extensions.enable')}
              </Button>
            )}
            <DeleteButton
              entityName={name}
              description={uninstallConfirm}
              onDelete={() => uninstall.mutate(actionId)}
              isPending={uninstall.isPending}
            />
          </Stack>
        )}
      </Stack>

      {plugin.description && (
        <Typography variant="body-sm" color="subtle">
          {plugin.description}
        </Typography>
      )}

      <Typography variant="mono" color="subtle" as="span" truncate>
        {plugin.manifestPath}
      </Typography>
      {plugin.source && (
        <Typography variant="caption" color="subtle" truncate>
          {t('providerPlugins.extensions.source', {
            source: plugin.source,
            type: plugin.sourceType ?? '?',
          })}
        </Typography>
      )}

      <Stack direction="row" gap="var(--spacing-2xs)" wrap>
        {plugin.hasSkills && <Badge tone="neutral">{t('providerPlugins.installed.skills')}</Badge>}
        {plugin.sessionStartSkill && (
          <Badge tone="neutral">
            {t('providerPlugins.installed.sessionSkill', { skill: plugin.sessionStartSkill })}
          </Badge>
        )}
        {plugin.mcpServers.length > 0 && (
          <Badge tone="neutral">
            {t('providerPlugins.installed.mcp', { list: plugin.mcpServers.join(', ') })}
          </Badge>
        )}
        {plugin.hookCount > 0 && (
          <Badge tone="neutral">
            {t('providerPlugins.installed.hooks', { count: plugin.hookCount })}
          </Badge>
        )}
        {plugin.hasCommands && (
          <Badge tone="neutral">{t('providerPlugins.installed.commands')}</Badge>
        )}
        {plugin.hasAgents && <Badge tone="neutral">{t('providerPlugins.extensions.agents')}</Badge>}
        {plugin.contextFiles && plugin.contextFiles.length > 0 && (
          <Badge tone="neutral">
            {t('providerPlugins.extensions.context', { list: plugin.contextFiles.join(', ') })}
          </Badge>
        )}
      </Stack>
    </Stack>
  );
}
