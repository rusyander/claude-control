import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { scanSplitBlocks } from '@claude-control/contracts/task-split';
import { scanHandoffBlocks } from '@claude-control/contracts/chat-handoff';
import { Stack } from '@shared/ui/stack';
import { SkeletonList, SkeletonText } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TokenBadge } from '@shared/ui/token-badge';
import { renderMarkdown } from '@shared/lib/markdown/renderMarkdown';
import { toast } from '@shared/lib/toast';
import { isStreamShown } from '@shared/lib/chat-stream';
import { markQuestionAnswered, useAnsweredQuestions } from '@shared/lib/agent-runs';
import { parseQuestions } from '../lib/parseQuestions';
import { liveQuestionKey } from '../lib/questionKey';
import { MessageBubble } from './MessageBubble';
import { QuestionCard } from './QuestionCard';
import { TaskSplitCard } from './TaskSplitCard';
import { HandoffCard } from './HandoffCard';
import { PermissionCard } from './PermissionCard';
import { QueuedBubbles } from './QueuedBubbles';
import type { ChatMessagesProps } from './ChatMessages.types';
import styles from './ChatMessages.module.scss';

/**
 * Лента переписки. Ответ, который печатается прямо сейчас, идёт последним
 * блоком и живёт отдельно от истории: он ещё не записан в транскрипт, а
 * показывать его нужно немедленно.
 */
export function ChatMessages({
  messages,
  conversationId,
  stream,
  isLoading,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onEdit,
  onPickOption,
  isRunning,
  permissions,
  onPermissionDecide,
  childQuestions,
  onChildAnswer,
  childPermissions,
  onChildPermissionDecide,
  onRetry,
  onContinue,
  onRefresh,
  costUnit,
  effort,
  onSplit,
  onKeepHere,
  isSplitPending,
  childBranches,
  handoff,
  queued,
  onCancelQueued,
}: ChatMessagesProps) {
  const { t } = useTranslation();
  // Отвеченные вопросы детей: пока прогон ребёнка жив, источник отдаёт тот же
  // последний `AskUserQuestion`, и без общей памяти он воскресал на каждый
  // возврат на вкладку — а второй ответ стоит ещё одного хода агента.
  const answered = useAnsweredQuestions();
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Держаться ли низа. Пока пользователь внизу — лента едет за ответом; стоит
  // ему отлистать вверх, чтобы перечитать, — отпускаем. Раньше лента тянула
  // вниз на каждом слове, и читать прошлые сообщения во время ответа было
  // нельзя.
  const isPinned = useRef(true);

  // Высота ленты в момент клика «Загрузить ещё»: подгруженные сверху сообщения
  // сдвигают содержимое вниз, и без поправки прокрутки лента прыгала бы. После
  // прибавки восстанавливаем позицию по приросту высоты.
  const restoreScroll = useRef<number | undefined>(undefined);

  // Смена разговора — снова к последнему сообщению. Ключ — id разговора, а не
  // первого сообщения: при подгрузке более ранних первое сообщение меняется, но
  // прокрутку к низу это запускать не должно.
  useEffect(() => {
    isPinned.current = true;
    restoreScroll.current = undefined;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [conversationId]);

  useEffect(() => {
    // Подгрузка более ранних не должна утягивать ленту вниз — её обрабатывает
    // отдельный layout-эффект восстановления позиции.
    if (restoreScroll.current !== undefined) return;
    if (isPinned.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, stream.text, stream.tools.length, stream.stalled, permissions?.length]);

  // Восстановление позиции после подгрузки более ранних: держим на экране то же
  // сообщение, что и было, компенсируя прокрутку приростом высоты сверху.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || restoreScroll.current === undefined) return;
    list.scrollTop += list.scrollHeight - restoreScroll.current;
    restoreScroll.current = undefined;
  }, [messages.length]);

  // Разбор идущего ответа: каждый кусок текста заново, поэтому по памяти — это
  // единственное место ленты, которое пересчитывается на каждое слово. Оба
  // разбора идут цепочкой по одному и тому же тексту — языки блоков разные, и
  // каждый скан видит только свой.
  const streamed = useMemo(() => scanSplitBlocks(stream.text), [stream.text]);
  const streamedHandoff = useMemo(() => scanHandoffBlocks(streamed.text), [streamed.text]);

  /**
   * Сообщение с вопросом, который ещё ЖДЁТ ответа.
   *
   * Отвечать раньше можно было только на последнее сообщение ленты — и это
   * ломалось само по себе, без чужого участия. `AskUserQuestion` в пакетном
   * режиме сразу возвращается ошибкой, поэтому агент задаёт вопрос ПОСРЕДИ хода
   * и продолжает писать: через несколько секунд карточка переставала быть
   * последней и молча становилась нечитаемой картинкой — варианты на экране
   * есть, нажать нельзя. Человек при этом успевал ответить на один вопрос из
   * четырёх и терял остальные.
   *
   * Ищем с конца: реплика человека закрывает вопрос (ответил — не важно, кнопкой
   * или текстом), ответ агента — нет.
   */
  const openQuestionIndex = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message) continue;
      if (message.role === 'user') return undefined;
      if (message.blocks.some((block) => block.type === 'tool' && block.name === 'AskUserQuestion'))
        return index;
    }
    return undefined;
  }, [messages]);

  const loadMore = (): void => {
    if (listRef.current) restoreScroll.current = listRef.current.scrollHeight;
    onLoadMore?.();
  };

  return (
    <div
      className={styles.list}
      ref={listRef}
      onScroll={(event) => {
        const list = event.currentTarget;
        isPinned.current = list.scrollHeight - list.scrollTop - list.clientHeight < 160;
      }}
    >
      {hasMore && onLoadMore && (
        <Stack align="center" padding="var(--spacing-2xs) 0">
          <Button
            size="sm"
            variant="ghost"
            onClick={loadMore}
            isLoading={isLoadingMore}
            disabled={isLoadingMore}
          >
            {t('chat.loadOlder')}
          </Button>
        </Stack>
      )}

      {isLoading && <SkeletonList rows={3} withActions={false} />}

      {messages.map((message, index) => (
        <MessageBubble
          key={message.id}
          message={message}
          onEdit={onEdit}
          onPickOption={onPickOption}
          isLast={index === messages.length - 1}
          isQuestionOpen={index === openQuestionIndex}
          isRunning={isRunning}
          costUnit={costUnit}
          onSplit={onSplit}
          onKeepHere={onKeepHere}
          isSplitPending={isSplitPending}
          childBranches={childBranches}
          handoff={handoff}
        />
      ))}

      {isStreamShown(stream) && (
        <div className={styles.row}>
          <div className={`${styles.bubble} ${styles.bubbleAssistant}`}>
            {stream.thinking && (
              <details className={styles.thinking}>
                <summary>{t('chat.thinking')}</summary>
                <div className={styles.thinkingBody}>{stream.thinking}</div>
              </details>
            )}

            {stream.tools.map((tool, index) => {
              const questions =
                tool.name === 'AskUserQuestion' ? parseQuestions(tool.input) : undefined;

              // Расход шага приходит отдельным событием и садится на свой вызов
              // по id. У параллельных вызовов он общий — сколько их было,
              // считаем прямо здесь, по совпадению шага.
              const spend = tool.usage ? (
                <TokenBadge
                  usage={tool.usage}
                  unit={costUnit}
                  effort={effort}
                  label={tool.name}
                  sharedWith={stream.tools.filter((other) => other.usage === tool.usage).length}
                  className={styles.spend}
                />
              ) : null;

              if (questions) {
                // Имя живого вопроса — id вызова, без имени разговора: оно у
                // разговора меняется (черновое → sessionId), id — нет.
                const key = liveQuestionKey(conversationId ?? 'stream', tool.id, tool.input);
                return (
                  <div key={`${tool.name}-${index}`} className={styles.block}>
                    {/*
                      Отвечать можно СРАЗУ, не дожидаясь конца хода. Вызов уже
                      вернулся ошибкой (в пакетном режиме `AskUserQuestion`
                      иначе не умеет), агент про вопрос больше не помнит и
                      продолжает работу — а человеку выбор нужен именно сейчас.
                      Ответ занятому агенту уходит в очередь и доедет, как
                      только он закончит ход.
                    */}
                    <QuestionCard
                      questions={questions}
                      onPick={
                        onPickOption &&
                        ((answer) => {
                          markQuestionAnswered(key);
                          onPickOption(answer);
                        })
                      }
                      busy={isRunning}
                      isAnswered={answered.has(key)}
                    />
                    {spend}
                  </div>
                );
              }

              return (
                <div key={`${tool.name}-${index}`} className={styles.block}>
                  <details className={styles.tool}>
                    <summary>{tool.name}</summary>
                    <div className={styles.toolInput}>{tool.input}</div>
                  </details>
                  {spend}
                </div>
              );
            })}

            {stream.text && (
              <div className={styles.block}>
                {/*
                  Предложение разделить задачи прячем из текста уже здесь, пока
                  ответ печатается: иначе в ленте несколько секунд стоял бы голый
                  JSON, а незакрытый блок показывался бы обрубком. Карточку
                  рисуем сразу, но погашенной — решать можно, когда агент
                  договорит, и это ровно то, что видно.
                */}
                <div className={styles.blockBody}>
                  {streamedHandoff.text && (
                    <div
                      className={styles.text}
                      // Разметку строит markdown-it с выключенным сырым html.
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(streamedHandoff.text) }}
                    />
                  )}
                  {streamed.proposals.map((proposal, index) => (
                    <TaskSplitCard key={index} proposal={proposal} disabled />
                  ))}
                  {streamed.rejected > 0 && (
                    <div className={styles.splitRejected} role="status">
                      {t('chat.split.notParsed')}
                    </div>
                  )}
                  {streamedHandoff.proposals.map((proposal, index) => (
                    <HandoffCard key={index} proposal={proposal} disabled />
                  ))}
                  {streamedHandoff.rejected > 0 && (
                    <div className={styles.splitRejected} role="status">
                      {t('chat.handoff.notParsed')}
                    </div>
                  )}
                </div>
                {stream.textUsage && (
                  <TokenBadge
                    usage={stream.textUsage}
                    unit={costUnit}
                    effort={effort}
                    label={t('chat.usage.answer')}
                    className={styles.spend}
                  />
                )}
              </div>
            )}

            {/*
              Пока ответа ещё нет, показываем, что работа идёт. Одной мигающей
              каретки на пустом месте мало: со стороны это неотличимо от
              зависшего разговора, а до первого слова проходят секунды —
              модель успевает подумать и сходить в инструменты.
            */}
            {stream.isRunning && !stream.text && (
              <Stack
                direction="row"
                align="center"
                gap="var(--spacing-xs)"
                className={styles.pending}
              >
                <span className={styles.dots} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <Typography
                  as="span"
                  variant="body-sm"
                  color="muted"
                  className={styles.pendingLabel}
                >
                  {stream.tools.length > 0 ? t('chat.pendingTools') : t('chat.pending')}
                </Typography>
              </Stack>
            )}

            {/*
              Скелетон под подписью: три точки говорят «жив», но не показывают,
              что ответ вообще-то пишется. Полосы занимают место будущего текста,
              поэтому лента не прыгает, когда первые слова наконец приходят.
            */}
            {stream.isRunning && !stream.text && (
              <SkeletonText lines={3} className={styles.pendingSkeleton} />
            )}

            {stream.isRunning && stream.text && <span className={styles.caret} />}
          </div>
        </div>
      )}

      {/*
        Связь с потоком потеряна. Пузырь при этом погашен нарочно — он оборван
        на полуслове, а полный ответ агент дописывает в транскрипт, откуда лента
        его и показывает. Без этой строки происходящее выглядело бы как ход,
        исчезнувший без следа; с ней видно и что связь чинится, и что работа
        идёт: прогон живёт на сервере, а не во вкладке.
      */}
      {stream.stalled && !stream.dropped && (
        <div className={styles.reconnecting} role="status">
          <span className={styles.dots} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {t('chat.reconnecting')}
        </div>
      )}

      {/*
        Переподключаться больше нечем — попытки исчерпаны. Молчать здесь нельзя:
        от «агент думает» это неотличимо, и человек ждёт ответа, которого никто
        не пришлёт. Прогон при этом мог спокойно доработать на сервере, поэтому
        и предлагаем не «повторить», а перечитать переписку: ответ, если он
        дописался, лежит в транскрипте.
      */}
      {stream.dropped && (
        <div className={styles.reconnecting} role="status">
          <Icon name="warning" size={18} />
          {t('chat.connectionLost')}
          {onRefresh && (
            <Button size="sm" variant="secondary" onClick={onRefresh}>
              {t('chat.showFromHistory')}
            </Button>
          )}
        </div>
      )}

      {/*
        Дописанное, ждущее конца хода, — в ленте, а не только полоской над
        полем ввода. Ответ занятому агенту иначе не оставлял на экране следа
        вовсе: ни реплики, ни пометки, и минутами непонятно, ушёл ли он.
      */}
      <QueuedBubbles items={queued ?? []} onCancel={onCancelQueued} />

      {permissions && permissions.length > 0 && onPermissionDecide && (
        <PermissionCard permissions={permissions} onDecide={onPermissionDecide} />
      )}

      {/*
        Запросы прав дочерних разговоров. Показываются рядом со своими и по
        более веской причине: на запросе прав агент СТОИТ. Подпись обязательна —
        разрешать «удалить каталог» вслепую, не зная, кто из шести просит,
        человек не должен.
      */}
      {onChildPermissionDecide &&
        (childPermissions ?? []).map((child) => (
          <div key={child.chatId} className={styles.childAsk}>
            <Typography variant="caption" color="subtle" className={styles.childAskFrom}>
              {t('chat.permissionFromChild', { title: child.title })}
            </Typography>
            <PermissionCard
              permissions={child.permissions}
              onDecide={(toolUseId, behavior) =>
                onChildPermissionDecide(child.chatId, toolUseId, behavior)
              }
            />
          </div>
        ))}

      {/*
        Вопросы дочерних разговоров. Ответ уходит в ИХ чат — этот разговор о нём
        не узнает и хода себе не добавит. Подпись обязательна: одинаковых
        вопросов от шести агентов бывает шесть, и без имени чата человек отвечает
        вслепую.
      */}
      {onChildAnswer &&
        (childQuestions ?? []).map((child) => {
          const questions = parseQuestions(child.input);
          if (!questions) return null;
          const key = liveQuestionKey(child.chatId, child.toolUseId, child.input);
          return (
            <div key={`${child.chatId}-${child.toolUseId ?? 'ask'}`} className={styles.childAsk}>
              <Typography variant="caption" color="subtle" className={styles.childAskFrom}>
                {t('chat.questionFromChild', { title: child.title })}
              </Typography>
              <QuestionCard
                questions={questions}
                onPick={(answer) => {
                  markQuestionAnswered(key);
                  onChildAnswer(child.chatId, answer);
                }}
                busy={child.isRunning}
                isAnswered={answered.has(key)}
                // Подпись сохраняется и ПОСЛЕ ответа: «отправлено» без имени
                // разговора не говорит, кому именно из шестерых человек ответил.
                target={child.title}
              />
            </div>
          );
        })}

      {/*
        Ошибка — такое же событие разговора, как ответ, и место ей в ленте.
        Раньше здесь была голая красная строка внизу: на длинной переписке её
        не отличить от обрыва, а что делать дальше — не сказано. Карточка
        называет беду, показывает текст целиком (он бывает многострочным) и
        даёт то самое действие, которого человек ищет, — повторить.
      */}
      {stream.error && (
        <div className={styles.row}>
          <div className={styles.errorCard} role="alert" data-chat-error>
            <Stack direction="row" align="center" gap="var(--spacing-2xs)">
              <Icon name="error" size={20} />
              <Typography variant="body-sm" weight="medium" as="span">
                {t('chat.errorTitle')}
              </Typography>
            </Stack>
            <div className={styles.errorText}>{stream.error}</div>
            {/*
              Три действия вместо одного. «Повторить» отправляет задачу заново —
              но часть работы уже сделана, и переделывать её незачем: «Продолжить»
              просит агента доделать с места обрыва. Текст ошибки нужен целиком —
              его несут в тикет или в поиск, а выделять мышью из ленты неудобно.
              Раньше эти две кнопки жили только в шапке, где их не связать с
              карточкой, из-за которой их ищут.
            */}
            <Stack direction="row" gap="var(--spacing-2xs)" wrap>
              {onRetry && (
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<Icon name="refresh" size={18} />}
                  onClick={onRetry}
                >
                  {t('chat.retry')}
                </Button>
              )}
              {onContinue && (
                <Button size="sm" variant="secondary" onClick={onContinue}>
                  {t('chat.continue')}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<Icon name="copy" size={18} />}
                onClick={() =>
                  void navigator.clipboard.writeText(stream.error ?? '').then(() => {
                    toast.success(t('toasts.copied'));
                  })
                }
              >
                {t('chat.copyError')}
              </Button>
            </Stack>
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
