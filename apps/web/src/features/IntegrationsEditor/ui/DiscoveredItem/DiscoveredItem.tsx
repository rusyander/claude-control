import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { INTEGRATION_FIELDS } from '../../model/draft.constants';
import { isTransferable } from '../../model/discoverySelection';
import { discoverySource } from '../../lib/discoverySource';
import type { DiscoveredItemProps } from './DiscoveredItem.types';
import styles from './DiscoveredItem.module.scss';

/**
 * Одна находка: что за система, в каком MCP-сервере и откуда он, что ляжет в
 * карточку и чего не хватает.
 *
 * Показано всё, по чему человек решает «моё ли это»: имя сервера, файл,
 * пакет и адрес — и ключ только маской. Неполную или уже подключённую строку
 * отметить нельзя, но она остаётся на экране: «нашли, но без адреса» — тоже
 * ответ на вопрос, почему интеграция не перенеслась.
 */
export function DiscoveredItem({ item, isSelected, onToggle }: DiscoveredItemProps) {
  const { t } = useTranslation();
  const canTransfer = isTransferable(item);

  const fieldLabel = (key: string): string =>
    key === 'token' ? t('integrations.card.token') : t(`integrations.field.${item.id}.${key}`);

  const fieldValue = (key: string, value: string): string => {
    const field = INTEGRATION_FIELDS[item.id].find((candidate) => candidate.key === key);
    return field?.kind === 'select' && value
      ? t(`integrations.option.${item.id}.${key}.${value}`)
      : value;
  };

  return (
    <label className={canTransfer ? styles.row : `${styles.row} ${styles.disabled}`}>
      <input type="checkbox" checked={isSelected} disabled={!canTransfer} onChange={onToggle} />
      <Stack gap="var(--spacing-3xs)" className={styles.body}>
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body" weight="medium" as="span">
            {t(`integrations.card.${item.id}.title`)}
          </Typography>
          {item.alreadyConnected && (
            <Badge tone="success">{t('integrations.discover.already')}</Badge>
          )}
          {item.replaces && !item.alreadyConnected && (
            <Badge tone="warning">{t('integrations.discover.replaces')}</Badge>
          )}
        </Stack>

        <Typography variant="caption" color="subtle" as="span">
          {[
            t('integrations.discover.server', { name: item.server }),
            discoverySource(item, t),
            `${t(`integrations.discover.launch.${item.launch}`)} ${item.package}`.trim(),
          ].join(' · ')}
        </Typography>

        {Object.keys(item.fields).length > 0 && (
          <Typography variant="caption" as="span">
            {Object.entries(item.fields)
              .map(([key, value]) => `${fieldLabel(key)}: ${fieldValue(key, value)}`)
              .join(' · ')}
          </Typography>
        )}

        <Typography variant="caption" color="subtle" as="span">
          {item.hasToken
            ? t('integrations.discover.key', { mask: item.maskedToken })
            : t('integrations.discover.noKey')}
        </Typography>

        {item.missing.length > 0 && (
          <Typography variant="caption" color="warning" as="span">
            {t('integrations.discover.missing', {
              fields: item.missing.map(fieldLabel).join(', '),
            })}
          </Typography>
        )}
      </Stack>
    </label>
  );
}
