import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import type { QuestionCardProps } from './QuestionCard.types';
import styles from './ChatMessages.module.scss';

/**
 * Вопрос с вариантами, заданный моделью.
 *
 * В ленте это самое важное сообщение: работа стоит, пока пользователь не
 * ответит. Свёрнутой строкой «AskUserQuestion» среди десятка других вызовов
 * инструментов его было не заметить — приходилось вычитывать весь ответ,
 * чтобы понять, что от тебя ждут выбора. Поэтому вопрос вынесен карточкой.
 *
 * Вариант кликабелен: клик отправляет его ответом в тот же разговор (продолжение
 * сессии), и выбрать можно прямо здесь, не уходя в терминал. Если колбэк не
 * передан (витрина, поток ещё идёт), варианты показываются просто списком.
 */
export function QuestionCard({ questions, onPick, disabled }: QuestionCardProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.question}>
      <Stack
        direction="row"
        align="center"
        gap="var(--spacing-2xs)"
        className={styles.questionHead}
      >
        <Icon name="help" size={20} />
        <Typography as="span" variant="body-sm" weight="semibold" color="accent">
          {t('chat.questionTitle')}
        </Typography>
      </Stack>

      {questions.map((item, index) => (
        <div key={index} className={styles.questionItem}>
          {item.header && <span className={styles.questionBadge}>{item.header}</span>}
          {item.question && (
            <Typography variant="body" weight="medium" className={styles.questionText}>
              {item.question}
            </Typography>
          )}

          {item.multiSelect && (
            <Typography variant="caption" color="muted" className={styles.questionHint}>
              {t('chat.questionMulti')}
            </Typography>
          )}

          <Stack as="ul" gap="var(--spacing-2xs)" className={styles.options}>
            {(item.options ?? []).map((option, optionIndex) => {
              const content = (
                <>
                  <Typography
                    as="span"
                    variant="body-sm"
                    weight="semibold"
                    className={styles.optionLabel}
                  >
                    {option.label}
                  </Typography>
                  {option.description && (
                    <span className={styles.optionText}>{option.description}</span>
                  )}
                </>
              );

              return (
                <li key={optionIndex}>
                  {onPick && option.label ? (
                    <button
                      type="button"
                      className={`${styles.option} ${styles.optionClickable}`}
                      onClick={() => onPick(option.label as string)}
                      disabled={disabled}
                      title={t('chat.pickOption')}
                    >
                      {content}
                    </button>
                  ) : (
                    <div className={styles.option}>{content}</div>
                  )}
                </li>
              );
            })}
          </Stack>
        </div>
      ))}
    </div>
  );
}
