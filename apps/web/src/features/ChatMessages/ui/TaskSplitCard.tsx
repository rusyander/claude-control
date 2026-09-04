import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { branchTaken } from '@claude-control/contracts/task-split';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Toggle } from '@shared/ui/toggle';
import type { TaskSplitCardProps } from './TaskSplitCard.types';
import styles from './TaskSplitCard.module.scss';

/**
 * Предложение разделить задачи по нескольким чатам.
 *
 * Приходит блоком в ответе агента, а показывается карточкой: сырой JSON в ленте
 * не читается, а решение здесь принимает человек, и принимать его он должен по
 * составу групп, а не по формату. Поэтому видно ровно то, что важно для выбора,
 * — какие задачи куда уедут и под какой веткой.
 *
 * Кнопки две, и обе — решение, а не подтверждение: «делать здесь по очереди»
 * такой же законный ответ, как и разделение, и уходит агенту обычной репликой.
 * Субагентов не появляется ни в одном из случаев: каждая группа — обычный чат,
 * в котором человек разговаривает сам.
 */
export function TaskSplitCard({
  proposal,
  onSplit,
  onKeepHere,
  isPending,
  disabled,
  childBranches,
}: TaskSplitCardProps) {
  const { t } = useTranslation();
  // «Только завести чаты» — для случая, когда сначала хочется прочитать задания
  // и поправить их, а не получить четырёх агентов, стартовавших разом.
  const [createOnly, setCreateOnly] = useState(false);

  const count = proposal.groups.length;
  const isLocked = Boolean(isPending || disabled);

  // Сколько групп уже стали чатами. Считаем по веткам, а не по названиям: имя
  // ветки — единственное, что переживает и заведение копии, и перезагрузку
  // страницы, и переход с телефона.
  const done = childBranches?.length
    ? proposal.groups.filter((group) => branchTaken(group.branch, childBranches)).length
    : 0;
  // Хотя бы одна группа заведена — предложение отработано. Именно «хотя бы
  // одна», а не «все»: при частичном сбое (три ветки из четырёх) повтор завёл
  // бы три удавшиеся заново, вторыми копиями, а четвёртую — снова уронил.
  const isDone = done > 0;

  return (
    <div className={styles.card}>
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
            разуникаливает (это делает git, уже при заведении копии), и модель
            вполне может назвать две группы одинаково. */}
        {proposal.groups.map((group, index) => (
          <div key={index} className={styles.group}>
            <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
              <Typography variant="body-sm" weight="medium" as="span">
                {group.title}
              </Typography>
              <span className={styles.branch}>{group.branch}</span>
            </Stack>
            {/* Единственный пункт, дословно повторяющий заголовок, — это разбор
                подставил название вместо списка, которого модель не прислала.
                Печатать его второй раз незачем: строка та же самая. */}
            {(group.tasks.length > 1 || group.tasks[0] !== group.title) && (
              <ul className={styles.tasks}>
                {group.tasks.map((task, index) => (
                  <li key={index}>{task}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </Stack>

      {/* Предложение уже отработано: вместо кнопок — итог. Карточка остаётся на
          месте (по ней читают, что и куда уехало), но заводить по ней второй раз
          нечего, а молча погашенная кнопка выглядела бы поломкой. */}
      {isDone && (
        <Stack direction="row" align="center" gap="var(--spacing-2xs)" className={styles.option}>
          <Icon name="check" size={18} />
          <Typography variant="body-sm" color="muted" as="span">
            {t('chat.split.alreadyDone', { done, count })}
          </Typography>
        </Stack>
      )}

      {onSplit && !isDone && (
        <Stack direction="row" align="center" gap="var(--spacing-2xs)" className={styles.option}>
          <Toggle
            size="sm"
            checked={createOnly}
            onCheckedChange={setCreateOnly}
            disabled={isLocked}
            aria-label={t('chat.split.createOnly')}
          />
          <Typography variant="body-sm" color="muted" as="span">
            {t('chat.split.createOnly')}
          </Typography>
        </Stack>
      )}

      {onSplit && !isDone && (
        <Stack direction="row" gap="var(--spacing-2xs)" wrap className={styles.actions}>
          <Button
            variant="primary"
            leftIcon={<Icon name="branch" size={18} />}
            onClick={() => onSplit({ startRuns: !createOnly })}
            isLoading={isPending}
            disabled={isLocked}
          >
            {t('chat.split.apply', { count })}
          </Button>
          {onKeepHere && (
            <Button variant="secondary" onClick={onKeepHere} disabled={isLocked}>
              {t('chat.split.keepHere')}
            </Button>
          )}
        </Stack>
      )}
    </div>
  );
}
