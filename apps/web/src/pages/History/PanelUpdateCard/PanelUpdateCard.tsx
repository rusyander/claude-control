import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PanelUpdateResult, PanelUpdateStatus } from '@agentdeck/contracts/changelog';
import { useApplyPanelUpdate, useCheckPanelUpdate, usePanelUpdate } from '@entities/Changelog';
import { formatClock } from '@shared/lib/format-clock';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { StatusDot } from '@shared/ui/status-dot';
import { Typography } from '@shared/ui/typography';
import { pickText } from '../model/pickText';
import styles from './PanelUpdateCard.module.scss';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/** Сколько тем входящих коммитов показать, когда описаний к ним нет. */
const COMMITS_SHOWN = 5;

/**
 * Обновление самой панели вверху «Что нового». Вышли новые коммиты — карточка с
 * тем, что придёт (описания, а без них темы коммитов), и кнопкой «Обновить»;
 * свои правки в репозитории — кнопки нет, файлы названы; ветка разошлась —
 * объяснение без кнопки. Новых нет — одна тихая строка «последняя версия» с
 * «Проверить сейчас». Итог обновления остаётся на карточке: после перемотки
 * состояние уже «последняя», и без него человек не узнал бы, что произошло.
 */
export function PanelUpdateCard() {
  const { t, i18n } = useTranslation();
  const { data: status } = usePanelUpdate();
  const check = useCheckPanelUpdate();
  const apply = useApplyPanelUpdate();
  const [isConfirming, setIsConfirming] = useState(false);
  const [outcome, setOutcome] = useState<PanelUpdateResult>();

  if (!status || status.state === 'not-git') return null;

  const confirm = (): void => {
    apply.mutate(undefined, {
      onSuccess: (result) => {
        setIsConfirming(false);
        setOutcome(result);
        if (result.ok) toast.success(t('panelUpdate.done', { hash: result.to?.slice(0, 8) }));
        else
          toast.error(
            t(`panelUpdate.failed.${result.error ?? 'pull-failed'}`, { message: result.detail }),
          );
      },
      onError: (error) => {
        setIsConfirming(false);
        toast.error(t('panelUpdate.requestFailed', { message: toErrorMessage(error) }));
      },
    });
  };

  const checkRow = (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => check.mutate()}
      isLoading={check.isPending}
      data-panel-update-check
    >
      {check.isPending ? t('panelUpdate.checking') : t('panelUpdate.checkNow')}
    </Button>
  );

  const done = outcome?.ok ? <UpdateOutcome result={outcome} /> : null;

  if (status.state !== 'behind' && status.state !== 'diverged') {
    return (
      <div className={styles.quiet} data-panel-update={status.state}>
        {done}
        <div className={styles.quietRow}>
          <Typography variant="caption" color="subtle">
            {status.state === 'no-upstream'
              ? t('panelUpdate.noUpstream', { branch: status.branch ?? 'HEAD' })
              : [
                  t('panelUpdate.current'),
                  status.fetchedAt
                    ? t('panelUpdate.checkedAt', {
                        time: formatClock(status.fetchedAt, i18n.language),
                      })
                    : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </Typography>
          {status.state === 'current' && checkRow}
        </div>
        <FetchError status={status} />
      </div>
    );
  }

  const upstream = status.upstream ?? 'origin';

  if (status.state === 'diverged') {
    return (
      <div className={styles.root} data-panel-update="diverged" role="status">
        <Typography variant="body" weight="semibold">
          {t('panelUpdate.divergedTitle', { upstream })}
        </Typography>
        <Typography variant="body-sm" color="muted">
          {t('panelUpdate.divergedText', {
            upstream,
            ahead: status.ahead,
            behind: status.behind,
          })}
        </Typography>
        <FetchError status={status} />
      </div>
    );
  }

  const isDirty = status.dirty.length > 0;

  return (
    <div className={styles.root} data-panel-update="behind" role="status">
      <div className={styles.head}>
        <StatusDot tone="success" />
        <div className={styles.headText}>
          <Typography variant="body" weight="semibold">
            {t('panelUpdate.title')}
          </Typography>
          <Typography variant="caption" color="subtle">
            {t('panelUpdate.behind', { count: status.behind, upstream })}
          </Typography>
        </div>
        <div className={styles.actions}>
          {checkRow}
          <Button
            size="sm"
            variant="primary"
            disabled={isDirty}
            onClick={() => setIsConfirming(true)}
            data-panel-update-apply
          >
            {t('panelUpdate.update')}
          </Button>
        </div>
      </div>

      <Incoming status={status} />

      {status.lockChanged && (
        <Typography variant="caption" color="subtle">
          {t('panelUpdate.lockChanged')}
        </Typography>
      )}

      {isDirty && (
        <div className={styles.dirty} data-panel-update-dirty>
          <Typography variant="body-sm" weight="semibold">
            {t('panelUpdate.dirtyTitle')}
          </Typography>
          <Typography variant="caption" color="muted">
            {t('panelUpdate.dirtyText')}
          </Typography>
          <ul className={styles.files}>
            {status.dirty.map((file) => (
              <li key={file}>
                <Typography variant="mono">{file}</Typography>
              </li>
            ))}
          </ul>
        </div>
      )}

      {outcome && !outcome.ok && outcome.detail && (
        <Typography variant="mono" color="danger" className={styles.detail}>
          {outcome.detail}
        </Typography>
      )}

      <FetchError status={status} />

      <ConfirmDialog
        isOpen={isConfirming}
        onOpenChange={setIsConfirming}
        onConfirm={confirm}
        title={t('panelUpdate.confirmTitle')}
        description={t('panelUpdate.confirmText', { upstream })}
        confirmLabel={t('panelUpdate.confirm')}
        isPending={apply.isPending}
      />
    </div>
  );
}

/** Что придёт: описания «Что нового», а без них — темы коммитов. */
function Incoming({ status }: { status: PanelUpdateStatus }) {
  const { t, i18n } = useTranslation();
  const lines =
    status.entries.length > 0
      ? status.entries.map((entry) => ({
          key: entry.id,
          text: pickText(entry.title, i18n.language),
        }))
      : status.incoming
          .slice(0, COMMITS_SHOWN)
          .map((commit) => ({ key: commit.hash, text: commit.subject }));
  const rest = status.entries.length > 0 ? 0 : status.behind - lines.length;
  if (lines.length === 0) return null;
  return (
    <div className={styles.incoming}>
      <Typography variant="caption" color="subtle">
        {t('panelUpdate.incomingLabel')}
      </Typography>
      <ul className={styles.list}>
        {lines.map((line) => (
          <li key={line.key}>
            <Typography variant="body-sm">{line.text}</Typography>
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <Typography variant="caption" color="subtle">
          {t('panelUpdate.moreCommits', { count: rest })}
        </Typography>
      )}
    </div>
  );
}

function FetchError({ status }: { status: PanelUpdateStatus }) {
  const { t } = useTranslation();
  if (!status.fetchError) return null;
  return (
    <Typography variant="caption" color="warning" data-panel-update-fetch-error>
      {t('panelUpdate.fetchError', { message: status.fetchError })}
    </Typography>
  );
}

/** Итог удачного обновления: до какого коммита, что с зависимостями и сервером. */
function UpdateOutcome({ result }: { result: PanelUpdateResult }) {
  const { t } = useTranslation();
  return (
    <div className={styles.done} data-panel-update-done>
      <Typography variant="body-sm" weight="semibold">
        {t('panelUpdate.done', { hash: result.to?.slice(0, 8) })}
      </Typography>
      <Typography variant="caption" color="muted">
        {result.watched ? t('panelUpdate.doneWatched') : t('panelUpdate.doneManual')}
      </Typography>
      {result.installed && (
        <Typography variant="caption" color="muted">
          {t('panelUpdate.installed')}
        </Typography>
      )}
      {result.installError && (
        <Typography variant="caption" color="danger">
          {t('panelUpdate.installFailed', { message: result.installError })}
        </Typography>
      )}
    </div>
  );
}
