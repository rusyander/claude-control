import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import styles from './HoldAnswer.module.scss';
import { TextField } from '@shared/ui/text-field';
import { Button } from '@shared/ui/button';

/**
 * Ответ на вопрос разбора. Форма живёт в карточке группы: вопрос про ЭТУ
 * группу, и ответ уедет в её план и задание. Отправляется кнопкой, не Enter:
 * ответ бывает в несколько строк.
 */
export function HoldAnswer({
  question,
  busy,
  onSend,
}: {
  question: string;
  busy?: boolean;
  onSend: (answer: string) => void;
}) {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState('');
  const trimmed = answer.trim();

  return (
    <div className={styles.hold} data-hold-form>
      <TextField
        label={question}
        value={answer}
        onChange={setAnswer}
        placeholder={t('chat.cascade.hub.holdPlaceholder')}
        multiline
        rows={2}
        disabled={busy}
      />
      <div className={styles.holdActions}>
        <Button
          size="sm"
          variant="primary"
          isLoading={busy}
          disabled={!trimmed}
          onClick={() => onSend(trimmed)}
        >
          {t('chat.cascade.hub.holdSend')}
        </Button>
      </div>
    </div>
  );
}
