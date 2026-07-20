import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { Button } from '@shared/ui/button';
import type { PermissionCardProps } from './PermissionCard.types';
import styles from './ChatMessages.module.scss';

/**
 * Запрос агента на разрешение инструмента. Работа стоит, пока человек не решит:
 * поэтому карточка заметная, а решение — в один клик прямо в чате, без перехода
 * в терминал. Показываем, что именно агент хочет сделать (команду, файл, адрес).
 */

/** Короткая суть запроса: команда/файл/адрес, иначе — компактный JSON. */
function summarize(input: unknown): string {
  const object = (input ?? {}) as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
    const value = object[key];
    if (typeof value === 'string' && value) return value;
  }
  try {
    const json = JSON.stringify(object);
    return json.length > 240 ? `${json.slice(0, 240)}…` : json;
  } catch {
    return '';
  }
}

export function PermissionCard({ permissions, onDecide }: PermissionCardProps) {
  const { t } = useTranslation();
  if (permissions.length === 0) return null;

  return (
    <div className={`${styles.question} ${styles.permission}`}>
      <Stack
        direction="row"
        align="center"
        gap="var(--spacing-2xs)"
        className={`${styles.questionHead} ${styles.permissionHead}`}
      >
        <Icon name="permissions" size={20} />
        <Typography as="span" variant="body-sm" weight="semibold" color="warning">
          {t('chat.permissionTitle')}
        </Typography>
      </Stack>

      {permissions.map((permission) => (
        <div key={permission.toolUseId} className={styles.questionItem}>
          <span className={styles.questionBadge}>{permission.toolName}</span>
          <pre className={styles.permissionInput}>{summarize(permission.input)}</pre>
          <Stack
            direction="row"
            justify="end"
            gap="var(--spacing-2xs)"
            marginTop="var(--spacing-2xs)"
          >
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onDecide(permission.toolUseId, 'deny')}
            >
              {t('chat.deny')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => onDecide(permission.toolUseId, 'allow')}
            >
              {t('chat.allow')}
            </Button>
          </Stack>
        </div>
      ))}
    </div>
  );
}
