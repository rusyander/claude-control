import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { TruncatedText } from '@shared/ui/truncated-text';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { DeleteButton } from '@features/EntityDelete';
import { ResourceFileTree } from '@features/ResourceFiles';
import { formatDate } from '@shared/lib/format';
import type { PluginCardProps } from './PluginCard.types';

/** Карточка плагина: состояние, версия, обновление, просмотр файлов и удаление. */
export function PluginCard({ plugin, onToggle, onUninstall, onUpdate, isBusy }: PluginCardProps) {
  const { t, i18n } = useTranslation();
  const [isFilesOpen, setIsFilesOpen] = useState(false);

  // Дата обновления — только когда она отличается от даты установки: после
  // «обновить» видно, что версия действительно сменилась, а в день установки
  // вторая одинаковая дата была бы шумом.
  const installedOn = plugin.installedAt
    ? formatDate(plugin.installedAt, i18n.language)
    : undefined;
  const updatedOn = plugin.lastUpdated ? formatDate(plugin.lastUpdated, i18n.language) : undefined;
  const showUpdated = Boolean(updatedOn && installedOn && updatedOn !== installedOn);

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)" width="100%">
        <Stack direction="row" align="start" justify="between" gap="var(--spacing-md)" width="100%">
          <Stack gap="var(--spacing-2xs)" flex={1} minWidth={0}>
            <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
              <Typography variant="body" weight="medium" as="span">
                {plugin.name}
              </Typography>
              <Badge tone="neutral">{plugin.marketplace}</Badge>
              {plugin.version !== 'unknown' && (
                <Badge tone="info">
                  {t('plugins.version')} {plugin.version}
                </Badge>
              )}
              {/* Область установки видна только когда она не обычная пользовательская. */}
              {plugin.scope !== 'user' && <Badge tone="neutral">{plugin.scope}</Badge>}
              {plugin.installPathMissing && (
                <Badge tone="warning">{t('plugins.installPathMissing')}</Badge>
              )}
              {!plugin.isEnabled && <Badge tone="neutral">{t('common.disabled')}</Badge>}
            </Stack>

            {plugin.description && (
              <TruncatedText text={plugin.description} variant="body-sm" color="muted" />
            )}

            {installedOn && (
              <Typography variant="caption" color="subtle" as="span">
                {t('plugins.installedAt')}: {installedOn}
                {showUpdated && ` · ${t('plugins.updatedAt')}: ${updatedOn}`}
              </Typography>
            )}
          </Stack>

          <Stack direction="row" align="center" gap="var(--spacing-2xs)" flexShrink={0}>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="file" size={24} />}
              aria-label={`${t('plugins.viewFiles')}: ${plugin.name}`}
              aria-expanded={isFilesOpen}
              onClick={() => setIsFilesOpen((open) => !open)}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="refresh" size={24} />}
              aria-label={`${t('plugins.update')}: ${plugin.name}`}
              onClick={onUpdate}
              disabled={isBusy}
            />
            <DeleteButton
              entityName={plugin.name}
              description={t('plugins.deletePlugin')}
              onDelete={onUninstall}
              isPending={isBusy}
            />
            <Toggle
              checked={plugin.isEnabled}
              onCheckedChange={onToggle}
              disabled={isBusy}
              aria-label={plugin.name}
            />
          </Stack>
        </Stack>

        {/* Файлы плагина — только на чтение; дерево общее с остальными ресурсами. */}
        {isFilesOpen && (
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="caption" color="subtle">
              {t('plugins.filesHint')}
            </Typography>
            <ResourceFileTree kind="plugin" id={plugin.id} />
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
