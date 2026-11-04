import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderChatMessage } from '@agentdeck/contracts';
import { scanSplitBlocks } from '@agentdeck/contracts/task-split';
import { scanHandoffBlocks } from '@agentdeck/contracts/chat-handoff';
import { scanReviewBlocks } from '@agentdeck/contracts/model-cascade';
import { mediaRequestOf, scanMediaBlocks } from '@agentdeck/contracts/media-block';
import { withoutSplitTickets } from '@agentdeck/contracts/split-tickets';
import { withoutEscalateBlocks } from '@agentdeck/contracts/chat-escalate';
import { withoutSieveBlocks } from '@agentdeck/contracts/sieves';
import {
  TaskSplitCard,
  HandoffCard,
  MediaFeedCard,
  MediaRequestText,
} from '@features/ChatMessages';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { formatDuration } from '@shared/lib/format-duration';
import { ContextSummarizedNote } from '@entities/Platform';
import type { ProviderChatMessagesProps } from './ProviderChatMessages.types';
import styles from './ProviderChatMessages.module.scss';

/**
 * Лента старого разговора чужого CLI — только история (этап 10, F2c): ход идёт в чате ядра,
 * здесь нет ни растущего ответа, ни очереди, ни кнопок предложений. Карточки блоков
 * (разделение, продолжение, рисунок, колода) показываются как запись того, что было.
 */
export function ProviderChatMessages({
  messages,
  providerName,
  isEmptyState,
  onCreate,
  mediaChatId,
  mediaModel,
}: ProviderChatMessagesProps) {
  const { t } = useTranslation();

  /**
   * Время ответа и сумма по разговору. У Claude это живёт в бейдже расхода, но
   * бейджу нужен расход, а чужой CLI его не отдаёт — здесь остаётся то, что есть
   * всегда: часы панели. Сумма копится по порядку реплик, поэтому считается
   * один раз на всю ленту, а не в каждой строке.
   */
  const timings = new Map<string, { step: number; total: number }>();
  let running = 0;
  for (const message of messages) {
    if (message.durationMs === undefined) continue;
    running += message.durationMs;
    timings.set(message.id, { step: message.durationMs, total: running });
  }

  /**
   * Время под ответом: шаг и, со второго ответа, сумма по разговору. Формат и
   * знак суммы — те же, что в бейдже расхода у Claude; реплика без времени
   * (запись, сделанная до этой правки) строки не получает вовсе — выдуманный
   * ноль хуже пустого места.
   */
  const renderTime = (message: ProviderChatMessage): ReactNode => {
    const time = timings.get(message.id);
    if (!time) return null;
    const step = formatDuration(time.step, t);
    const total = formatDuration(time.total, t);
    const withTotal = time.total !== time.step;
    return (
      <Typography variant="caption" color="subtle" as="span" className={styles.turnTime}>
        {/* Числа читаются глазами, а вслух — целой фразой: `Σ` голосом не
            произносится, а подписать span атрибутом нельзя, у него нет роли. */}
        <span className={styles.turnTimeLabel}>
          {withTotal
            ? t('providerChat.timing.full', { step, total })
            : t('providerChat.timing.step', { step })}
        </span>
        <span aria-hidden="true">{step}</span>
        {withTotal && <span aria-hidden="true">{`Σ ${total}`}</span>}
      </Typography>
    );
  };

  /** Текст реплики без блоков предложений плюс карточки на их месте. */
  const renderTurn = (message: ProviderChatMessage): ReactNode => {
    // Просьба режима «Презентация»/«Картинка»: слова человека сверху, правила
    // из каталога свёрнуты — как в ленте Claude.
    const request = message.role === 'user' ? mediaRequestOf(message.content) : undefined;
    if (request) return <MediaRequestText request={request} text={message.content} />;
    const split = scanSplitBlocks(message.content);
    const handoff = scanHandoffBlocks(split.text);
    // Блок вердикта ревью — служебный: по нему панель заводит звено правок, а
    // человеку нужен разбор словами. У Claude его убирает `MessageBubble`; здесь
    // своя лента, и без этой строки звенья конвейера у чужого CLI показывали бы
    // сырой JSON (проверено на живом прогоне 08.09.2026).
    const review = scanReviewBlocks(handoff.text);
    // Вложения агента (Т10): рисунок и колода приезжают блоками, и карточка
    // встаёт на их место. Именно эта дорога и работает у чужого CLI — ни
    // контура, ни ключа она не требует.
    // Блок тикета группы (95b) — служебный: его список держит хаб. Блок
    // эскалации пишут чужие дочерние чаты, подбирает его сервер — человеку сырой
    // JSON не нужен (`chat-escalate.ts`). Оба — только у ответа агента, как в
    // ленте Claude: человек, описавший формат, видит свой пример (ревью 28.09, F-226).
    const media = scanMediaBlocks(
      message.role === 'user'
        ? review.text
        : withoutSieveBlocks(withoutEscalateBlocks(withoutSplitTickets(review.text))),
    );
    const hasCards =
      split.proposals.length > 0 ||
      handoff.proposals.length > 0 ||
      media.decks.length > 0 ||
      media.pictures.length > 0 ||
      media.rejected > 0;
    if (!hasCards) {
      return <Typography className={styles.turnText}>{media.text}</Typography>;
    }
    return (
      <>
        {media.text && <Typography className={styles.turnText}>{media.text}</Typography>}
        {split.proposals.map((proposal, index) => (
          // Разделение снято вместе с маршрутом: карточка — история, без кнопок.
          <TaskSplitCard key={index} proposal={proposal} />
        ))}
        {handoff.proposals.map((proposal, index) => (
          // Продолжение в чистой сессии — история: ход идёт в чате ядра.
          <HandoffCard key={index} proposal={proposal} />
        ))}
        {media.pictures.map((svg, index) => (
          <MediaFeedCard
            key={`svg-${index}`}
            svg={svg}
            {...(mediaChatId ? { chatId: mediaChatId } : {})}
            {...(mediaModel ? { model: mediaModel } : {})}
          />
        ))}
        {media.decks.map((deck, index) => (
          <MediaFeedCard
            key={`deck-${index}`}
            deck={deck}
            {...(mediaChatId ? { chatId: mediaChatId } : {})}
            {...(mediaModel ? { model: mediaModel } : {})}
            prompt={deck.title}
          />
        ))}
        {/* Непринятый блок остаётся в тексте как есть, и решение об этом приняла
            ПАНЕЛЬ — значит, она и говорит об этом. */}
        {media.rejected > 0 && (
          <Typography variant="caption" color="danger" as="p">
            {t('chat.mode.block.rejected', { count: media.rejected })}
          </Typography>
        )}
      </>
    );
  };

  const isBlank = messages.length === 0;

  return (
    <div className={styles.list}>
      {isBlank ? (
        // Ключи у веток разные намеренно: без них React переиспользует тот же
        // div и меняет на нём `flex` на месте, а смена сокращённого свойства на
        // развёрнутое — предупреждение в консоли и потенциальный сбой стиля.
        <Stack
          key="empty"
          align="center"
          justify="center"
          flex={1}
          gap="var(--spacing-sm)"
          className={styles.empty}
        >
          <Icon name="chat" size={40} />
          <Typography variant="heading-sm">
            {t('providerChat.title', { provider: providerName })}
          </Typography>
          <Typography color="muted" className={styles.emptyText}>
            {isEmptyState ? t('providerChat.startHint') : t('providerChat.empty')}
          </Typography>
          {isEmptyState && (
            <Button variant="primary" onClick={onCreate} leftIcon={<Icon name="plus" size={18} />}>
              {t('providerChat.new')}
            </Button>
          )}
        </Stack>
      ) : (
        <Stack key="list" gap="var(--spacing-sm)" padding="var(--spacing-md) var(--spacing-xl)">
          {messages.map((message) =>
            /* Заметка панели — не реплика: подписывать её именем провайдера
               значило бы приписать модели слова, которых она не говорила. */
            message.role === 'notice' ? (
              <Typography
                key={message.id}
                variant="caption"
                color="subtle"
                className={styles.noticeTurn}
                data-provider-notice
              >
                {message.content}
              </Typography>
            ) : (
              <Stack
                key={message.id}
                gap="var(--spacing-3xs)"
                className={[
                  message.role === 'user' ? styles.userTurn : styles.assistantTurn,
                  message.failed ? styles.failedTurn : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <Typography variant="caption" color="subtle" as="span">
                  {message.role === 'user' ? t('providerChat.you') : providerName}
                  {message.failed ? ` · ${t('providerChat.failed')}` : ''}
                  {message.steered ? ` · ${t('providerChat.steered')}` : ''}
                </Typography>
                {renderTurn(message)}
                {message.role === 'assistant' && message.contextSummarized && (
                  <ContextSummarizedNote scope="run" />
                )}
                {renderTime(message)}
              </Stack>
            ),
          )}
        </Stack>
      )}
    </div>
  );
}
