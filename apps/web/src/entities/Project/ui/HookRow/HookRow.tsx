import type { HookRowProps } from '../ProjectLocalConfigView/ProjectLocalConfigView.types';
import { useTranslation } from 'react-i18next';
import styles from './HookRow.module.scss';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';

/**
 * Хук проекта: событие, matcher, команда. Запись из `settings.local.json`
 * отмечена именем файла — Claude Code читает его наравне с общим, и не показать
 * такой хук значило бы врать о том, что действует. Битый путь к скрипту — предупреждение.
 */
export function HookRow({ hook }: HookRowProps) {
  const { t } = useTranslation();

  return (
    <li className={styles.row}>
      <Stack gap="var(--spacing-2xs)" minWidth={0}>
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body-sm" weight="semibold" color="accent" as="span">
            {hook.event}
          </Typography>
          {hook.matcher && <Badge tone="accent">{hook.matcher}</Badge>}
          {hook.source === 'settings-local' && (
            <span title={t('projectLocal.localSourceHint')}>
              <Badge tone="info">settings.local.json</Badge>
            </span>
          )}
          {hook.scriptExists === false && (
            <Badge tone="warning" withDot>
              {t('projectLocal.scriptMissing')}
            </Badge>
          )}
        </Stack>
        {hook.description && (
          <Typography variant="body-sm" color="muted" clamp={2} className={styles.text}>
            {hook.description}
          </Typography>
        )}
        <Stack direction="row" align="center" gap="var(--spacing-2xs)">
          <Icon name="link" size={18} />
          <Typography variant="mono" color="subtle" as="span" truncate title={hook.command}>
            {hook.command}
          </Typography>
        </Stack>
      </Stack>
    </li>
  );
}
