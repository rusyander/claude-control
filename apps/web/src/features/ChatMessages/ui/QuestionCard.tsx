import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { Button } from '@shared/ui/button';
import { composeAnswer, nextQuestion } from '../lib/composeAnswer';
import type { PickedAnswers, QuestionCardProps, QuestionState } from './QuestionCard.types';
import styles from './ChatMessages.module.scss';

/**
 * Вопрос с вариантами, заданный моделью.
 *
 * В ленте это самое важное сообщение: работа стоит, пока пользователь не
 * ответит. Свёрнутой строкой «AskUserQuestion» среди десятка других вызовов
 * инструментов его было не заметить — поэтому вопрос вынесен карточкой.
 *
 * Вопросов в одном вызове бывает до четырёх, и раньше они показывались все
 * сразу, каждый со своими кнопками. Так нельзя: клик по варианту отправлял
 * ответ немедленно, то есть первый же щелчок закрывал карточку, а два
 * оставшихся вопроса уходили в никуда — и при этом ничто не мешало ткнуть
 * сначала в третий. Теперь карточка ведёт по одному: активен ровно один вопрос,
 * отвеченные свёрнуты и их можно переспросить, следующие показаны, но погашены.
 * Отправка одна на всю карточку — одно сообщение, один ход агента.
 *
 * Ответ фиксируется МГНОВЕННО, не дожидаясь сервера: агент отвечает десятками
 * секунд, и всё это время карточка обязана выглядеть отправленной, иначе
 * человек честно решит, что клик не прошёл, и нажмёт ещё раз.
 */
export function QuestionCard({ questions, onPick, disabled }: QuestionCardProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<PickedAnswers>({});
  // Подтверждённые множественные выборы: галочка ставится не одним щелчком, и
  // закрыть такой вопрос может только «Дальше».
  const [confirmed, setConfirmed] = useState<Record<number, boolean>>({});
  // Вопрос, к которому вернулись кнопкой «Изменить»: он снова активен, хотя
  // ответ у него уже есть.
  const [editing, setEditing] = useState<number | undefined>(undefined);
  const [isSent, setSent] = useState(false);
  // Тот же признак, но доступный СРАЗУ. Двойной щелчок по варианту успевает
  // между событием и перерисовкой, и состояние во втором обработчике было бы
  // ещё прежним — а ответ ушёл бы дважды, то есть двумя ходами агента.
  const wasSent = useRef(false);

  const pending = nextQuestion(questions, picked, confirmed);
  const current = editing ?? pending;
  const isReadOnly = !onPick;
  const isLocked = isSent || Boolean(disabled) || isReadOnly;

  const send = (answers: PickedAnswers): void => {
    const text = composeAnswer(questions, answers);
    if (!onPick || !text || wasSent.current) return;
    // Порядок важен: сначала гасим карточку, потом отправляем. Отправка уходит
    // в стор синхронно, и второй клик по соседнему варианту не должен успеть.
    wasSent.current = true;
    setSent(true);
    setEditing(undefined);
    onPick(text);
  };

  const choose = (index: number, label: string): void => {
    if (isLocked || wasSent.current) return;
    const question = questions[index];
    const chosen = picked[index] ?? [];

    if (question?.multiSelect) {
      const next = chosen.includes(label)
        ? chosen.filter((item) => item !== label)
        : [...chosen, label];
      setPicked({ ...picked, [index]: next });
      return;
    }

    const answers = { ...picked, [index]: [label] };
    setPicked(answers);
    setEditing(undefined);
    // Один вопрос с одиночным выбором — щелчок и есть ответ: подтверждать
    // нечего, а лишний шаг здесь только замедляет.
    if (questions.length === 1) send(answers);
  };

  const isComplete = pending === undefined;

  return (
    <div className={`${styles.question} ${isSent ? styles.questionSent : ''}`}>
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
        {questions.length > 1 && !isSent && (
          <span className={styles.questionStep}>
            {t('chat.questionStep', {
              current: Math.min((current ?? questions.length - 1) + 1, questions.length),
              total: questions.length,
            })}
          </span>
        )}
      </Stack>

      {questions.map((item, index) => {
        const chosen = picked[index] ?? [];
        const state: QuestionState = stateOf(index, current, chosen.length > 0);
        // Только для чтения — старый вопрос из ленты: показываем как есть,
        // без шагов и без блокировок, отвечать на него уже некуда.
        const shown = isReadOnly ? 'current' : state;

        if (shown === 'done' && !isSent) {
          return (
            <div key={index} className={`${styles.questionItem} ${styles.questionDone}`}>
              <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
                <Icon name="check" size={16} className={styles.questionDoneIcon} />
                <Typography as="span" variant="body-sm" color="muted">
                  {item.header || item.question}
                </Typography>
                <Typography as="span" variant="body-sm" weight="semibold">
                  {chosen.join(', ')}
                </Typography>
                {!isLocked && (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(index)}>
                    {t('chat.questionChange')}
                  </Button>
                )}
              </Stack>
            </div>
          );
        }

        return (
          <div
            key={index}
            className={[
              styles.questionItem,
              shown === 'locked' && styles.questionLocked,
              shown === 'done' && styles.questionDoneOpen,
            ]
              .filter(Boolean)
              .join(' ')}
            aria-disabled={shown === 'locked' || undefined}
          >
            {item.header && <span className={styles.questionBadge}>{item.header}</span>}
            {item.question && (
              <Typography variant="body" weight="medium" className={styles.questionText}>
                {item.question}
              </Typography>
            )}

            {item.multiSelect && shown === 'current' && (
              <Typography variant="caption" color="muted" className={styles.questionHint}>
                {t('chat.questionMulti')}
              </Typography>
            )}
            {shown === 'locked' && (
              <Typography variant="caption" color="muted" className={styles.questionHint}>
                {t('chat.questionWait')}
              </Typography>
            )}

            <Stack as="ul" gap="var(--spacing-2xs)" className={styles.options}>
              {(item.options ?? []).map((option, optionIndex) => {
                const isChosen = Boolean(option.label && chosen.includes(option.label));
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

                // Кликабельно ровно то, что сейчас спрашивают: у прошлого хода,
                // у погашенного вопроса и у уже отправленной карточки вариант —
                // просто текст, а не кнопка, которая молча ничего не делает.
                if (isReadOnly || shown !== 'current') {
                  return (
                    <li key={optionIndex}>
                      <div className={`${styles.option} ${isChosen ? styles.optionChosen : ''}`}>
                        {content}
                      </div>
                    </li>
                  );
                }

                return (
                  <li key={optionIndex}>
                    <button
                      type="button"
                      className={[
                        styles.option,
                        styles.optionClickable,
                        isChosen && styles.optionChosen,
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => option.label && choose(index, option.label)}
                      disabled={isLocked}
                      aria-pressed={item.multiSelect ? isChosen : undefined}
                      title={t('chat.pickOption')}
                    >
                      {content}
                    </button>
                  </li>
                );
              })}
            </Stack>

            {item.multiSelect && shown === 'current' && !isLocked && (
              <Button
                size="sm"
                variant="secondary"
                className={styles.questionNext}
                disabled={chosen.length === 0}
                onClick={() => {
                  setConfirmed({ ...confirmed, [index]: true });
                  setEditing(undefined);
                }}
              >
                {t('chat.questionNext')}
              </Button>
            )}
          </div>
        );
      })}

      {/*
        Итог карточки. Несколько вопросов — это форма: её показывают целиком и
        отправляют одним нажатием, чтобы промах по варианту можно было исправить
        до, а не после отправки.
      */}
      {!isReadOnly && !isSent && isComplete && questions.length > 1 && (
        <Button
          variant="primary"
          className={styles.questionSubmit}
          disabled={Boolean(disabled)}
          onClick={() => send(picked)}
        >
          {t('chat.questionSubmit')}
        </Button>
      )}

      {isSent && (
        <Stack
          direction="row"
          align="center"
          gap="var(--spacing-2xs)"
          className={styles.questionSentNote}
        >
          <span className={styles.questionSpinner} />
          <Typography as="span" variant="body-sm" color="muted">
            {t('chat.questionSentNote')}
          </Typography>
        </Stack>
      )}
    </div>
  );
}

/** Отвечен — свёрнут, текущий — активен, остальные погашены до своей очереди. */
function stateOf(index: number, current: number | undefined, hasAnswer: boolean): QuestionState {
  if (index === current) return 'current';
  if (hasAnswer) return 'done';
  return 'locked';
}
