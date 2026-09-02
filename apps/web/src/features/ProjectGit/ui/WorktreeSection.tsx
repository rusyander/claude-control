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
import { useProjectWorktrees, useAddWorktree, useRemoveWorktree } from '@entities/ProjectGit';
import type { ProjectWorktree } from '@entities/ProjectGit';
import type { WorktreeSectionProps } from './WorktreeSection.types';
import styles from './WorktreeSection.module.scss';

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

  const worktrees = useProjectWorktrees(path);
  const add = useAddWorktree();
  const remove = useRemoveWorktree();

  const info = worktrees.data;
  if (!info?.isRepo || info.error) return null;

  const pending = add.isPending || remove.isPending;
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
          toast.success(result.output);
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
          toast.success(result.output);
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

              <Stack direction="row" gap="var(--spacing-3xs)">
                <Button variant="ghost" size="sm" onClick={() => openTab(worktree.path)}>
                  {t('git.worktrees.open')}
                </Button>
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
    </Stack>
  );
}
