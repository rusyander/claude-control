import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import type { SplitTicketResolveActionsProps } from './SplitTicketResolve.types';
import styles from './SplitTicketResolve.module.scss';

/**
 * Низ окна «Разобрать…». До публикации — два основных действия: «Опубликовать
 * в Jira» (выключено с причиной, когда Jira нет) и «Решить здесь» (Jira не
 * нужна). После — «Повторить упавшие», если упали, и «Закрыть».
 */
export function SplitTicketResolveActions({
  publishBlocked,
  publishing,
  taking,
  canTake,
  offline,
  result,
  onPublish,
  onRetry,
  onTake,
  onConnect,
  onClose,
}: SplitTicketResolveActionsProps) {
  const { t } = useTranslation();
  const base = 'chat.cascade.hub.tickets.resolve';
  const busy = publishing || taking;

  if (result) {
    return (
      <div className={styles.footer}>
        {result.failed.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            isLoading={publishing}
            data-resolve-retry
            onClick={onRetry}
          >
            {t(`${base}.retry`)}
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={publishing} onClick={onClose}>
          {t(`${base}.close`)}
        </Button>
      </div>
    );
  }

  return (
    <div className={styles.footer}>
      {publishBlocked && (
        <Typography variant="caption" color="subtle" as="span" className={styles.blocked}>
          {publishBlocked}
        </Typography>
      )}
      <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
        {t('common.cancel')}
      </Button>
      {offline && (
        <Button size="sm" variant="ghost" data-resolve-connect onClick={onConnect}>
          {t(`${base}.connect`)}
        </Button>
      )}
      {canTake && (
        <Button
          size="sm"
          variant="secondary"
          title={t(`${base}.takeHint`)}
          isLoading={taking}
          disabled={publishing}
          data-resolve-take
          onClick={onTake}
        >
          {t(`${base}.take`)}
        </Button>
      )}
      <Button
        size="sm"
        variant="primary"
        title={publishBlocked ?? t(`${base}.publishHint`)}
        disabled={Boolean(publishBlocked) || taking}
        isLoading={publishing}
        data-resolve-publish
        onClick={onPublish}
      >
        {t(`${base}.publish`)}
      </Button>
    </div>
  );
}
