import { useEffect, useRef, useState } from 'react';
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
  useFreePort,
  usePortHolders,
  useProjectRuns,
  useProjectRunnerInfo,
  useSaveRunnerSettings,
  useSetRunnerAutostart,
  useStartRunner,
  useStopRunner,
} from '@entities/ProjectRunner';
import type {
  BusyPortNoticeProps,
  ProjectRunnerControlsProps,
  RunnerChipProps,
  RunnerTargetRowProps,
} from './ProjectRunnerControls.types';
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

/** Порт из отказа сервера: он кладёт его в тело ответа рядом с сообщением. */
function busyPortOf(error: unknown): number | undefined {
  const data = (error as { response?: { data?: { busyPort?: unknown } } })?.response?.data;
  return typeof data?.busyPort === 'number' ? data.busyPort : undefined;
}

/** Подпись «откуда список целей» — догадка честно называется догадкой. */
function sourceHint(
  source: 'pnpm' | 'npm' | 'scan' | undefined,
  t: (key: string) => string,
): string {
  if (source === 'pnpm') return t('runner.sourcePnpm');
  if (source === 'npm') return t('runner.sourceNpm');
  if (source === 'scan') return t('runner.sourceScan');
  return t('runner.sourceSingle');
}

/**
 * Запущенная цель в ряду: ссылка на адрес и кнопка остановки. Адреса ещё нет —
 * вместо ссылки честная надпись, а не битый переход.
 */
function RunnerChip({ path, run, withName }: RunnerChipProps) {
  const { t } = useTranslation();
  const stop = useStopRunner();

  const label = withName ? run.name : t('runner.open');
  const isStarting = run.status === 'starting';

  return (
    <span className={styles.chip}>
      {run.url ? (
        <a className={styles.link} href={run.url} target="_blank" rel="noreferrer" title={run.url}>
          <Icon name="link" size={16} />
          {label}
          {run.port !== undefined && <span className={styles.port}>:{run.port}</span>}
        </a>
      ) : (
        <span
          className={styles.pending}
          title={isStarting ? run.command : t('runner.noAddressHint')}
        >
          <Icon name={isStarting ? 'history' : 'info'} size={16} />
          {isStarting ? t('runner.starting') : `${label} · ${t('runner.noAddress')}`}
        </span>
      )}

      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon={<Icon name="stop" size={16} />}
        aria-label={`${t('runner.stop')}: ${run.name}`}
        title={t('runner.stop')}
        isLoading={stop.isPending}
        onClick={() =>
          stop.mutate(
            { path, dir: run.dir },
            { onError: (error) => toast.error(toErrorMessage(error)) },
          )
        }
      />
    </span>
  );
}

/**
 * «Порт занят» — с именем процесса, который его держит, и одной кнопкой.
 *
 * Панель НИКОГО не убивает сама: даже когда порт держит явно чужой процесс,
 * решение остаётся за человеком — за портом может стоять база, соседний проект
 * или docker. Поэтому сначала показываем, кто там, и только клик освобождает
 * порт и повторяет запуск.
 */
function BusyPortNotice({ path, dir, port }: BusyPortNoticeProps) {
  const { t } = useTranslation();
  const holders = usePortHolders(port);
  const free = useFreePort();
  const start = useStartRunner();

  const who = (holders.data?.holders ?? [])
    .map(
      (holder) =>
        `${holder.name ?? 'PID'} · ${holder.pid}${holder.ours ? ` · ${t('runner.portOurs')}` : ''}`,
    )
    .join(', ');

  const onFree = (): void => {
    free.mutate(
      { port },
      {
        onSuccess: (info) => {
          // Порт мог не отпуститься: процесс без прав на убийство или сокет в
          // TIME_WAIT. Тогда честнее сказать это, чем запускать заведомо в стену.
          if (info.busy) {
            toast.error(t('runner.portStillBusy', { port }));
            return;
          }
          start.mutate({ path, dir }, { onError: (error) => toast.error(toErrorMessage(error)) });
        },
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  return (
    <span className={styles.busy} title={who || undefined}>
      <Icon name="warning" size={16} />
      <span className={styles.busyText}>
        {t('runner.portBusy', { port })}
        {who && <span className={styles.busyWho}>{who}</span>}
      </span>
      <Button
        variant="secondary"
        size="sm"
        isLoading={free.isPending || start.isPending}
        onClick={onFree}
      >
        {t('runner.freePort')}
      </Button>
    </span>
  );
}

/**
 * Одна цель в поповере: запуск, автозапуск и — под раскрытием — команда с портом.
 *
 * Поля скрыты по умолчанию не ради красоты: в монорепе целей может быть с
 * десяток, и список из одних заголовков читается, а список из форм — нет.
 * У единственной цели раскрывать нечего, поэтому она открыта сразу.
 */
function RunnerTargetRow({ path, target, run, defaultOpen }: RunnerTargetRowProps) {
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
