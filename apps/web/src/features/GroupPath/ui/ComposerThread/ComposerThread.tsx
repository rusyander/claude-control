import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { SentImageNames } from '@shared/ui/image-attach';
import type { ComposerThreadProps } from './ComposerThread.types';
import styles from './ComposerThread.module.scss';
import { AssistantTurn } from './AssistantTurn/AssistantTurn';

/**
 * Лента разговора с ассистентом шага. От ассистента показываем не текст, а то,
 * что человеку надо решить: вопросы, «уже есть ресурс, который делает ровно
 * это», похожие ресурсы. Сам итоговый шаг — ниже, в редакторе.
 */
export function ComposerThread({ turns, isThinking }: ComposerThreadProps) {
  const { t } = useTranslation();
  const boxRef = useRef<HTMLDivElement>(null);
  // Лента ограничена по высоте: новый ход должен быть виден, а не прятаться
  // под краем прокрутки — иначе ответ ассистента выглядит пустым пузырём.
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [turns.length, isThinking]);
  if (turns.length === 0 && !isThinking) return null;

  return (
    <div
      ref={boxRef}
      className={styles.thread}
      role="log"
      aria-live="polite"
      aria-label={t('groupPath.composer.threadLabel')}
      // Прокручиваемая область должна быть досягаема с клавиатуры.
      tabIndex={0}
    >
      <Stack gap="var(--spacing-xs)">
        {turns.map((turn) =>
          turn.role === 'user' ? (
            <div key={turn.id} className={`${styles.turn} ${styles.user}`}>
              <Typography variant="caption" color="subtle">
                {t('groupPath.composer.you')}
              </Typography>
              <Typography variant="body-sm" className={styles.text}>
                {turn.text ?? ''}
              </Typography>
              {turn.images && <SentImageNames names={turn.images} />}
            </div>
          ) : (
            <div key={turn.id} className={`${styles.turn} ${styles.assistant}`}>
              <Typography variant="caption" color="subtle">
                {t('groupPath.composer.assistant')}
              </Typography>
              {turn.proposal && <AssistantTurn proposal={turn.proposal} />}
            </div>
          ),
        )}
        {isThinking && (
          <Typography variant="body-sm" color="subtle" aria-busy="true">
            {t('groupPath.composer.thinking')}
          </Typography>
        )}
      </Stack>
    </div>
  );
}
