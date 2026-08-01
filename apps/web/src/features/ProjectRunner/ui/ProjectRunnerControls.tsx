import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { useProjectRuns, useProjectRunnerInfo, useStartRunner } from '@entities/ProjectRunner';
import { sourceHint } from '../lib/runnerHints';
import { BusyPortNotice } from './BusyPortNotice';
import { RunnerChip } from './RunnerChip';
import { RunnerTargetRow } from './RunnerTargetRow';
import type { ProjectRunnerControlsProps } from './ProjectRunnerControls.types';
import styles from './ProjectRunnerControls.module.scss';

/**
 * Dev-серверы проекта в ряду вкладки.
 *
 * Запускается не «проект», а ЦЕЛЬ — каталог со своим package.json. У монорепы
 * их несколько (`apps/web`, `apps/api`), и работать они могут одновременно:
 * поэтому в ряду не одна кнопка, а по ссылке на каждый поднятый сервер и общая
 * кнопка запуска. Одна цель — ряд выглядит ровно как раньше.
 *
 * АДРЕС ПАНЕЛЬ НЕ ВЫДУМЫВАЕТ. Порт печатает сам dev-сервер, панель читает его из
 * вывода — поэтому ссылка появляется не мгновенно, а следующим опросом статуса.
 * Сервер, который адреса не печатает, остаётся работать без ссылки, и порт ему
 * можно закрепить руками в поповере настроек.
 */
export function ProjectRunnerControls({ path }: ProjectRunnerControlsProps) {
  const { t } = useTranslation();
  const [isOpen, setOpen] = useState(false);

  const info = useProjectRunnerInfo(path);
  const runs = useProjectRuns(path);
  const start = useStartRunner();

  const targets = info.data?.targets ?? [];
  const live = runs.filter((run) => run.status === 'running' || run.status === 'starting');
  // Упавшие из-за занятого порта — им предлагаем освободить порт прямо в ряду:
  // прятать это в поповер значит прятать единственное действие, которое поможет.
  const blocked = runs.filter((run) => run.status === 'error' && run.busyPort !== undefined);

  // Ошибку запуска видно не сразу: процесс падает уже после ответа «starting», а
  // приходит это поллингом. Сообщаем тостом один раз на каждую упавшую цель.
  const reported = useRef(new Set<string>());
  useEffect(() => {
    for (const run of runs) {
      if (run.status !== 'error' || reported.current.has(run.path)) continue;
      reported.current.add(run.path);
      toast.error(run.error || t('runner.failed'));
    }
    for (const key of [...reported.current]) {
      if (!runs.some((run) => run.path === key && run.status === 'error')) {
        reported.current.delete(key);
      }
    }
  }, [runs, t]);

  if (targets.length === 0) return null;

  const idle = targets.filter(
    (target) => target.runnable && !live.some((run) => run.dir === target.dir),
  );

  /** Одна свободная цель — запускаем сразу; несколько — пусть человек выберет. */
  const onStart = (): void => {
    const [only] = idle;
    if (idle.length !== 1 || !only) {
      setOpen(true);
      return;
    }
    start.mutate(
      { path, dir: only.dir },
      { onError: (error) => toast.error(toErrorMessage(error)) },
    );
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.row}>
        {live.map((run) => (
          <RunnerChip key={run.path} path={path} run={run} withName={targets.length > 1} />
        ))}

        {blocked.map((run) => (
          <BusyPortNotice
            key={`busy-${run.path}`}
            path={path}
            dir={run.dir}
            port={run.busyPort ?? 0}
          />
        ))}

        {idle.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="send" size={18} />}
            isLoading={start.isPending}
            onClick={onStart}
            title={idle.length === 1 ? idle[0]?.command : t('runner.chooseTarget')}
          >
            {t('runner.start')}
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={<Icon name="settings" size={18} />}
          aria-label={t('runner.settings')}
          aria-expanded={isOpen}
          title={t('runner.settings')}
          onClick={() => setOpen((value) => !value)}
        />
      </div>

      {isOpen && (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} aria-hidden="true" />
          <div className={styles.panel} role="dialog" aria-label={t('runner.settings')}>
            <Stack gap="var(--spacing-sm)" padding="var(--spacing-sm)">
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body-sm" weight="medium">
                  {t('runner.targets')}
                </Typography>
                <Typography variant="caption" color="subtle">
                  {sourceHint(info.data?.workspaceSource, t)}
                </Typography>
                {(info.data?.skipped ?? 0) > 0 && (
                  <Typography variant="caption" color="warning">
                    {t('runner.skipped', { count: info.data?.skipped })}
                  </Typography>
                )}
              </Stack>

              <div className={styles.targets}>
                {targets.map((target) => (
                  <RunnerTargetRow
                    key={target.dir}
                    path={path}
                    target={target}
                    run={runs.find((run) => run.dir === target.dir)}
                    defaultOpen={targets.length === 1}
                  />
                ))}
              </div>

              <Typography variant="caption" color="subtle">
                {t('runner.note')}
              </Typography>
            </Stack>
          </div>
        </>
      )}
    </div>
  );
}
