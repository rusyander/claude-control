import { useTranslation } from 'react-i18next';
import { CORE_TASKS_ROUTE } from '@shared/config/routes';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import type { GroupIntakeRow } from '../../model/groupIntake';
import styles from '../rows.module.scss';

export interface GroupIntakeProps {
  /** Задач группы с открытым вопросом карточки приёма — число на кнопке. */
  pending: number;
  /** Задачи группы, ждущие ответа о классе в своей ленте (`n` — номер задачи в группе). */
  classWaiting?: readonly { taskId: string; n: number }[];
  /** Исход последнего нажатия по задачам; `null` — ещё не нажимали. */
  rows: GroupIntakeRow[] | null;
  busy: boolean;
  onConfirm: () => void;
}

const P = 'coreLaunch.launch.intake';

/**
 * Вопрос класса держит задачу, а кнопки у него нет: класс выбирает человек в ленте задачи. Строка
 * называет, сколько задач ждут, и ведёт в ленту каждой — иначе «Деление ещё не готово.» не говорит,
 * что ждут именно его.
 */
function ClassWait({ tasks }: { tasks: readonly { taskId: string; n: number }[] }) {
  const { t } = useTranslation();
  return (
    <Stack gap="var(--spacing-3xs)" data-launch-class-wait={tasks.length}>
      <Typography variant="caption" color="warning" as="p">
        {t(`${P}.classWait`, { count: tasks.length })}
      </Typography>
      <ul className={styles.plainList}>
        {tasks.map(({ taskId, n }) => (
          <li key={taskId} data-launch-class-wait-task={taskId}>
            <a
              href={`${CORE_TASKS_ROUTE}?id=${encodeURIComponent(taskId)}`}
              className={styles.feedLink}
            >
              {/* Как ссылка на ленту в разделе групп: цвет акцента темы, размер строки над ней. */}
              <Typography variant="caption" as="span" color="accent" className={styles.mono}>
                {t('coreLaunch.estimate.groupTask', { n, id: taskId })}
              </Typography>
            </a>
          </li>
        ))}
      </ul>
    </Stack>
  );
}

/**
 * Карточки приёма всей группы одной кнопкой: каждой задаче с открытым вопросом — ответ
 * «Подтвердить карточку», как в её ленте. Неподтверждённая задача названа с причиной ядра;
 * повтор шлёт только тем, чья карточка ещё ждёт.
 */
export function GroupIntake({
  pending,
  classWaiting = [],
  rows,
  busy,
  onConfirm,
}: GroupIntakeProps) {
  const { t } = useTranslation();
  const refused = rows?.filter((r) => r.status === 'refused') ?? [];
  const confirmed = rows?.filter((r) => r.status === 'confirmed').length ?? 0;
  if (pending === 0 && rows === null && classWaiting.length === 0) return null;
  return (
    <Stack gap="var(--spacing-xs)" data-launch-intake={pending}>
      {classWaiting.length > 0 && <ClassWait tasks={classWaiting} />}
      {rows !== null && (
        <Typography
          variant="body-sm"
          as="p"
          color={refused.length > 0 ? undefined : 'success'}
          data-launch-intake-done={`${confirmed}/${rows.length}`}
        >
          {t(`${P}.done`, { confirmed, total: rows.length })}
        </Typography>
      )}
      {refused.map((r) => (
        <Typography
          key={r.taskId}
          variant="caption"
          color="danger"
          as="p"
          data-launch-intake-refused={r.taskId}
        >
          {t(`${P}.refused`, {
            task: r.taskId,
            reason: r.why ? t(`${P}.notReady.${r.why}`) : r.reason,
          })}
        </Typography>
      ))}
      {pending > 0 && (
        <>
          <Typography variant="caption" as="p">
            {t(`${P}.hint`)}
          </Typography>
          <div>
            <Button
              variant="secondary"
              leftIcon={<Icon name="check" />}
              onClick={onConfirm}
              isLoading={busy}
              data-launch-intake-button
              data-launch-intake-pending={pending}
            >
              {t(refused.length > 0 ? `${P}.retry` : `${P}.button`, { count: pending })}
            </Button>
          </div>
        </>
      )}
    </Stack>
  );
}
