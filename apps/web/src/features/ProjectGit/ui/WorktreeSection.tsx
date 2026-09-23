import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { workspace, normalizeProjectPath, projectShortName } from '@shared/lib/workspace';
import { isLive, useProjectStatuses } from '@shared/lib/agent-runs';
import {
  useProjectWorktrees,
  useAddWorktree,
  useRemoveWorktree,
  useMirrorWorktree,
  useBootstrapWorktree,
} from '@entities/ProjectGit';
import type { ProjectWorktree, WorktreeMirrorReport as MirrorReport } from '@entities/ProjectGit';
import type { WorktreeSectionProps } from './WorktreeSection.types';
import { WorktreeMirrorReport } from './WorktreeMirrorReport';
import { WorktreeMirrorSettings } from './WorktreeMirrorSettings';
import { SplitSettings } from './SplitSettings';
import { WorktreeBootstrapCard } from './WorktreeBootstrapCard';
import { WorktreeReadiness } from './WorktreeReadiness';
import styles from './WorktreeSection.module.scss';
import { serverFieldText } from '@shared/config/i18n';

/**
 * Параллельные ветки: список рабочих копий репозитория и заведение новой.
 *
 * Ради чего раздел существует: несколько агентов работают над одним проектом
 * одновременно, и каждому нужен СВОЙ каталог — иначе они переключают ветку друг
 * под другом и перемешивают правки в одном рабочем дереве. Копия открывается
 * обычной вкладкой проекта, поэтому дальше всё привычное: свой чат, своя точка
 * состояния, свой агент.
 *
 * Ветка у строки — та, что git назвал ТОЛЬКО ЧТО, а не та, под которую копию
 * заводили: агент внутри волен переключаться и заводить ветки сам, и панель ему
 * не указ. Слияния здесь нет намеренно — сводит ветки человек.
 *
 * Кнопка «убрать» выключена, пока в копии работает агент: снести каталог из-под
 * живого процесса — потерять его работу молча. Сервер отвечает тем же отказом,
 * так что запрет держится и для телефона.
 *
 * Локальный слой (`.mcp.json` под skip-worktree, `.claude/`, `.env`, `.agent/`)
 * сервер переносит в копию сам при создании; кнопка «Обновить локальный слой»
 * повторяет перенос в уже живую копию, а отчёт о нём ложится под её карточку.
 *
 * Под каждой копией стоит её ПОЛНОТА — состояние, а не событие. Отчёт зеркала
 * живёт до перезагрузки вкладки, а отказывает запуску агента сервер по сверке,
 * которую делает заново перед каждым прогоном: без постоянной строки человек
 * узнавал бы о неполной копии только отправив сообщение. Кнопка «Добрать» —
 * то же зеркало, что и «Обновить локальный слой»: оно же заводит и запись
 * доступа в `.claude.json`, то есть закрывает все три вида дыр.
 */
/** Тон значка по состоянию агента в копии — тот же язык цвета, что и в пульте. */
const STATUS_TONE = {
  running: 'info',
  quiet: 'neutral',
  waiting: 'warning',
  error: 'danger',
  idle: 'neutral',
} as const;

export function WorktreeSection({ path, busy }: WorktreeSectionProps) {
  const { t } = useTranslation();
  const statuses = useProjectStatuses();
  const [name, setName] = useState('');
  // Копия, которую git отказался убрать из-за незакоммиченной работы: для неё
  // (и только для неё) показываем повторную кнопку, уже с force.
  const [forceFor, setForceFor] = useState<string | undefined>(undefined);
  // Последний отчёт зеркала и копия, к которой он относится. Один на раздел:
  // отчёт — событие, а не свойство копии, и к следующему зеркалу приходит новый.
  const [mirrorReport, setMirrorReport] = useState<
    { path: string; report: MirrorReport } | undefined
  >(undefined);

  const worktrees = useProjectWorktrees(path);
  const add = useAddWorktree();
  const remove = useRemoveWorktree();
  const mirror = useMirrorWorktree();
  const bootstrap = useBootstrapWorktree();

  const info = worktrees.data;
  if (!info?.isRepo || info.error) return null;

  const pending = add.isPending || remove.isPending || mirror.isPending || bootstrap.isPending;
  const list = info.worktrees;

  const openTab = (target: string): void => {
    workspace.openProject(target, projectShortName(target));
  };

  const onAdd = (): void => {
    const value = name.trim();
    if (!value) return;
    add.mutate(
      { path, name: value },
      {
        onSuccess: (result) => {
          setName('');
          toast.success(serverFieldText(result, 'output'));
          if (result.mirror && result.createdPath) {
            setMirrorReport({ path: result.createdPath, report: result.mirror });
          }
          // Копия заведена — сразу открываем её вкладкой: ради этого всё и
          // затевалось, а искать её потом в списке — лишний шаг.
          if (result.createdPath) openTab(result.createdPath);
        },
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  const onRemove = (worktree: ProjectWorktree, force: boolean): void => {
    remove.mutate(
      { path, worktreePath: worktree.path, ...(force ? { force: true } : {}) },
      {
        onSuccess: (result) => {
          setForceFor(undefined);
          toast.success(serverFieldText(result, 'output'));
        },
        onError: (error) => {
          // Отказ git — обычно «внутри есть незакоммиченное». Не решаем за
          // человека: показываем причину и открываем повтор с force.
          setForceFor(worktree.path);
          toast.error(toErrorMessage(error));
        },
      },
    );
  };

  const onMirror = (worktree: ProjectWorktree): void => {
    mirror.mutate(
      { path, worktreePath: worktree.path },
      {
        onSuccess: (result) => {
          toast.success(serverFieldText(result, 'output'));
          if (result.mirror) setMirrorReport({ path: worktree.path, report: result.mirror });
        },
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  const onBootstrap = (worktree: ProjectWorktree): void => {
    bootstrap.mutate(
      { path, worktreePath: worktree.path },
      {
        onSuccess: (result) => toast.success(serverFieldText(result, 'output')),
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  return (
    <Stack gap="var(--spacing-2xs)" className={styles.section}>
      <Typography variant="body-sm" weight="medium" as="span">
        {t('git.worktrees.title')}
      </Typography>

      <div className={styles.list} aria-label={t('git.worktrees.title')}>
        {list.map((worktree) => {
          const status = statuses.get(normalizeProjectPath(worktree.path));
          const isBusy = status !== undefined && (isLive(status) || status === 'waiting');
          return (
            <div key={worktree.path} className={styles.item}>
              <Stack
                direction="row"
                align="center"
                gap="var(--spacing-3xs)"
                className={styles.head}
              >
                <span className={styles.branch} title={worktree.path}>
                  {worktree.branch ?? t('git.detached')}
                </span>
                {worktree.isMain && <Badge tone="neutral">{t('git.worktrees.main')}</Badge>}
                {status && (
                  <Badge tone={STATUS_TONE[status]}>{t(`workspace.status.${status}`)}</Badge>
                )}
                {worktree.locked && <Badge tone="warning">{t('git.worktrees.locked')}</Badge>}
                {worktree.prunable && <Badge tone="danger">{t('git.worktrees.gone')}</Badge>}
              </Stack>

              <span className={styles.path} title={worktree.path}>
                {worktree.path}
              </span>

              <Stack direction="row" gap="var(--spacing-3xs)" wrap>
                <Button variant="ghost" size="sm" onClick={() => openTab(worktree.path)}>
                  {t('git.worktrees.open')}
                </Button>
                {!worktree.isMain && !worktree.prunable && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || pending}
                    title={t('git.worktrees.mirrorHint')}
                    leftIcon={<Icon name="refresh" size={16} />}
                    onClick={() => onMirror(worktree)}
                  >
                    {t('git.worktrees.mirror')}
                  </Button>
                )}
                {!worktree.isMain && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || pending || isBusy}
                    title={isBusy ? t('git.worktrees.busyHint') : undefined}
                    leftIcon={<Icon name="trash" size={16} />}
                    onClick={() => onRemove(worktree, false)}
                  >
                    {t('git.worktrees.remove')}
                  </Button>
                )}
                {forceFor === worktree.path && !worktree.isMain && (
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busy || pending || isBusy}
                    onClick={() => onRemove(worktree, true)}
                  >
                    {t('git.worktrees.removeForce')}
                  </Button>
                )}
              </Stack>

              {/* Полнота копии — раньше отчёта: отказ прогона приходит по ней, а
                  не по следам последнего зеркала. */}
              {worktree.copy && (
                <WorktreeReadiness
                  state={worktree.copy}
                  disabled={busy || pending}
                  onRepair={() => onMirror(worktree)}
                />
              )}
              {!worktree.isMain && (
                <WorktreeBootstrapCard
                  path={path}
                  worktree={worktree}
                  disabled={busy || pending}
                  onRerun={() => onBootstrap(worktree)}
                />
              )}
              {mirrorReport?.path === worktree.path && (
                <WorktreeMirrorReport
                  report={mirrorReport.report}
                  onClose={() => setMirrorReport(undefined)}
                />
              )}
            </div>
          );
        })}
      </div>

      <Stack direction="row" gap="var(--spacing-2xs)">
        <input
          className={styles.input}
          value={name}
          placeholder={t('git.worktrees.namePlaceholder')}
          disabled={busy || pending}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && onAdd()}
        />
        <Button
          variant="secondary"
          size="sm"
          isLoading={add.isPending}
          disabled={busy || pending || !name.trim()}
          onClick={onAdd}
        >
          {t('git.worktrees.add')}
        </Button>
      </Stack>

      <Typography variant="caption" color="subtle">
        {t('git.worktrees.note')}
      </Typography>

      <WorktreeMirrorSettings path={path} disabled={busy || pending} />
      <SplitSettings path={path} disabled={busy || pending} />
    </Stack>
  );
}
