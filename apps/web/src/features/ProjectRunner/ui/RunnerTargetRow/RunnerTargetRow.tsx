import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Stack } from '@shared/ui/stack';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { toast } from '@shared/lib/toast';
import {
  useSaveRunnerSettings,
  useSetRunnerAutostart,
  useSetRunnerGroup,
  useStartRunner,
  useStopRunner,
} from '@entities/ProjectRunner';
import { busyPortOf } from '../../lib/runnerHints';
import { stackLabel, targetProblem } from '../../lib/targetFacts';
import { BusyPortNotice } from '../BusyPortNotice/BusyPortNotice';
import { RunnerCandidates } from '../RunnerCandidates/RunnerCandidates';
import type { RunnerTargetRowProps } from './RunnerTargetRow.types';
import styles from './RunnerTargetRow.module.scss';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';

/**
 * Одна цель в поповере: запуск, автозапуск и — под раскрытием — команда с портом.
 *
 * Поля скрыты по умолчанию не ради красоты: в монорепе целей может быть с
 * десяток, и список из одних заголовков читается, а список из форм — нет.
 * У единственной цели раскрывать нечего, поэтому она открыта сразу.
 *
 * Стек виден в заголовке (`Go`, `FastAPI`): в монорепе с бэкендом цели одного
 * имени различаются именно им. Галочка в начале строки — цель входит в
 * «Запустить всё»; у единственной цели набора не бывает, и галочки нет.
 */
export function RunnerTargetRow({
  path,
  target,
  run,
  defaultOpen,
  showGroup,
}: RunnerTargetRowProps) {
  const { t } = useTranslation();
  const [isOpen, setOpen] = useState(defaultOpen);
  const [command, setCommand] = useState(target.commandOverride ?? '');
  const [port, setPort] = useState(target.pinnedPort ? String(target.pinnedPort) : '');

  const start = useStartRunner();
  const stop = useStopRunner();
  const autostart = useSetRunnerAutostart();
  const save = useSaveRunnerSettings();
  const group = useSetRunnerGroup();

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

  /** Выбор из найденных сохраняется сразу: это и есть решение, а не черновик. */
  const onChoose = async (chosen: string): Promise<boolean> => {
    setCommand(chosen);
    try {
      await save.mutateAsync({
        path,
        dir: target.dir,
        command: chosen,
        port: target.pinnedPort ?? null,
      });
      toast.success(t('runner.saved'));
      return true;
    } catch (error) {
      setCommand(target.commandOverride ?? '');
      failed(error);
      return false;
    }
  };

  const stack = stackLabel(target.stack, target.framework, t);
  const problem = targetProblem(target, t);
  const evidence = target.evidence ?? [];

  return (
    <div className={styles.target}>
      <div className={styles.targetHead}>
        {showGroup && (
          <input
            type="checkbox"
            className={styles.groupMark}
            checked={target.inGroup}
            disabled={group.isPending}
            onChange={(event) =>
              group.mutate(
                { path, dir: target.dir, inGroup: event.target.checked },
                { onError: failed },
              )
            }
            aria-label={`${t('runner.inGroup')}: ${target.name}`}
            title={t('runner.inGroupHint')}
          />
        )}
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
          {stack && <Badge tone="neutral">{stack}</Badge>}
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
              icon={<Icon name="play" size={16} />}
              aria-label={`${t('runner.start')}: ${target.name}`}
              title={target.runnable ? target.command : problem}
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
            {target.runnable ? target.command : problem}
          </Typography>
          {evidence.length > 0 && (
            <Typography variant="caption" color="subtle">
              {t('runner.evidence', { files: evidence.join(', ') })}
            </Typography>
          )}

          <RunnerCandidates target={target} isBusy={save.isPending} onChoose={onChoose} />

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
