import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import {
  useProjectRunner,
  useProjectRunnerInfo,
  useStartRunner,
  useStopRunner,
} from '@entities/ProjectRunner';
import type { ProjectRunnerControlsProps } from './ProjectRunnerControls.types';
import styles from './ProjectRunnerControls.module.scss';

/**
 * Управление dev-сервером проекта в ряду вкладки-проекта: одна кнопка
 * Запустить/Остановить со статусом и ссылка «Перейти» на открытый URL.
 *
 * Пока сервер поднимается — кнопка в состоянии загрузки; поднялся — панель
 * сама открыла браузер, кнопка стала «Остановить», а «Перейти» ведёт на адрес.
 * Нет команды запуска (ни dev/start, ни оверрайда) — кнопка задизейблена с
 * подсказкой. Ошибка запуска приходит поллингом статуса и показывается тостом.
 */
export function ProjectRunnerControls({ path }: ProjectRunnerControlsProps) {
  const { t } = useTranslation();
  const runner = useProjectRunner(path);
  const info = useProjectRunnerInfo(path);
  const start = useStartRunner();
  const stop = useStopRunner();

  const status = runner?.status;
  const isRunning = status === 'running';
  const isStarting = status === 'starting';

  // Ошибка запуска становится видимой не сразу (сервер падает уже после ответа
  // «starting»), а приходит поллингом — тогда и сообщаем тостом, один раз.
  const prevStatus = useRef(status);
  useEffect(() => {
    if (prevStatus.current !== 'error' && status === 'error') {
      toast.error(runner?.error || t('runner.failed'));
    }
    prevStatus.current = status;
  }, [status, runner?.error, t]);

  const onStart = (): void => {
    start.mutate(path, { onError: (error) => toast.error(toErrorMessage(error)) });
  };
  const onStop = (): void => {
    stop.mutate(path, { onError: (error) => toast.error(toErrorMessage(error)) });
  };

  const runnable = info.data?.runnable ?? true;
  const stopBusy = stop.isPending;
  const startBusy = start.isPending || isStarting;

  return (
    <div className={styles.row}>
      {isRunning || isStarting ? (
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Icon name="stop" size={18} />}
          isLoading={stopBusy || isStarting}
          onClick={onStop}
          title={runner?.command}
        >
          {isStarting ? t('runner.starting') : t('runner.stop')}
        </Button>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Icon name="send" size={18} />}
          isLoading={startBusy}
          disabled={!runnable}
          onClick={onStart}
          title={runnable ? (info.data?.command ?? t('runner.start')) : t('runner.notRunnable')}
        >
          {t('runner.start')}
        </Button>
      )}

      {isRunning && runner && (
        <a
          className={styles.link}
          href={runner.url}
          target="_blank"
          rel="noreferrer"
          title={runner.url}
        >
          <Icon name="link" size={18} />
          {t('runner.open')}
        </a>
      )}
    </div>
  );
}
