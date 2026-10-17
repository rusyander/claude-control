import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAskSplitStatus } from '@entities/ChatTree';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import type { StatusAskProps } from './StatusAsk.types';
import styles from './StatusAsk.module.scss';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';

/**
 * «Спросить о ходе групп» в хабе родителя (5.1 плана экономии).
 *
 * Родитель разделения — разговор на 170–230 тыс. контекста: после часа тишины
 * один вопрос «как там группы?» стоил ему перезаписи остывшего кеша. Отсюда
 * вопрос уходит в новый лёгкий чат со сводкой групп, и вид переходит в него.
 * Написать самому родителю — по-прежнему его полем ввода: это явный выбор.
 *
 * Отказ сервера оставляет вопрос в поле — набирать заново не придётся.
 */
export function StatusAsk({ parentChatId, onOpen }: StatusAskProps) {
  const { t } = useTranslation();
  const ask = useAskSplitStatus();
  const [question, setQuestion] = useState('');
  const trimmed = question.trim();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!trimmed || ask.isPending) return;
    ask.mutate(
      { parentChatId, question: trimmed },
      {
        onSuccess: ({ chatId }) => {
          setQuestion('');
          onOpen(chatId);
        },
        onError: (error) =>
          toast.error(t('chat.cascade.hub.statusAsk.failed', { message: toErrorMessage(error) })),
      },
    );
  };

  return (
    <form className={styles.form} onSubmit={submit} data-status-ask>
      <div className={styles.field}>
        <TextField
          label={t('chat.cascade.hub.statusAsk.label')}
          value={question}
          onChange={setQuestion}
          placeholder={t('chat.cascade.hub.statusAsk.placeholder')}
          hint={t('chat.cascade.hub.statusAsk.hint')}
          disabled={ask.isPending}
        />
      </div>
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        isLoading={ask.isPending}
        disabled={!trimmed}
        aria-busy={ask.isPending}
      >
        {t('chat.cascade.hub.statusAsk.send')}
      </Button>
    </form>
  );
}
