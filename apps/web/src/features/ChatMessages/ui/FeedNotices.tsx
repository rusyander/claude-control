import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { FeedNoticesProps } from './FeedNotices.types';
import styles from './ChatMessages.module.scss';

/**
 * Строки состояния ленты: что с прогоном, если пузыря на экране нет.
 *
 * Все четыре случая выглядят одинаково нарочно — негромкая строка на месте
 * ответа, — потому что ни один из них не беда: агент работает на сервере, а
 * правда об ответе лежит в транскрипте. Взаимоисключающими их держит порядок
 * условий: сперва потеря связи, потом подхват без потока, потом заметка
 * сервера.
 *
 * Отдельным файлом — потому что `ChatMessages.tsx` перерос предел длины, а этот
 * кусок в нём цельный и ни от чего, кроме потока, не зависит.
 */
export function FeedNotices({ stream, onRefresh }: FeedNoticesProps) {
  const { t } = useTranslation();

  return (
    <>
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
        Прогон подхвачен сервером после его перезапуска: процесс агента жив, а
        трубы к нему нет — текст ответа в поток не придёт, его ведёт транскрипт.
        Пузыря нет нарочно (он прятал бы из истории единственную правду), а
        строка объясняет, почему лента без пузыря всё же «работает», что карточки
        прав живы и что продолжений после такого прогона не будет.
      */}
      {stream.detached && stream.isRunning && !stream.dropped && (
        <div className={styles.reconnecting} role="status" data-chat-detached>
          <Icon name="info" size={18} />
          {t('chat.detachedNotice')}
        </div>
      )}

      {/*
        Заметка сервера о прогоне (конвейер уровней, Т1): разбор применён или не
        получен, работа пошла без плана. Текст приходит готовым — сервер один
        знает счёт групп и причины, — и живёт в ленте до следующего прогона: это
        итог хода, а не тост на пять секунд. У подхваченного прогона своя строка
        стоит выше, и заметка про подхват в ней уже сказана.
      */}
      {stream.notice && !stream.detached && (
        <div className={styles.reconnecting} role="status" data-chat-notice>
          <Icon name="info" size={18} />
          {stream.notice}
        </div>
      )}
    </>
  );
}
