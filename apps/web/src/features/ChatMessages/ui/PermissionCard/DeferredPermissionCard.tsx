import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { Button } from '@shared/ui/button';
import { summarize } from '../../lib/summarize';
import type { DeferredPermissionCardProps } from './PermissionCard.types';
import styles from './PermissionCard.module.scss';

/**
 * Карточка прав, не дождавшаяся ответа за срок `deferAfterMinutes`: агент
 * получил «поставлено человеку как D-n» и работает дальше, поэтому это уже не
 * «агент ждёт вас» — спокойнее по виду и с номером записи. Кнопки отвечают тем
 * же маршрутом, что и живая карточка, а сервер решает по нему запись D-n.
 */
export function DeferredPermissionCard({ permissions, onDecide }: DeferredPermissionCardProps) {
  const { t } = useTranslation();
  if (permissions.length === 0) return null;

  return (
    <div className={`${styles.question} ${styles.deferred}`} data-permission-deferred>
      {permissions.map((permission) => {
        const id = permission.deferredId ?? '';
        return (
          <div key={permission.toolUseId} className={styles.questionItem} data-deferred-id={id}>
            <Stack
              direction="row"
              align="center"
              gap="var(--spacing-2xs)"
              className={styles.questionHead}
            >
              <Icon name="permissions" size={20} />
              <Typography as="span" variant="body-sm" weight="semibold" color="muted">
                {t('deferredAsks.card.title', { id })}
              </Typography>
            </Stack>
            <span className={styles.questionBadge}>{permission.toolName}</span>
            <pre className={styles.permissionInput}>{summarize(permission.input)}</pre>
            <Typography variant="caption" color="subtle">
              {t('deferredAsks.card.note', { id })}
            </Typography>
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
        );
      })}
    </div>
  );
}
