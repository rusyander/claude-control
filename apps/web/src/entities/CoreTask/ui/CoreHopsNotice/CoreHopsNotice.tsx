import { useTranslation } from 'react-i18next';
import { hopsUnrecorded } from '@agentdeck/contracts/core/panel-api';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { useCoreHealth } from '../../api/useCoreTasks';
import styles from './CoreHopsNotice.module.scss';

/**
 * Плашка «ядро ещё не знает эту панель» (P131): здоровье ядра говорит, что надзор не записал ни
 * одного звена, — команды человека через панель ядро примет только с подписью телефона. Без
 * плашки человек видел бы отказ `signature-required` на каждом нажатии и не знал почему. Ядра нет
 * или здоровье не прочлось — молчит: отказ прокладки страница показывает своей карточкой.
 */
export function CoreHopsNotice() {
  const { t } = useTranslation();
  const { data } = useCoreHealth();
  if (!data || !hopsUnrecorded(data.trustedHops)) return null;
  return (
    <div className={styles.notice} role="status" data-core-hops="unrecorded">
      <Stack gap="var(--spacing-3xs)">
        <Typography variant="body-sm" weight="medium" as="p">
          {t('coreTimeline.hops.title')}
        </Typography>
        <Typography variant="caption" color="muted" as="p">
          {t('coreTimeline.hops.text')}
        </Typography>
      </Stack>
    </div>
  );
}
