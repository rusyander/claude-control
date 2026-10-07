import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { toast } from '@shared/lib/toast';
import { serverMessageText } from '@shared/config/i18n/server-message';
import { CliInfoPanel } from '@entities/ChatCli';
import type { FeedErrorCardProps } from './FeedErrorCard.types';
import styles from './ChatMessages.module.scss';

/**
 * Ошибка — такое же событие разговора, как ответ, и место ей в ленте.
 * Раньше здесь была голая красная строка внизу: на длинной переписке её
 * не отличить от обрыва, а что делать дальше — не сказано. Карточка
 * называет беду, показывает текст целиком (он бывает многострочным) и
 * даёт то самое действие, которого человек ищет, — повторить.
 *
 * Отдельным файлом — потому что `ChatMessages.tsx` перерос предел длины, а
 * карточка ни от чего, кроме потока и своих действий, не зависит.
 */
export function FeedErrorCard({
  stream,
  onRetry,
  onContinue,
  onDismissError,
  onCompact,
  onFreshSession,
}: FeedErrorCardProps) {
  const { t } = useTranslation();
  if (!stream.error) return null;
  const explained = stream.errorCode
    ? serverMessageText(stream.errorCode, stream.errorParams)
    : undefined;
  return (
    <div className={styles.row}>
      <div className={styles.errorCard} role="alert" data-chat-error>
        <Stack direction="row" align="center" gap="var(--spacing-2xs)">
          <Icon name="error" size={20} />
          <Typography variant="body-sm" weight="medium" as="span">
            {t('chat.errorTitle')}
          </Typography>
        </Stack>
        {/*
          Известная ошибка CLI (живой прогон 25.09): сначала — что случилось
          и что делать, словами интерфейса; сырой текст остаётся ниже, его
          несут в тикет. Устаревший CLI — путь и версия той копии, что
          запускается, и кнопка обновления именно её.
        */}
        {explained && (
          <Typography variant="body-sm" as="div" data-chat-error-explained>
            {explained}
          </Typography>
        )}
        {stream.errorCode === 'cli-outdated' && (
          <CliInfoPanel refresh withUpdate providerId="claude" />
        )}
        {/* Текст самой панели (потерянный процесс чата) по-русски совпадает с
            объяснением — второй раз ту же фразу не показываем. */}
        {stream.error !== explained && <div className={styles.errorText}>{stream.error}</div>}
        {/*
          Три действия вместо одного. «Повторить» отправляет задачу заново —
          но часть работы уже сделана, и переделывать её незачем: «Продолжить»
          просит агента доделать с места обрыва. Текст ошибки нужен целиком —
          его несут в тикет или в поиск, а выделять мышью из ленты неудобно.
          Раньше эти две кнопки жили только в шапке, где их не связать с
          карточкой, из-за которой их ищут.
        */}
        <Stack direction="row" gap="var(--spacing-2xs)" wrap>
          {onRetry && !stream.errorOverflow && (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Icon name="refresh" size={18} />}
              onClick={onRetry}
            >
              {t('chat.retry')}
            </Button>
          )}
          {onContinue && !stream.errorOverflow && (
            <Button size="sm" variant="secondary" onClick={onContinue}>
              {t('chat.continue')}
            </Button>
          )}
          {/* Переполненный разговор не примет ни «Повторить», ни «Продолжить»:
              выход — сжать контекст или уйти в свежую сессию. */}
          {stream.errorOverflow && onCompact && (
            <Button size="sm" variant="secondary" onClick={onCompact} data-chat-compact>
              {t('chat.overflow.compact')}
            </Button>
          )}
          {stream.errorOverflow && onFreshSession && (
            <Button
              size="sm"
              variant="secondary"
              onClick={onFreshSession}
              title={t('chat.overflow.freshHint')}
              data-chat-fresh-session
            >
              {t('chat.overflow.fresh')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<Icon name="copy" size={18} />}
            onClick={() =>
              void navigator.clipboard.writeText(stream.error ?? '').then(() => {
                toast.success(t('toasts.copied'));
              })
            }
          >
            {t('chat.copyError')}
          </Button>
          {onDismissError && (
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<Icon name="close" size={18} />}
              onClick={onDismissError}
            >
              {t('chat.dismissError')}
            </Button>
          )}
        </Stack>
      </div>
    </div>
  );
}
