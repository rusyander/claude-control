import { useTranslation } from 'react-i18next';
import type { TelegramLastSend } from '@agentdeck/contracts';
import { Typography } from '@shared/ui/typography';

/**
 * «Последняя отправка: 19:52 — доставлено / ошибка: 403: …» под кнопкой проверки.
 * Без неё «уведомления не приходят» нечем объяснить: отправка идёт в фоне, и
 * отказ Telegram (бот выкинут из чата, чат не найден) иначе виден только в
 * журнале сервера.
 */
export function TelegramLastSendLine({ lastSend }: { lastSend: TelegramLastSend }) {
  const { t, i18n } = useTranslation();
  // Язык интерфейса, а не браузера (F-323).
  const time = new Date(lastSend.at).toLocaleString(i18n.language);
  return (
    <Typography
      variant="caption"
      color={lastSend.ok ? 'subtle' : 'danger'}
      as="span"
      data-telegram-last-send={lastSend.ok ? 'ok' : 'failed'}
    >
      {lastSend.ok
        ? t('telegramAnswers.lastSend.ok', { time })
        : t('telegramAnswers.lastSend.failed', { time, error: lastSend.error ?? '' })}
    </Typography>
  );
}
