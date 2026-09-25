import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { toast } from '@shared/lib/toast';
import { collectHumanSteps, type HubHumanStep } from '../lib/collectTickets';
import type { SplitHumanStepsProps } from './SplitHumanSteps.types';
import styles from './ChildStages.module.scss';
import own from './SplitTickets.module.scss';

/**
 * «Сделать человеку» (находка 112 живого прогона 24.09): шаги, которые группы
 * сделать не могут — зависимость между MR, доступ, настройка чужого сервиса, —
 * одним списком в хабе. До списка такая просьба тонула в итоговом тексте
 * группы, и MR уходил на слияние без зависимости.
 *
 * Панель шаг не выполняет: запись во внешний сервис — согласие человека на
 * каждую операцию. «Копировать» отдаёт шаг с местом, где он делается.
 */
export function SplitHumanSteps({ groups }: SplitHumanStepsProps) {
  const { t } = useTranslation();
  const steps = collectHumanSteps(groups);
  if (steps.length === 0) return null;

  const copy = (step: HubHumanStep): void => {
    const text = t('chat.cascade.hub.humanSteps.copyText', {
      action: step.action,
      where: step.where || '—',
      why: step.why || '—',
      groups: step.groups.join(', '),
    });
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success(t('chat.cascade.hub.tickets.copied')))
      .catch(() => toast.error(t('chat.cascade.hub.tickets.copyFailed')));
  };

  return (
    <div className={own.section} data-split-human-steps={steps.length}>
      <Typography
        variant="caption"
        color="subtle"
        as="div"
        title={t('chat.cascade.hub.humanSteps.hint')}
      >
        {t('chat.cascade.hub.humanSteps.title', { count: steps.length })}
      </Typography>
      {steps.map((step) => (
        <div key={step.key} className={own.item} data-split-human-step>
          <div className={own.body}>
            <Typography variant="body-sm" as="div">
              {step.action}
            </Typography>
            <Typography variant="caption" color="subtle" as="div" truncate>
              {[
                step.where,
                t('chat.cascade.hub.humanSteps.askedBy', { groups: step.groups.join(', ') }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </Typography>
            {step.why && (
              <Typography variant="caption" color="subtle" as="div" className={own.why}>
                {step.why}
              </Typography>
            )}
          </div>
          <div className={styles.holdActions}>
            <Button size="sm" variant="ghost" onClick={() => copy(step)}>
              {t('chat.cascade.hub.tickets.copy')}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
