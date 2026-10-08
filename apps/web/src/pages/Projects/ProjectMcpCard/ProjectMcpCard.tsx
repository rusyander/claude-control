import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { DeleteButton } from '@features/EntityDelete';
import type { ProjectMcpCardProps } from './ProjectMcpCard.types';

/**
 * Карточка MCP-сервера проекта. Проще пользовательской: проверки связи, OAuth и
 * запуска в песочнице тут нет — это возможности пользовательского уровня, а на
 * проектном мы работаем с файлом `.mcp.json` напрямую.
 */
export function ProjectMcpCard({
  server,
  onToggle,
  onEdit,
  onDelete,
  isDeleting,
}: ProjectMcpCardProps) {
  const { t } = useTranslation();

  return (
    <Card padding="md">
      <Stack direction="row" gap="var(--spacing-md)" align="start" width="100%">
        <Stack gap="var(--spacing-2xs)" flex={1} minWidth={0}>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Typography variant="body" weight="medium" as="span">
              {server.name}
            </Typography>
            <Badge tone="neutral">{server.transport}</Badge>
            {!server.isEnabled && <Badge tone="neutral">{t('common.disabled')}</Badge>}
          </Stack>

          <Typography variant="mono" color="subtle" as="span" truncate>
            {server.command
              ? `${server.command} ${server.args.join(' ')}`.trim()
              : (server.url ?? '')}
          </Typography>
        </Stack>

        <Stack direction="row" align="center" gap="var(--spacing-xs)" flexShrink={0}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Icon name="edit" size={24} />}
            aria-label={`${t('common.edit')}: ${server.name}`}
            onClick={onEdit}
          />
          <DeleteButton
            entityName={server.name}
            description={t('common.deleteMcp')}
            onDelete={onDelete}
            isPending={isDeleting}
          />
          <Toggle checked={server.isEnabled} onCheckedChange={onToggle} aria-label={server.name} />
        </Stack>
      </Stack>
    </Card>
  );
}
