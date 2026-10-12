import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { toast } from '@shared/lib/toast';
import { useStopAllRunners } from '@entities/ProjectRunner';
import { useStartGroup } from '../../lib/useStartGroup';
import type { RunnerGroupActionsProps } from './RunnerGroupActions.types';
import styles from './RunnerGroupActions.module.scss';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';

/**
 * Набор целей проекта одной кнопкой. Бэкенд почти никогда не один процесс:
 * API, воркер, фронт — и поднимать их по одному каждое утро скучно и легко
 * забыть один. Набор помечается галочками и запоминается на проект.
 *
 * «Остановить всё» гасит всё, что панель запустила в этом проекте, — не только
 * набор: кнопка про «закончил работу», а не про отметки.
 *
 * Погасив всё, кнопка становится недоступной — и фокус с неё падал на body:
 * Escape после этого поповер уже не закрывал. Поэтому фокус возвращается в блок.
 */
export function RunnerGroupActions({ path, targets, liveCount }: RunnerGroupActionsProps) {
  const { t } = useTranslation();
  const startGroup = useStartGroup(path);
  const stopAll = useStopAllRunners();
  const chosen = targets.filter((target) => target.inGroup).length;
  const blockRef = useRef<HTMLDivElement>(null);

  const onStopAll = (): void => {
    stopAll.mutate(
      { path },
      {
        onSuccess: () => blockRef.current?.focus(),
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  return (
    <div ref={blockRef} tabIndex={-1} className={styles.block}>
      <Stack gap="var(--spacing-3xs)">
        <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="play" size={16} />}
            disabled={chosen === 0}
            isLoading={startGroup.isPending}
            onClick={startGroup.run}
          >
            {t('runner.startAll', { count: chosen })}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Icon name="stop" size={16} />}
            disabled={liveCount === 0}
            isLoading={stopAll.isPending}
            onClick={onStopAll}
          >
            {t('runner.stopAll')}
          </Button>
        </Stack>
        <Typography variant="caption" color="subtle">
          {chosen === 0 ? t('runner.groupEmpty') : t('runner.groupHint')}
        </Typography>
      </Stack>
    </div>
  );
}
