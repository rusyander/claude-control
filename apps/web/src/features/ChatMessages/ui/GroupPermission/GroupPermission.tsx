import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { PermissionCard } from '../PermissionCard/PermissionCard';
import type { GroupPermissionProps } from './GroupPermission.types';
import styles from './GroupPermission.module.scss';

/**
 * Запрос прав агента группы — островком в её карточке (владелец 23.10): на
 * запросе прав группа СТОИТ, и искали его в карточке той группы, что встала, а
 * он висел плашкой над всем хабом с подписью «Просит «<группа>»». Подпись в
 * островке — стадия и чат: имя группы уже стоит заголовком карточки.
 */
export function GroupPermission({ permissions, stage, onDecide }: GroupPermissionProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.island} data-group-permission={permissions.length}>
      {permissions.map((child) => {
        // Ключ прогона, заведённого панелью, — временный `new-…`; человеку
        // показывается ключ из списка, по которому он чат и найдёт.
        const listed = [child.chatId, ...(child.chatKeys ?? [])].find(
          (key) => !key.startsWith('new-'),
        );
        const chat = (listed ?? child.chatId).slice(0, 8);
        return (
          <div key={child.chatId} className={styles.ask}>
            <Typography variant="caption" className={styles.from} title={listed ?? child.chatId}>
              {stage
                ? t('chat.cascade.hub.permissionFrom', {
                    stage: t(`chat.cascade.stageFull.${stage}`),
                    chat,
                  })
                : t('chat.cascade.hub.permissionFromNoStage', { chat })}
            </Typography>
            <PermissionCard
              permissions={child.permissions}
              onDecide={(toolUseId, behavior) => onDecide(child.chatId, toolUseId, behavior)}
            />
          </div>
        );
      })}
    </div>
  );
}
