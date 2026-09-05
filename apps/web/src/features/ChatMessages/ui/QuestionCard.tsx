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
 * отвеченные свёрнуты и их можно переспросить, а до которых не дошли — свёрнуты
 * СТРОКОЙ, без вариантов. Погашенные варианты вместо строки читались как
 * «спросили всё сразу»: от активных они почти не отличались, человек тыкал в
 * середину и не понимал, почему не срабатывает.
 * Отправка одна на всю карточку — одно сообщение, один ход агента.
 *
 * Ответ фиксируется МГНОВЕННО, не дожидаясь сервера: агент отвечает десятками
 * секунд, и всё это время карточка обязана выглядеть отправленной, иначе
 * человек честно решит, что клик не прошёл, и нажмёт ещё раз.
 *
 * ОТВЕЧАТЬ МОЖНО И ПОКА АГЕНТ РАБОТАЕТ. Раньше варианты гасились на время
 * прогона — и это ломало ровно тот случай, ради которого карточка существует:
 * `AskUserQuestion` в пакетном режиме возвращается ошибкой сразу, то есть
 * вопрос задан ПОСРЕДИ хода и агент продолжает работать. Человек видел «нужен
 * ваш выбор», по которому нельзя щёлкнуть. Занятость меняет теперь не
 * доступность, а подпись: ответ уйдёт по концу хода (`busy`).
 *
 * СВОЙ ВАРИАНТ есть у каждого вопроса, даже когда агент его не предложил.
 * Варианты пишет модель, и ни один из них может не подходить; без своей строки
 * человеку оставалось молча выбрать «наименее неверный» или уходить в поле
 * ввода, потеряв связь ответа с вопросом. Текст встаёт на место выбранной
 * подписи — дальше он живёт как обычный вариант: его видно, его можно
 * переспросить, он уезжает тем же одним сообщением.
 */
export function QuestionCard({ questions, onPick, busy, target, isAnswered }: QuestionCardProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<PickedAnswers>({});
  // Открытое поле своего варианта и набранный в нём текст — по вопросам.
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});
  // Подтверждённые множественные выборы: галочка ставится не одним щелчком, и
  // закрыть такой вопрос может только «Дальше».
  const [confirmed, setConfirmed] = useState<Record<number, boolean>>({});
  // Вопрос, к которому вернулись кнопкой «Изменить»: он снова активен, хотя
  // ответ у него уже есть.
  const [editing, setEditing] = useState<number | undefined>(undefined);
  const [isSent, setSent] = useState(false);
  // Каким ответ ушёл: сразу или в очередь занятого агента. Считаем в момент
  // клика — к перерисовке ход мог уже кончиться, и подпись соврала бы задним
  // числом о том, что человек видел.
  const [isQueued, setQueued] = useState(false);
  // Тот же признак, но доступный СРАЗУ. Двойной щелчок по варианту успевает
  // между событием и перерисовкой, и состояние во втором обработчике было бы
  // ещё прежним — а ответ ушёл бы дважды, то есть двумя ходами агента.
  const wasSent = useRef(false);

  const pending = nextQuestion(questions, picked, confirmed);
  const current = editing ?? pending;
  const isReadOnly = !onPick;
  // Отправленной карточку делает и своё состояние, и память стора: своё умирает
  // вместе с перемонтажом, а вопрос из транскрипта переживает и его, и F5.
  const sent = isSent || Boolean(isAnswered);
  const isLocked = sent || isReadOnly;

  const send = (answers: PickedAnswers): void => {
    const text = composeAnswer(questions, answers);
    if (!onPick || !text || wasSent.current || isAnswered) return;
    // Порядок важен: сначала гасим карточку, потом отправляем. Отправка уходит
    // в стор синхронно, и второй клик по соседнему варианту не должен успеть.
    wasSent.current = true;
    setSent(true);
    setQueued(Boolean(busy));
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

  /**
   * Свой вариант вместо предложенных. Прежний свой вариант заменяется, а не
   * копится: иначе во множественном выборе после трёх правок ответ уехал бы с
   * тремя редакциями одной и той же мысли.
   */
  const applyCustom = (index: number): void => {
    if (isLocked || wasSent.current) return;
    const value = (otherText[index] ?? '').trim();
    if (!value) return;

    const question = questions[index];
    const labels = (question?.options ?? []).map((option) => option.label);
    const chosen = (picked[index] ?? []).filter((label) => labels.includes(label));
    const answers = { ...picked, [index]: question?.multiSelect ? [...chosen, value] : [value] };

    setPicked(answers);
    setOtherOpen({ ...otherOpen, [index]: false });
    setEditing(undefined);
    if (questions.length === 1 && !question?.multiSelect) send(answers);
  };

  const isComplete = pending === undefined;

  return (
    <div className={`${styles.question} ${sent ? styles.questionSent : ''}`}>
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
        {questions.length > 1 && !sent && (
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
        // Ответ своими словами: он же выбранный вариант, только подписи такой
        // среди предложенных нет.
        const optionLabels = (item.options ?? []).map((option) => option.label);
        const custom = chosen.find((label) => !optionLabels.includes(label));
        const state: QuestionState = stateOf(index, current, chosen.length > 0);
        // Только для чтения — старый вопрос из ленты: показываем как есть,
        // без шагов и без блокировок, отвечать на него уже некуда.
        const shown = isReadOnly ? 'current' : state;

        // До вопроса ещё не дошли: показываем строкой, без вариантов. Развёрнутые
        // варианты погашенного вопроса от активных почти не отличались — карточка
        // читалась как «спросили всё сразу», человек тыкал в середину и не
        // понимал, почему не срабатывает. Строка же прямо говорит, что этот
        // вопрос будет следующим.
        if (shown === 'locked') {
          return (
            <div
              key={index}
              className={`${styles.questionItem} ${styles.questionLocked}`}
              aria-disabled
            >
              <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
                {item.header && <span className={styles.questionBadge}>{item.header}</span>}
                <Typography as="span" variant="body-sm" color="muted">
                  {item.question}
                </Typography>
                <Typography as="span" variant="caption" color="subtle">
                  {t('chat.questionWait')}
                </Typography>
              </Stack>
            </div>
          );
        }

        if (shown === 'done' && !sent) {
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
            className={[styles.questionItem, shown === 'done' && styles.questionDoneOpen]
              .filter(Boolean)
              .join(' ')}
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

              {/* Свой ответ — такой же выбранный вариант, только текст его
                  написан человеком. Без этой строки во множественном выборе он
                  просто исчезал бы из виду. */}
              {custom && (
                <li>
                  <div className={`${styles.option} ${styles.optionChosen}`}>
                    <Typography
                      as="span"
                      variant="body-sm"
                      weight="semibold"
                      className={styles.optionLabel}
                    >
                      {custom}
                    </Typography>
                    <span className={styles.optionText}>{t('chat.questionOtherMine')}</span>
                  </div>
                </li>
              )}
            </Stack>

            {/*
              Свой вариант. Показан как ещё одна строка выбора — и когда он
              задан, стоит на месте варианта: иначе во множественном выборе
              собственный ответ не было видно среди отмеченных.
            */}
            {!isReadOnly &&
              shown === 'current' &&
              !isLocked &&
              (otherOpen[index] ? (
                <div className={styles.questionOther}>
                  <textarea
                    className={styles.questionOtherInput}
                    rows={2}
                    autoFocus
                    value={otherText[index] ?? ''}
                    placeholder={t('chat.questionOtherPlaceholder')}
                    aria-label={t('chat.questionOther')}
                    onChange={(event) =>
                      setOtherText({ ...otherText, [index]: event.target.value })
                    }
                    onKeyDown={(event) => {
                      // Enter отправляет, Shift+Enter переносит строку — как в
                      // поле ввода чата, чтобы привычка работала и здесь.
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        applyCustom(index);
                      }
                    }}
                  />
                  <Stack direction="row" gap="var(--spacing-2xs)">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={(otherText[index] ?? '').trim().length === 0}
                      onClick={() => applyCustom(index)}
                    >
                      {t('chat.questionOtherApply')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setOtherOpen({ ...otherOpen, [index]: false })}
                    >
                      {t('common.cancel')}
                    </Button>
                  </Stack>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className={styles.questionOtherOpen}
                  leftIcon={<Icon name="edit" size={16} />}
                  onClick={() => setOtherOpen({ ...otherOpen, [index]: true })}
                >
                  {custom ? t('chat.questionOtherEdit') : t('chat.questionOther')}
                </Button>
              ))}

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
      {!isReadOnly && !sent && isComplete && questions.length > 1 && (
        <Button variant="primary" className={styles.questionSubmit} onClick={() => send(picked)}>
          {t('chat.questionSubmit')}
        </Button>
      )}

      {sent && (
        <Stack
          direction="row"
          align="center"
          gap="var(--spacing-2xs)"
          className={styles.questionSentNote}
        >
          <span className={styles.questionSpinner} />
          <Typography as="span" variant="body-sm" color="muted">
            {/* Ответ на вопрос ребёнка уходит в ЕГО разговор: без имени
                человек, ответивший шестерым, не помнит, кому именно. */}
            {target
              ? t(isQueued ? 'chat.questionQueuedToNote' : 'chat.questionSentToNote', {
                  title: target,
                })
              : t(isQueued ? 'chat.questionQueuedNote' : 'chat.questionSentNote')}
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
