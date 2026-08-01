import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Stack } from '@shared/ui/stack';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import {
  useSaveRunnerSettings,
  useSetRunnerAutostart,
  useStartRunner,
  useStopRunner,
} from '@entities/ProjectRunner';
import { busyPortOf } from '../lib/runnerHints';
import { BusyPortNotice } from './BusyPortNotice';
import type { RunnerTargetRowProps } from './RunnerTargetRow.types';
import styles from './ProjectRunnerControls.module.scss';

/**
 * Одна цель в поповере: запуск, автозапуск и — под раскрытием — команда с портом.
 *
 * Поля скрыты по умолчанию не ради красоты: в монорепе целей может быть с
 * десяток, и список из одних заголовков читается, а список из форм — нет.
 * У единственной цели раскрывать нечего, поэтому она открыта сразу.
 */
export function RunnerTargetRow({ path, target, run, defaultOpen }: RunnerTargetRowProps) {
  const { t } = useTranslation();
  const [isOpen, setOpen] = useState(defaultOpen);
  const [command, setCommand] = useState(target.commandOverride ?? '');
  const [port, setPort] = useState(target.pinnedPort ? String(target.pinnedPort) : '');

  const start = useStartRunner();
  const stop = useStopRunner();
  const autostart = useSetRunnerAutostart();
  const save = useSaveRunnerSettings();

  // Закреплённый порт занят — панель отказывает ещё до запуска, поэтому номер
  // приходит не поллингом, а прямо в ответе на старт.
  const [refusedPort, setRefusedPort] = useState<number | undefined>();
  const busyPort = (run?.status === 'error' ? run.busyPort : undefined) ?? refusedPort;

  const isLive = run?.status === 'running' || run?.status === 'starting';
  const failed = (error: unknown): void => {
    setRefusedPort(busyPortOf(error));
    toast.error(toErrorMessage(error));
  };

  const onSave = (): void => {
    const parsed = Number(port.trim());
    save.mutate(
      {
        path,
        dir: target.dir,
        command,
        // Пустое поле — снять закрепление: порт снова читается из вывода.
        port: port.trim() && Number.isInteger(parsed) ? parsed : null,
      },
      { onSuccess: () => toast.success(t('runner.saved')), onError: failed },
    );
  };

  return (
    <div className={styles.target}>
      <div className={styles.targetHead}>
        <button
          type="button"
          className={styles.disclosure}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={isOpen}
        >
          <Icon
            name="chevronRight"
            size={16}
            className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}
          />
          <span className={styles.targetName}>{target.name}</span>
          <Badge tone={target.dir ? 'info' : 'neutral'}>{target.dir || t('runner.root')}</Badge>
        </button>

        <Stack direction="row" align="center" gap="var(--spacing-3xs)">
          <Toggle
            size="sm"
            checked={target.autostart}
            disabled={autostart.isPending || !target.runnable}
            onCheckedChange={(enabled) =>
              autostart.mutate({ path, dir: target.dir, enabled }, { onError: failed })
            }
            aria-label={`${t('runner.autostart')}: ${target.name}`}
          />
          <Typography variant="caption" color={target.autostart ? 'default' : 'subtle'} as="span">
            {t('runner.autostart')}
          </Typography>

          {isLive ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="stop" size={16} />}
              aria-label={`${t('runner.stop')}: ${target.name}`}
              isLoading={stop.isPending}
              onClick={() => stop.mutate({ path, dir: target.dir }, { onError: failed })}
            />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="send" size={16} />}
              aria-label={`${t('runner.start')}: ${target.name}`}
              disabled={!target.runnable}
              isLoading={start.isPending}
              onClick={() => start.mutate({ path, dir: target.dir }, { onError: failed })}
            />
          )}
        </Stack>
      </div>

      {isOpen && (
        <Stack gap="var(--spacing-2xs)" padding="0 0 var(--spacing-2xs)">
          <Typography variant="caption" color={target.runnable ? 'subtle' : 'warning'}>
            {target.runnable ? target.command : target.reason}
          </Typography>

          <label className={styles.field}>
            <Typography variant="caption" color="subtle" as="span">
              {t('runner.command')}
            </Typography>
            <input
              className={styles.input}
              value={command}
              placeholder={target.command ?? 'pnpm run dev'}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && onSave()}
            />
          </label>

          <label className={styles.field}>
            <Typography variant="caption" color="subtle" as="span">
              {t('runner.port')}
            </Typography>
            <input
              className={`${styles.input} ${styles.inputNarrow}`}
              value={port}
              inputMode="numeric"
              placeholder={t('runner.portAuto')}
              onChange={(event) => setPort(event.target.value.replace(/\D/g, ''))}
              onKeyDown={(event) => event.key === 'Enter' && onSave()}
            />
          </label>

          <Typography variant="caption" color="subtle">
            {target.lastPort
              ? t('runner.portHintLast', { port: target.lastPort })
              : t('runner.portHint')}
          </Typography>

          <Stack direction="row" gap="var(--spacing-2xs)">
            <Button variant="secondary" size="sm" isLoading={save.isPending} onClick={onSave}>
              {t('common.save')}
            </Button>
          </Stack>

          {busyPort !== undefined && !isLive && (
            <BusyPortNotice path={path} dir={target.dir} port={busyPort} />
          )}

          {/* Вывод показываем только когда он что-то объясняет: упавший запуск
              или работающий сервер, который не назвал адреса. */}
          {run?.output && (run.status === 'error' || !run.url) && (
            <details className={styles.output}>
              <summary>{t('runner.output')}</summary>
              <pre>{run.output}</pre>
            </details>
          )}
        </Stack>
      )}
    </div>
  );
}
