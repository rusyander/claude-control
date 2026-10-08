import { useTranslation } from 'react-i18next';
import { useChatProgress } from '@entities/Chat';
import { HUB_POLL_MS } from './GroupStepLine.constants';
import { groupStep } from '../../lib/groupStep';
import styles from './GroupStepLine.module.scss';
import { Typography } from '@shared/ui/typography';

export function GroupStepLine({ chatId, isRunning }: { chatId: string; isRunning: boolean }) {
  const { t } = useTranslation();
  const { data } = useChatProgress(chatId, isRunning, HUB_POLL_MS);
  const step = groupStep(data, isRunning);
  if (!step) return null;
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
