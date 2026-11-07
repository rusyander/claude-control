import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { CORE_TASKS_ROUTE } from '@shared/config/routes';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import type { GroupLaunchRow } from '../../model/groupLaunch';
import type { LaunchBlocker } from '../../model/launch.types';
import { LaunchSection } from '../LaunchSection/LaunchSection';
import { GroupIntake, type GroupIntakeProps } from './GroupIntake';

interface LaunchCardProps {
  blockers: LaunchBlocker[];
  canLaunch: boolean;
  launching: boolean;
  launched: boolean;
  /** Задач в группе, которые запускает кнопка; `0` — одиночная задача. */
  groupSize?: number;
  /** Исход последнего запуска группы по задачам; `null` — группу ещё не запускали. */
  groupRows?: GroupLaunchRow[] | null;
  /** Группа: карточки приёма всех задач одной кнопкой; нет — одиночная задача. */
  intake?: GroupIntakeProps;
  onLaunch: () => void;
}

const P = 'coreLaunch.launch';

/**
 * Исход запуска группы: сколько задач пошло и строка на каждую незапущенную — с её причиной.
 * Молча запущенная часть группы выглядела бы «запущено всё».
 */
function GroupOutcome({ rows }: { rows: GroupLaunchRow[] }) {
  const { t } = useTranslation();
  const started = rows.filter((r) => r.status === 'started').length;
  return (
    <Stack gap="var(--spacing-xs)" data-launch-group={`${started}/${rows.length}`}>
      <Typography variant="body-sm" as="p" data-launch-group-started>
        {t(`${P}.group.started`, { started, total: rows.length })}
      </Typography>
      {rows.map((r) =>
        r.status === 'refused' ? (
          <Typography
            key={r.taskId}
            variant="caption"
            color="danger"
            as="p"
            data-launch-group-refused={r.taskId}
          >
            {t(`${P}.group.refused`, {
              task: r.taskId,
              reason: r.why ? t(`${P}.group.notReady.${r.why}`) : r.reason,
            })}
          </Typography>
        ) : null,
      )}
    </Stack>
  );
}

/**
 * Кнопка запуска и всё, что её держит. Каждая причина названа строкой: серая кнопка без
 * объяснения заставила бы гадать, что ещё не сделано. Группа запускается вся одной кнопкой.
 */
export function LaunchCard({
  blockers,
  canLaunch,
  launching,
  launched,
  groupSize = 0,
  groupRows = null,
  intake,
  onLaunch,
}: LaunchCardProps) {
  const { t } = useTranslation();
  const partial = groupRows !== null && groupRows.some((r) => r.status === 'refused');
  const label =
    groupSize > 0
      ? t(partial ? `${P}.group.retry` : `${P}.group.button`, { count: groupSize })
      : t(`${P}.button`);
  return (
    <LaunchSection title={t(`${P}.heading`)} name="launch">
      <Stack gap="var(--spacing-sm)" data-launch-blockers={blockers.join(' ')}>
        {groupSize > 0 && intake && !launched && <GroupIntake {...intake} />}
        {blockers.map((b) => (
          <Typography key={b} variant="caption" color="warning" as="p" data-launch-blocker={b}>
            {t(`${P}.blocker.${b}`)}
          </Typography>
        ))}
        {partial && groupRows && <GroupOutcome rows={groupRows} />}
        {launched ? (
          <Stack gap="var(--spacing-xs)">
            <Typography variant="body-sm" color="success" as="p" role="status">
              {groupSize > 0 ? t(`${P}.group.allStarted`, { count: groupSize }) : t(`${P}.started`)}
            </Typography>
            <div>
              <Link to={CORE_TASKS_ROUTE}>
                <Button variant="secondary">{t(`${P}.open`)}</Button>
              </Link>
            </div>
          </Stack>
        ) : (
          <div>
            <Button
              leftIcon={<Icon name="play" />}
              onClick={onLaunch}
              disabled={!canLaunch}
              isLoading={launching}
              data-launch-button
              data-launch-group-size={groupSize}
            >
              {label}
            </Button>
          </div>
        )}
      </Stack>
    </LaunchSection>
  );
}
