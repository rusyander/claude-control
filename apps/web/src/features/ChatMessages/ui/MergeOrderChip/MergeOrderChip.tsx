import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import type { MergeOrderChipProps } from './MergeOrderChip.types';
import styles from './MergeOrderChip.module.scss';
import { englishOrdinal } from '../../lib/englishOrdinal';

/**
 * «мержить 2-м из 5» у кнопки MR (G3). Подсказка называет группы, чьи MR
 * влить раньше: без имён номер — просто цифра, и человек не знал бы, кого
 * ждать. Номер без зависимостей — место по порядку плана, это и сказано.
 */
export function MergeOrderChip({ order }: MergeOrderChipProps) {
  const { t } = useTranslation();
  const names = order.before
    .map((name) => t('chat.cascade.hub.mergeOrderName', { name }))
    .join(', ');
  return (
    <Typography
      variant="caption"
      color="subtle"
      as="span"
      className={styles.mergeOrder}
      data-merge-order={order.position}
      title={
        names
          ? t('chat.cascade.hub.mergeOrderAfter', { names })
          : t('chat.cascade.hub.mergeOrderFree')
      }
    >
      {t('chat.cascade.hub.mergeOrder', {
        position: order.position,
        total: order.total,
        ordinal: englishOrdinal(order.position),
      })}
    </Typography>
  );
}
