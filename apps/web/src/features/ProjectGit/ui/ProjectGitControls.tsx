import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { toast } from '@shared/lib/toast';
import {
  useProjectGit,
  useCheckoutBranch,
  useCreateBranch,
  useCommitAll,
  usePullChanges,
  usePushBranch,
} from '@entities/ProjectGit';
import { STATUS_LETTER, pullBody, splitPath } from '../model/projectGitView';
import { WorktreeSection } from './WorktreeSection';
import type { ProjectGitControlsProps } from './ProjectGitControls.types';
import styles from './ProjectGitControls.module.scss';

/**
 * Git проекта в ряду вкладки: кнопка с текущей веткой, а под ней — всё
 * остальное. Раздел появляется ТОЛЬКО когда в каталоге проекта есть `.git`:
 * иначе кнопки нет вовсе, а не «пустой git».
 *
 * Ряд вкладки и так плотный, поэтому в нём живёт одна кнопка «⑂ ветка · N», а
 * ВСЁ остальное — список изменённых файлов, переключение веток, pull, новая
 * ветка и коммит — открывается поповером, как у пульта агентов рядом. Так пять
 * операций доступны в один клик и ничего не занимает место, пока не понадобилось.
 *
 * На самой кнопке живут только два числа, ради которых её и разглядывают:
 * сколько файлов изменено и на сколько коммитов мы отстали от удалённого.
 * По первому включается коммит, по второму видно, что есть смысл нажать pull.
 */

export function ProjectGitControls({ path }: ProjectGitControlsProps) {
  const { t } = useTranslation();
  const [isOpen, setOpen] = useState(false);
  const [newBranch, setNewBranch] = useState('');
  const [message, setMessage] = useState('');
  // Пусто — «текущая ветка», то есть обычный git pull по её upstream.
  const [pullFrom, setPullFrom] = useState('');

  const git = useProjectGit(path);
  const checkout = useCheckoutBranch();
  const create = useCreateBranch();
  const commit = useCommitAll();
  const pull = usePullChanges();
  const push = usePushBranch();

  const info = git.data;
  // Нет репозитория — раздела нет. Пока состояние не пришло, кнопку тоже не
  // показываем: мигать ею у проекта без git было бы неправдой.
  if (!info?.isRepo) return null;

  const busy =
    checkout.isPending || create.isPending || commit.isPending || pull.isPending || push.isPending;
  const branchLabel = info.branch ?? (info.detached ? t('git.detached') : t('git.noBranch'));
  const behind = info.behind ?? 0;

  /**
   * Успех — тост с выводом git. Ошибку здесь не показываем: её уже показывает
   * общий MutationCache (`app/queryClient.ts`), и второй тост с тем же текстом
   * выглядел как две ошибки.
   */
  const done = (result: { output: string }): void => {
    toast.success(result.output);
  };

  const onCheckout = (branch: string): void => {
    if (!branch || branch === info.branch) return;
    checkout.mutate({ path, branch }, { onSuccess: done });
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
      },
    );
  };

  const onPull = (): void => {
    pull.mutate(pullBody(path, pullFrom), { onSuccess: done });
  };

  const onPush = (): void => {
    push.mutate({ path }, { onSuccess: done });
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
        {/* Отставание от удалённого — единственный повод открыть пульт, не
            имея своих правок, поэтому оно видно снаружи. */}
        {behind > 0 && <Badge tone="info">↓{behind}</Badge>}
        {/* Шеврон: без него кнопка читается как надпись «текущая ветка», и то,
            что за ней спрятан весь git, не находят вовсе. */}
        <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size={14} className={styles.chevron} />
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
                    {info.behind ? ` · ${t('git.behind', { count: info.behind })}` : ''}
                    {info.ahead ? ` · ${t('git.ahead', { count: info.ahead })}` : ''}
                  </Typography>

                  {/* Сами файлы, а не только их число: «изменено 12» ничего не
                      говорит о том, что именно уйдёт в коммит. Список свой
                      скроллится, чтобы поповер не рос на весь экран. */}
                  {info.changedFiles.length > 0 && (
                    <div className={styles.files} aria-label={t('git.files')}>
                      {info.changedFiles.map((file) => {
                        const { dir, name } = splitPath(file.path);
                        return (
                          <div
                            key={`${file.status}:${file.path}`}
                            className={styles.file}
                            title={file.from ? `${file.from} → ${file.path}` : file.path}
                          >
                            <span
                              className={`${styles.status} ${styles[file.status] ?? ''}`}
                              aria-label={t(`git.status.${file.status}`)}
                            >
                              {STATUS_LETTER[file.status]}
                            </span>
                            <span className={styles.dir}>{dir}</span>
                            <span className={styles.name}>{name}</span>
                            {file.staged && (
                              <span className={styles.staged}>{t('git.staged')}</span>
                            )}
                          </div>
                        );
                      })}
                      {info.changedFilesTruncated && (
                        <Typography variant="caption" color="subtle">
                          {t('git.filesTruncated', { count: info.changedFiles.length })}
                        </Typography>
                      )}
                    </div>
                  )}

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

                  {/* Pull стоит сразу под веткой: он про неё же. Селект слева
                      выбирает ИСТОЧНИК — по умолчанию upstream текущей ветки
                      (обычный `git pull`), иначе конкретная ветка удалённого.
                      Список закрытый: в git уходит только то, что git и назвал. */}
                  <label className={styles.row}>
                    <Typography variant="body-sm" weight="medium" as="span">
                      {t('git.pull')}
                    </Typography>
                    <Stack direction="row" gap="var(--spacing-2xs)">
                      <select
                        className={styles.select}
                        value={pullFrom}
                        disabled={busy}
                        onChange={(event) => setPullFrom(event.target.value)}
                      >
                        <option value="">{t('git.pullCurrent')}</option>
                        {info.remoteBranches.map((branch) => (
                          <option key={branch} value={branch}>
                            {info.remote}/{branch}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="secondary"
                        size="sm"
                        isLoading={pull.isPending}
                        disabled={busy}
                        onClick={onPull}
                      >
                        {t('git.pullAction')}
                      </Button>
                    </Stack>
                  </label>

                  {/* Push стоит следом за pull: это та же ось «мы и удалённый»,
                      и после коммита взгляд идёт сюда. Отправляется ТОЛЬКО
                      текущая ветка; выбирать нечего, поэтому и селекта нет.
                      Кнопка выключена там, где push невозможен по существу:
                      нет удалённого, нет коммитов, HEAD отцеплен от ветки. */}
                  {/* Не <label>: в этой строке нет поля ввода, и label назначал бы
                      кнопке имя из всей строки («Отправить ветку нечего отправлять Push»). */}
                  <div className={styles.row}>
                    <Typography variant="body-sm" weight="medium" as="span">
                      {t('git.push')}
                    </Typography>
                    <Stack direction="row" gap="var(--spacing-2xs)">
                      <Typography variant="caption" color="subtle">
                        {info.ahead ? t('git.ahead', { count: info.ahead }) : t('git.pushNothing')}
                      </Typography>
                      <Button
                        variant="secondary"
                        size="sm"
                        isLoading={push.isPending}
                        disabled={busy || !info.remote || info.unborn || info.detached}
                        onClick={onPush}
                      >
                        {t('git.pushAction')}
                      </Button>
                    </Stack>
                  </div>

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

                  {/* Параллельные ветки — последним разделом: это про другие
                      копии репозитория, а не про текущую, и открывают его
                      реже, чем коммит. */}
                  <WorktreeSection path={path} busy={busy} />

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
