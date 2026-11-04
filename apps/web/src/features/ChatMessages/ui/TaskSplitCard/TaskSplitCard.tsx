import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import type { TaskSplitCardProps } from '../TaskSplitCard.types';
import styles from './TaskSplitCard.module.scss';

/**
 * Предложение разделить задачи по нескольким чатам — запись истории.
 *
 * Разделение из чата снято вместе с маршрутом: задачу по группам ведёт ядро.
 * Блок в старых ответах агента остаётся, и показывается он карточкой, а не
 * сырым JSON: по ней читают, какие задачи куда предлагалось развести и под
 * какой веткой. Кнопок нет — решать по ней больше нечего.
 */
export function TaskSplitCard({ proposal }: TaskSplitCardProps) {
  const { t } = useTranslation();
  const count = proposal.groups.length;

  return (
    <div className={styles.card} data-split-card>
      <Stack direction="row" align="center" gap="var(--spacing-2xs)" className={styles.head}>
        <Icon name="branch" size={18} />
        <Typography variant="body-sm" weight="medium" as="span">
          {t('chat.split.title', { count })}
        </Typography>
      </Stack>

      {proposal.shared && (
        <Typography variant="body-sm" color="muted" className={styles.shared}>
          {proposal.shared}
        </Typography>
      )}

      <Stack gap="var(--spacing-xs)" className={styles.groups}>
        {/* Ключ по номеру, а не по ветке: разбор предложения имена веток не
            разуникаливает, и модель вполне может назвать две группы одинаково. */}
        {proposal.groups.map((group, index) => (
          <div key={index} className={styles.group}>
            <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
              <Typography variant="body-sm" weight="medium" as="span">
                {group.title}
              </Typography>
              <span className={styles.branch}>{group.branch}</span>
            </Stack>
            {/* Ревью-группа названа заголовком MR, а заголовки повторяются:
                ссылка видна целиком, по ней и отличают. */}
            {group.review && (
              <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
                <Badge tone={group.review.work ? 'warning' : 'info'}>
                  {t(group.review.work ? 'chat.split.mrWork' : 'chat.split.mrReview')}
                </Badge>
                <a
                  className={styles.reviewLink}
                  href={group.review.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {group.review.url}
                </a>
              </Stack>
            )}
            {/* Единственный пункт, дословно повторяющий заголовок, — это разбор
                подставил название вместо списка, которого модель не прислала. */}
            {(group.tasks.length > 1 || group.tasks[0] !== group.title) && (
              <ul className={styles.tasks}>
                {group.tasks.map((task, position) => (
                  <li key={position}>{task}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </Stack>

      {/* Отброшенное потолком разбора — вслух: хвост выгрузки из трекера иначе
          пропадал молча, и никто не знал, что задач было больше. */}
      {proposal.dropped && (
        <div className={styles.dropped}>
          {Boolean(proposal.dropped.groups) && (
            <Typography variant="caption" color="warning" as="p" data-split-dropped="groups">
              {t('chat.split.droppedGroups', { count: proposal.dropped.groups })}
            </Typography>
          )}
          {Boolean(proposal.dropped.tasks) && (
            <Typography variant="caption" color="warning" as="p" data-split-dropped="tasks">
              {t('chat.split.droppedTasks', { count: proposal.dropped.tasks })}
            </Typography>
          )}
        </div>
      )}
    </div>
  );
}
