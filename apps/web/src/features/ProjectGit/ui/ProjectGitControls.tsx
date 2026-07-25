import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import {
  useProjectGit,
  useCheckoutBranch,
  useCreateBranch,
  useCommitAll,
} from '@entities/ProjectGit';
import type { ProjectGitControlsProps } from './ProjectGitControls.types';
import styles from './ProjectGitControls.module.scss';

/**
 * Git проекта в ряду вкладки: кнопка с текущей веткой, а под ней — всё
 * остальное. Раздел появляется ТОЛЬКО когда в каталоге проекта есть `.git`:
 * иначе кнопки нет вовсе, а не «пустой git».
 *
 * Ряд вкладки и так плотный, поэтому в нём живёт одна кнопка «⑂ ветка · N», а
 * список веток, поле новой ветки и поле коммита открываются поповером — как у
 * пульта агентов рядом. Так три операции доступны в один клик и ничего не
 * занимает место, пока не понадобилось.
 *
 * Число рядом с веткой — сколько файлов изменено; по нему же включается кнопка
 * коммита: коммитить нечего — она заблокирована, а не падает ошибкой.
 */
export function ProjectGitControls({ path }: ProjectGitControlsProps) {
  const { t } = useTranslation();
  const [isOpen, setOpen] = useState(false);
  const [newBranch, setNewBranch] = useState('');
  const [message, setMessage] = useState('');

  const git = useProjectGit(path);
  const checkout = useCheckoutBranch();
  const create = useCreateBranch();
  const commit = useCommitAll();

  const info = git.data;
  // Нет репозитория — раздела нет. Пока состояние не пришло, кнопку тоже не
  // показываем: мигать ею у проекта без git было бы неправдой.
  if (!info?.isRepo) return null;

  const busy = checkout.isPending || create.isPending || commit.isPending;
  const branchLabel = info.branch ?? (info.detached ? t('git.detached') : t('git.noBranch'));

  /** Общий разбор ответа: успех — тост с выводом git, ошибка — тост с причиной. */
  const done = (result: { output: string }): void => {
    toast.success(result.output);
  };
  const failed = (error: unknown): void => {
    toast.error(toErrorMessage(error));
  };

  const onCheckout = (branch: string): void => {
    if (!branch || branch === info.branch) return;
    checkout.mutate({ path, branch }, { onSuccess: done, onError: failed });
  };

  const onCreate = (): void => {
    const name = newBranch.trim();
    if (!name) return;
    create.mutate(
      { path, name },
      {
        onSuccess: (result) => {
          setNewBranch('');
          done(result);
        },
        onError: failed,
      },
    );
  };

  const onCommit = (): void => {
    const text = message.trim();
    if (!text) return;
    commit.mutate(
      { path, message: text },
      {
        onSuccess: (result) => {
          setMessage('');
          done(result);
        },
        onError: failed,
      },
    );
  };

  return (
    <div className={styles.wrap}>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={<Icon name="branch" size={18} />}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={isOpen}
        title={t('git.hint', { branch: branchLabel })}
      >
        <span className={styles.branch}>{branchLabel}</span>
        {info.dirtyCount > 0 && <Badge tone="warning">{info.dirtyCount}</Badge>}
      </Button>

      {isOpen && (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} aria-hidden="true" />
          <div className={styles.panel} role="dialog" aria-label={t('git.title')}>
            <Stack gap="var(--spacing-sm)" padding="var(--spacing-sm)">
              {info.error ? (
                <Typography variant="body-sm" color="danger">
                  {info.error}
                </Typography>
              ) : (
                <>
                  <Typography variant="caption" color="subtle">
                    {info.dirtyCount > 0
                      ? t('git.dirty', { count: info.dirtyCount })
                      : t('git.clean')}
                  </Typography>

                  {/* Переключение: выбор из локальных веток, сразу и без «Применить»
                      — лишний шаг там, где выбор и есть действие. */}
                  <label className={styles.row}>
                    <Typography variant="body-sm" weight="medium" as="span">
                      {t('git.branch')}
                    </Typography>
                    <select
                      className={styles.select}
                      value={info.branch ?? ''}
                      disabled={busy || info.branches.length === 0}
                      onChange={(event) => onCheckout(event.target.value)}
                    >
                      {!info.branch && <option value="">{branchLabel}</option>}
                      {info.branches.map((branch) => (
                        <option key={branch} value={branch}>
                          {branch}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className={styles.row}>
                    <Typography variant="body-sm" weight="medium" as="span">
                      {t('git.newBranch')}
                    </Typography>
                    <Stack direction="row" gap="var(--spacing-2xs)">
                      <input
                        className={styles.input}
                        value={newBranch}
                        placeholder={t('git.newBranchPlaceholder')}
                        disabled={busy}
                        onChange={(event) => setNewBranch(event.target.value)}
                        onKeyDown={(event) => event.key === 'Enter' && onCreate()}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        isLoading={create.isPending}
                        disabled={busy || !newBranch.trim()}
                        onClick={onCreate}
                      >
                        {t('git.create')}
                      </Button>
                    </Stack>
                  </label>

                  <label className={styles.row}>
                    <Typography variant="body-sm" weight="medium" as="span">
                      {t('git.commit')}
                    </Typography>
                    <Stack direction="row" gap="var(--spacing-2xs)">
                      <input
                        className={styles.input}
                        value={message}
                        placeholder={t('git.commitPlaceholder')}
                        disabled={busy || info.dirtyCount === 0}
                        onChange={(event) => setMessage(event.target.value)}
                        onKeyDown={(event) => event.key === 'Enter' && onCommit()}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        isLoading={commit.isPending}
                        disabled={busy || info.dirtyCount === 0 || !message.trim()}
                        onClick={onCommit}
                      >
                        {t('git.commitAction')}
                      </Button>
                    </Stack>
                  </label>

                  <Typography variant="caption" color="subtle">
                    {t('git.note')}
                  </Typography>
                </>
              )}
            </Stack>
          </div>
        </>
      )}
    </div>
  );
}
