import { useTranslation } from 'react-i18next';
import { Icon } from '@shared/ui/icon';
import styles from './ChatMessages.module.scss';

/**
 * Вопрос с вариантами, заданный моделью.
 *
 * В ленте это самое важное сообщение: работа стоит, пока пользователь не
 * ответит. Свёрнутой строкой «AskUserQuestion» среди десятка других вызовов
 * инструментов его было не заметить — приходилось вычитывать весь ответ,
 * чтобы понять, что от тебя ждут выбора. Поэтому вопрос вынесен карточкой.
 */

interface Option {
  label?: string;
  description?: string;
}

interface Question {
  question?: string;
  header?: string;
  multiSelect?: boolean;
  options?: Option[];
}

/** Разбор input вызова: пришёл он строкой JSON, и формат нам не подконтролен. */
export function parseQuestions(input: string): Question[] | undefined {
  try {
    const parsed: unknown = JSON.parse(input);
    const questions = (parsed as { questions?: unknown }).questions;
    if (!Array.isArray(questions) || questions.length === 0) return undefined;
    return questions as Question[];
  } catch {
    return undefined;
  }
}

export function QuestionCard({ questions }: { questions: Question[] }) {
  const { t } = useTranslation();

  return (
    <div className={styles.question}>
      <div className={styles.questionHead}>
        <Icon name="help" size={20} />
        <span>{t('chat.questionTitle')}</span>
      </div>

      {questions.map((item, index) => (
        <div key={index} className={styles.questionItem}>
          {item.header && <span className={styles.questionBadge}>{item.header}</span>}
          {item.question && <p className={styles.questionText}>{item.question}</p>}

          {item.multiSelect && (
            <span className={styles.questionHint}>{t('chat.questionMulti')}</span>
          )}

          <ul className={styles.options}>
            {(item.options ?? []).map((option, optionIndex) => (
              <li key={optionIndex} className={styles.option}>
                <span className={styles.optionLabel}>{option.label}</span>
                {option.description && (
                  <span className={styles.optionText}>{option.description}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
