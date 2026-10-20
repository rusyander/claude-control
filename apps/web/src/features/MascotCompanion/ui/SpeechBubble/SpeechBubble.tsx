import { useTranslation } from 'react-i18next';
import type { SpeechBubbleProps } from './SpeechBubble.types';
import styles from './SpeechBubble.module.scss';

/**
 * Реплика Деки — облачко у края боковой панели с хвостиком к нему. Живая
 * область (`status`): вопрос агента и готовый ход слышны и с экранным диктором.
 * Есть разговор — кнопка ведёт в него; × убирает облачко раньше срока.
 */
export function SpeechBubble({ speech, style, onOpen, onDismiss }: SpeechBubbleProps) {
  const { t } = useTranslation();
  const { target } = speech;

  return (
    <div
      key={speech.id}
      className={styles.bubble}
      style={style}
      role="status"
      data-mascot-speech={speech.kind}
    >
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
        >
          ×
        </button>
      </div>
    </div>
  );
}
