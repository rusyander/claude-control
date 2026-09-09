import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import type { TriageCardProps } from './TriageCard.types';
import styles from './ReviewCard.module.scss';

/**
 * Итог разбора разделения (уровень 1, Т1): кто чем владеет, кто кого ждёт, что
 * спросить у человека.
 *
 * Показывается карточкой по той же причине, что ревью: сырой JSON в ленте не
 * читается. Решать здесь нечего — конвейер уже применил разбор и завёл, что
 * мог; карточка отвечает на вопрос «что именно он решил». Группы названы
 * номерами, как в задании разбора: названий у ленты нет, а сводка у родителя
 * показывает те же группы по именам.
 */
export function TriageCard({ plan }: TriageCardProps) {
  const { t } = useTranslation();
  const number = (index: number): string => t('chat.cascade.triage.group', { number: index + 1 });

  return (
    <div className={styles.card} data-triage-card>
      <Stack direction="row" align="center" gap="var(--spacing-2xs)" className={styles.head}>
        <Icon name="check" size={18} />
        <Typography variant="body-sm" weight="medium" as="span">
          {t('chat.cascade.triage.title')}
        </Typography>
        <span className={styles.count}>
          {t('chat.cascade.triage.count', { count: plan.groups.length })}
        </span>
      </Stack>

      <ol className={styles.list}>
        {plan.groups.map((group) => (
          <li key={group.index} value={group.index + 1}>
            <Typography variant="body-sm" as="div" className={styles.item}>
              <strong>{number(group.index)}</strong>
              {group.owns.length > 0 &&
                ` · ${t('chat.cascade.triage.owns')}: ${group.owns.join(', ')}`}
              {group.after.length > 0 &&
                ` · ${t('chat.cascade.triage.after')}: ${group.after.map(number).join(', ')}`}
              {group.tasks.length > 0 &&
                ` · ${t('chat.cascade.triage.tasks', { count: group.tasks.length })}`}
              {group.hold && (
                <>
                  <br />
                  {t('chat.cascade.triage.hold')}: {group.hold}
                </>
              )}
              {group.notes && (
                <>
                  <br />
                  {group.notes}
                </>
              )}
            </Typography>
          </li>
        ))}
      </ol>

      {plan.conflicts.length > 0 && (
        <Typography variant="body-sm" as="div" className={styles.item}>
          <strong>{t('chat.cascade.triage.conflicts')}</strong>
          {plan.conflicts.map((conflict, index) => (
            <span key={index}>
              <br />
              {conflict.paths.join(', ')} → {number(conflict.resolvedBy)}
              {conflict.why ? ` — ${conflict.why}` : ''}
            </span>
          ))}
        </Typography>
      )}

      {plan.order.length > 0 && (
        <Typography variant="body-sm" color="subtle" as="div">
          {t('chat.cascade.triage.order', { list: plan.order.map(number).join(' → ') })}
        </Typography>
      )}
    </div>
  );
}
