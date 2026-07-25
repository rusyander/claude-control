import { useTranslation } from 'react-i18next';
import type { ProviderPluginsInfo } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { ExplainBox } from '@shared/ui/explain-box';

/**
 * Плагины Kimi Code (KIMI-3) — ТОЛЬКО ПОКАЗ.
 *
 * Задокументировано: плагин лежит в `plugins/managed/<id>/`, его манифест —
 * JSON (`kimi.plugin.json` либо `.kimi-plugin/plugin.json`), а список
 * установленного и признак «включён» — в `plugins/installed.json`, форма
 * которого НЕ описана. Ставят, включают и выключают плагины командой `/plugins`
 * внутри CLI.
 *
 * Поэтому здесь нет ни одной кнопки записи: панель показывает, что установлено
 * и что плагин приносит (скиллы, MCP-серверы, хуки, команды), и не притворяется,
 * будто умеет этим управлять. Угадывать форму реестра запрещено тем же
 * правилом, по которому панель перестала писать `experimental.hook` у OpenCode.
 */
export function ProviderInstalledPlugins({ data }: { data: ProviderPluginsInfo }) {
  const { t } = useTranslation();

  return (
    <Stack gap="var(--spacing-md)">
      <ExplainBox
        title={t('providerPlugins.explainTitle')}
        text={t('providerPlugins.installed.explain', {
          provider: data.providerName,
          pluginsDir: data.pluginsDir,
        })}
      />

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

      <Card padding="sm">
        <Stack direction="row" align="center" gap="var(--spacing-xs)">
          <Icon name="info" size={18} />
          <Typography variant="body-sm" color="muted">
            {t('providerPlugins.installed.readOnly')}
          </Typography>
        </Stack>
      </Card>

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

      {data.installed.length > 0 ? (
        <Card padding="none">
          <Stack>
            {data.installed.map((plugin) => (
              <Stack key={plugin.id} gap="var(--spacing-2xs)" padding="var(--spacing-sm)">
                <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                  <Typography variant="body" weight="medium">
                    {plugin.displayName ?? plugin.name ?? plugin.id}
                  </Typography>
                  {plugin.version && <Badge tone="neutral">{plugin.version}</Badge>}
                  {plugin.error && (
                    <Badge tone="warning">{t('providerPlugins.installed.broken')}</Badge>
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

                <Stack direction="row" gap="var(--spacing-2xs)" wrap>
                  {plugin.hasSkills && (
                    <Badge tone="neutral">{t('providerPlugins.installed.skills')}</Badge>
                  )}
                  {plugin.sessionStartSkill && (
                    <Badge tone="neutral">
                      {t('providerPlugins.installed.sessionSkill', {
                        skill: plugin.sessionStartSkill,
                      })}
                    </Badge>
                  )}
                  {plugin.mcpServers.length > 0 && (
                    <Badge tone="neutral">
                      {t('providerPlugins.installed.mcp', {
                        list: plugin.mcpServers.join(', '),
                      })}
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
                </Stack>
              </Stack>
            ))}
          </Stack>
        </Card>
      ) : (
        <Typography color="subtle">{t('providerPlugins.installed.empty')}</Typography>
      )}

      {data.installedRegistryPath && (
        <Typography variant="caption" color="subtle">
          {t('providerPlugins.installed.registry', { path: data.installedRegistryPath })}
        </Typography>
      )}
    </Stack>
  );
}
