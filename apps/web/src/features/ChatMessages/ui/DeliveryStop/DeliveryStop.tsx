import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@shared/lib/cn';
import { Typography } from '@shared/ui/typography';
import type { DeliveryStall, DeliveryStopItem } from '../../lib/deliveryStop.types';
import type { DeliveryStopProps } from './DeliveryStop.types';
import styles from './DeliveryStop.module.scss';

/** Сколько пунктов видно до «ещё N»: больше — плашка снова становится стеной. */
const VISIBLE = 4;

const lineOf = (item: DeliveryStopItem): string =>
  item.todo ?? (item.name ? `${item.name}: ${item.what}` : item.what);

/** «MR !12» / «PR #12» по ссылке группы; без ссылки — `undefined`. */
function mrLabelOf(mr: string | undefined): string | undefined {
  const pull = mr?.match(/\/pull\/(\d+)$/)?.[1];
  if (pull) return `PR #${pull}`;
  const id = mr?.match(/(\d+)$/)?.[1];
  return id ? `MR !${id}` : undefined;
}

/** Ключ строки действия по виду остановки; вид не назван — общая «сама не продолжит». */
const ACTION: Record<DeliveryStall | 'none', string> = {
  stalled: 'chat.cascade.hub.deliveryStop.action.stalled',
  'nudge-cap': 'chat.cascade.hub.deliveryStop.action.nudgeCap',
  'escalation-stalled': 'chat.cascade.hub.deliveryStop.action.escalationStalled',
  'retry-cap': 'chat.cascade.hub.deliveryStop.action.retryCap',
  none: 'chat.cascade.hub.deliveryStop.action.stopped',
};

/**
 * Группа, остановленная на доставке (владелец 23.10.2026). Сама она уже не
 * продолжит (F-23): ни один путь сервера не двигает сдавшуюся на доставке
 * группу, и «панель доводит сама — от вас ничего не нужно» оставляло человека
 * ждать группу, которая не сдвинется. Строка действия говорит, почему панель
 * перестала напоминать и что сделать: продолжить группу словом — пункты
 * закроет агент. Строка человеку у пункта, который агенту нельзя (мерж,
 * разрушительная операция, нет доступа), называет само действие.
 *
 * Лежит в теле карточки под её растянутой кнопкой: «ещё N» поднято над ней
 * (z-index) — нажатие раскрывает список, а не открывает чат группы.
 */
export function DeliveryStop({ stop, mr }: DeliveryStopProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { auto, human, stall } = stop;
  const hidden = auto.length > VISIBLE ? auto.length - VISIBLE : 0;
  const shown = expanded || hidden === 0 ? auto : auto.slice(0, VISIBLE);
  const mrLabel = mrLabelOf(mr);
  // Пункт человека сам называет действие; без него — или когда панель
  // перестала напоминать — строка, как продолжить группу.
  const action = stall || human.length === 0 ? ACTION[stall ?? 'none'] : undefined;

  return (
    <div
      className={cn(styles.stop, human.length > 0 ? styles.stopHuman : styles.stopWait)}
      data-hub-problem
      data-hub-delivery-stop={auto.length + human.length}
      data-delivery-mode={human.length > 0 ? 'human' : 'continue'}
      data-delivery-stall={stall ?? 'none'}
    >
      {auto.length > 0 ? (
        <Typography
          variant="caption"
          weight="semibold"
          color="warning"
          as="span"
          data-hub-delivery-head
        >
          {t('chat.cascade.hub.deliveryStop.stopped', { count: auto.length })}
        </Typography>
      ) : (
        <Typography
          variant="caption"
          weight="semibold"
          color="danger"
          as="span"
          data-hub-delivery-head
        >
          {t('chat.cascade.hub.deliveryStop.humanOnly', { count: human.length })}
        </Typography>
      )}
      {/* Человеку — только то, что агенту нельзя, и точным действием. */}
      {human.map(({ kind, item }, index) => (
        <Typography
          key={index}
          variant="caption"
          weight="semibold"
          color="danger"
          as="span"
          data-hub-delivery-human={kind}
        >
          {kind === 'merge' && mrLabel
            ? t('chat.cascade.hub.deliveryStop.needMerge', { mr: mrLabel })
            : t(`chat.cascade.hub.deliveryStop.need.${kind}`, { action: lineOf(item) })}
        </Typography>
      ))}
      {action && (
        <Typography variant="caption" color="default" as="span" data-hub-delivery-who>
          {t(action)}
        </Typography>
      )}
      {auto.length > 0 && (
        <ul className={styles.list}>
          {shown.map((item, index) => (
            <li key={index} className={styles.item} data-hub-delivery-item>
              {item.name && (
                <span className={styles.name} data-hub-delivery-name>
                  {item.name}
                </span>
              )}
              {item.name && item.what ? ': ' : ''}
              {item.what}
              {item.todo && (
                <span className={styles.todo} data-hub-delivery-todo>
                  {t('chat.cascade.hub.deliveryStop.todo', { text: item.todo })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <button
          type="button"
          className={styles.more}
          aria-expanded={expanded}
          data-hub-delivery-more
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? t('chat.cascade.hub.deliveryStop.less')
            : t('chat.cascade.hub.deliveryStop.more', { count: hidden })}
        </button>
      )}
    </div>
  );
}
