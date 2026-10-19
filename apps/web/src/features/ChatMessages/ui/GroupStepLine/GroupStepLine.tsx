import { useTranslation } from 'react-i18next';
import type { GroupStep } from '../../lib/groupStep';
import styles from './GroupStepLine.module.scss';
import { Typography } from '@shared/ui/typography';

/** Шаг группы: «Шаг 8 из 14», что за шаг и сколько субагентов на нём. */
export function GroupStepLine({ step }: { step: GroupStep }) {
  const { t } = useTranslation();
  const numbered = step.current !== undefined && step.total !== undefined;
  const detail = [
    step.name,
    step.agents > 0 ? t('chat.cascade.hub.stepAgents', { count: step.agents }) : undefined,
  ].filter(Boolean);
  return (
    <span
      className={styles.step}
      data-hub-step={numbered ? `${step.current}/${step.total}` : (step.name ?? '')}
    >
      {numbered && (
        <Typography variant="caption" as="span" className={styles.stepNo}>
          {t('chat.cascade.hub.step', { current: step.current, total: step.total })}
        </Typography>
      )}
      {detail.length > 0 && (
        <Typography variant="caption" color="subtle" as="span" className={styles.wrap}>
          {detail.join(' · ')}
        </Typography>
      )}
    </span>
  );
}
