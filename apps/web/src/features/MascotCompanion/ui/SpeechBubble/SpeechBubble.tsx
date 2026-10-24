import { useTranslation } from 'react-i18next';
import { cn } from '@shared/lib/cn';
import { Mascot } from '@shared/ui/mascot';
import type { SpeechBubbleProps } from './SpeechBubble.types';
import styles from './SpeechBubble.module.scss';

/**
 * Реплика Деки. Два места:
 *  - облачко у края боковой панели с хвостиком к нему — живая область
 *    (`status`): вопрос агента и готовый ход слышны и с экранным диктором;
 *  - строка в потоке страницы (`inline`, чат — над полем ввода): с лицом Деки,
 *    ничего не накрывает; живая область — само место (`MascotSpeechSlot`).
 * Есть разговор — кнопка ведёт в него; × убирает реплику раньше срока.
 */
export function SpeechBubble({
  speech,
  style,
  inline = false,
  onOpen,
  onDismiss,
}: SpeechBubbleProps) {
  const { t } = useTranslation();
  const { target } = speech;

  return (
    <div
      key={speech.id}
      className={cn(styles.bubble, inline && styles.inline)}
      {...(style ? { style } : {})}
      {...(inline ? {} : { role: 'status', 'aria-live': 'polite' as const })}
      data-mascot-speech={speech.kind}
      {...(speech.reaction ? { 'data-mascot-reaction': speech.reaction } : {})}
    >
      {inline && (
        <span className={styles.face} aria-hidden="true">
          <Mascot mood={speech.mood ?? 'idle'} size={28} />
        </span>
      )}
      <p className={styles.text}>{speech.text}</p>
      <div className={styles.actions}>
        {target && (
          <button
            type="button"
            className={styles.open}
            onClick={() => onOpen(target)}
            data-mascot-speech-open
          >
            {t('mascot.panel.openChat')}
          </button>
        )}
        <button
          type="button"
          className={styles.dismiss}
          onClick={onDismiss}
          aria-label={t('common.close')}
          title={t('common.close')}
          data-mascot-speech-dismiss
        >
          ×
        </button>
      </div>
    </div>
  );
}
