import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import type { AutoPickLineProps } from './AutoPickLine.types';
import styles from './AutoPickLine.module.scss';

/**
 * Вопрос агента, закрытый автономией чата. Карточка с кнопками здесь лгала бы:
 * ответ уже ушёл, агент по нему работает. Строка оставляет след — что спросили
 * и что выбрано за человека, — чтобы выбор можно было оспорить репликой.
 */
export function AutoPickLine({ picks }: AutoPickLineProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.line} data-auto-pick={picks.length}>
      {/* Выбор есть, а разобрать его не вышло (прогон не видел самого вызова) —
          вопрос всё равно закрыт, и строка честно говорит только это (F-132). */}
      {picks.length === 0 ? (
        <Typography variant="caption" color="subtle" as="span">
          {t('chat.autoPickUnparsed')}
        </Typography>
      ) : null}
      {picks.map((pick) => (
        <Typography
          key={`${pick.question}-${pick.label}`}
          variant="caption"
          color="subtle"
          as="span"
        >
          {t('chat.autoPick', { label: pick.label })}
          {pick.question ? ` — ${t('chat.autoPickQuestion', { question: pick.question })}` : ''}
        </Typography>
      ))}
    </div>
  );
}
