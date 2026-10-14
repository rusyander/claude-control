import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import type { ServerNotesProps } from './ServerNotes.types';

/**
 * Что сервер моделей сообщает о себе по ходу ночного прогона (L4b): упал и поднят
 * присмотром, подъём не удался, потолок подъёмов исчерпан (дальше панель не пытается —
 * нужен человек); и что сохранённая настройка ждёт конца прогона.
 */
const NOTICE_KEY = {
  restarted: 'localModels.serverNotice.restarted',
  failed: 'localModels.serverNotice.failed',
  'gave-up': 'localModels.serverNotice.gaveUp',
} as const;

export function ServerNotes({ server }: ServerNotesProps) {
  const { t, i18n } = useTranslation();
  const { notice } = server;
  const time = notice
    ? new Date(notice.at).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
    : '';
  const reason = notice?.reason ? `: ${notice.reason}` : '';
  const next = notice?.nextTryAt
    ? new Date(notice.nextTryAt).toLocaleTimeString(i18n.language, {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

  return (
    <>
      {notice ? (
        <Typography
          variant="caption"
          color={notice.kind === 'restarted' ? 'muted' : 'warning'}
          role="status"
          aria-live="polite"
        >
          {t(NOTICE_KEY[notice.kind], { time, count: notice.restarts, reason, next })}
        </Typography>
      ) : null}
      {server.restartPending ? (
        <Typography variant="caption" color="muted" role="status" aria-live="polite">
          {t('localModels.pending.note')}
        </Typography>
      ) : null}
      {server.restartError ? (
        <Typography variant="caption" color="warning" role="status" aria-live="polite">
          {t('localModels.pending.failed', { reason: server.restartError })}
        </Typography>
      ) : null}
    </>
  );
}
