import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import type { ChildTextQuestionProps } from './ChildTextQuestion.types';
import styles from './ChatMessages.module.scss';
import own from './ChildTextQuestion.module.scss';

/**
 * Вопрос ребёнка, заданный ТЕКСТОМ — без `AskUserQuestion` (журнал 97 g7, 124).
 *
 * Группа кончила ход вопросом словами («чинить или закрыть как не баг?»), и
 * панель отметила её «ждёт человека» — а сам вопрос остался в чате группы, куда
 * человек не заходил: владелец узнал о нём через два часа и от ревьюера.
 * Вариантов у такого вопроса нет, поэтому карточка — текст агента как есть и
 * поле ответа; ответ уходит в чат ребёнка обычным сообщением, как и выбор в
 * карточке с вариантами.
 */
export function ChildTextQuestion({
  text,
  target,
  onAnswer,
  busy,
  isAnswered,
}: ChildTextQuestionProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  // Отправлено — по клику, а не по ответу сервера: иначе секунды до старта хода
  // ребёнка читаются как «клик не прошёл», и уходит второй ответ.
  const [sent, setSent] = useState(false);
  const done = sent || isAnswered;

  const submit = (): void => {
    const answer = draft.trim();
    if (!answer) return;
    setSent(true);
    onAnswer(answer);
  };

  return (
    <div
      className={`${styles.question} ${done ? styles.questionSent : ''}`}
      data-child-text-question
    >
      <div className={styles.questionHead}>{t('chat.textQuestion.title')}</div>
      <Typography as="p" variant="body-sm" className={own.body}>
        {text}
      </Typography>
      {done ? (
        <Typography as="p" variant="body-sm" color="muted">
          {t(busy ? 'chat.questionQueuedToNote' : 'chat.questionSentToNote', { title: target })}
        </Typography>
      ) : (
        <div className={own.reply}>
          <textarea
            className={own.input}
            rows={3}
            value={draft}
            placeholder={t('chat.textQuestion.placeholder', { title: target })}
            aria-label={t('chat.textQuestion.label', { title: target })}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter отправляет, Shift+Enter переносит строку — как в поле чата.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <Button
            size="sm"
            variant="primary"
            className={own.send}
            disabled={draft.trim().length === 0}
            onClick={submit}
          >
            {t('chat.textQuestion.send')}
          </Button>
        </div>
      )}
    </div>
  );
}
