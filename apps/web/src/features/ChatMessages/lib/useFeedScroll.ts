import { useEffect, useLayoutEffect, useRef } from 'react';
import { feedPositions, isPinnedAt, restoreTarget, snapshotOf } from './feedPosition';
import type { FeedProbe, FeedRow, FeedSnapshot } from './feedPosition.types';
import type { FeedScrollSignals } from './useFeedScroll.types';

/**
 * Сколько ждать, пока на экране появится переписка, к месту в которой
 * возвращаемся, мс. Пока её грузят, показано окно прошлого разговора, и ставить
 * ленту по нему нельзя. Дольше — значит, переписку переписали (якоря больше
 * нет нигде), и лента ведёт себя как при первом открытии.
 */
const RESTORE_WAIT_MS = 10_000;

/**
 * Сколько после возврата к месту держать ленту на нём, мс. Под сообщениями
 * родителя дорисовывается сводка групп, картинки и блоки кода догружаются:
 * высота растёт уже после возврата, и место, поставленное по неполной ленте,
 * съезжало (после перезагрузки — каждый раз, владелец 20.10). Любое действие
 * человека в ленте держание снимает сразу.
 */
const SETTLE_MS = 4_000;

/** События, которыми человек сам двигает ленту: после них место решает он. */
const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/** Атрибут сообщения ленты, по которому ищется якорь (ставит `MessageBubble`). */
const ROW_ATTR = 'data-feed-message';

/**
 * Прокрутка ленты: держаться низа, пока человек внизу, не прыгать при
 * подгрузке более ранних сообщений и возвращать место при возврате в разговор.
 *
 * Пока пользователь внизу — лента едет за ответом; стоит ему отлистать вверх,
 * чтобы перечитать, — отпускаем (раньше лента тянула вниз на каждом слове, и
 * читать прошлое во время ответа было нельзя). Подгруженные сверху сообщения
 * сдвигают содержимое вниз — позицию восстанавливаем по приросту высоты.
 * Отлистанный разговор запоминает место (`feedPosition.ts`): ушли к ребёнку и
 * вернулись в родителя — лента стоит там же, а не внизу.
 */
export function useFeedScroll({
  conversationId,
  messageCount,
  streamText,
  streamToolCount,
  stalled,
  permissionCount,
}: FeedScrollSignals) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isPinned = useRef(true);
  // Высота ленты в момент клика «Загрузить ещё»; есть — идёт восстановление.
  const restoreScroll = useRef<number | undefined>(undefined);
  // Разговор, чьё место пишут события прокрутки. Свой, а не из пропсов в
  // замыкании: кадр снимка мог быть заказан ещё в прошлом разговоре.
  const shownId = useRef(conversationId);
  // Место, к которому возвращаемся, пока его переписка не нарисована.
  const pending = useRef<{ snapshot: FeedSnapshot; since: number } | undefined>(undefined);
  const captureFrame = useRef<number | undefined>(undefined);
  // Место уже вернули, но лента ещё дорисовывается: держим его до `until`.
  const settle = useRef<{ snapshot: FeedSnapshot; until: number } | undefined>(undefined);
  const settleFrame = useRef<number | undefined>(undefined);

  /** Каждый кадр окна держания — снова к месту, если высота ленты сдвинула его. */
  const holdPlace = (): void => {
    settleFrame.current = undefined;
    const list = listRef.current;
    const hold = settle.current;
    if (!list || !hold) return;
    if (Date.now() > hold.until) {
      settle.current = undefined;
      return;
    }
    const target = restoreTarget(hold.snapshot, probeFeed(list, hold.snapshot));
    if (target !== undefined && Math.abs(list.scrollTop - target) > 1) {
      list.scrollTop = target;
      isPinned.current = isPinnedAt(list);
    }
    settleFrame.current = requestAnimationFrame(holdPlace);
  };

  const stopHolding = (): void => {
    settle.current = undefined;
    if (settleFrame.current !== undefined) cancelAnimationFrame(settleFrame.current);
    settleFrame.current = undefined;
  };

  const toBottom = (): void => {
    isPinned.current = true;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  };

  /** Вернуть ленту к месту снимка, если его переписка уже на экране. */
  const tryRestore = (): void => {
    const list = listRef.current;
    const wait = pending.current;
    if (!list || !wait) return;
    const target = restoreTarget(wait.snapshot, probeFeed(list, wait.snapshot));
    if (target === undefined) {
      if (Date.now() - wait.since <= RESTORE_WAIT_MS) return;
      pending.current = undefined;
      toBottom();
      return;
    }
    pending.current = undefined;
    list.scrollTop = target;
    isPinned.current = isPinnedAt(list);
    stopHolding();
    settle.current = { snapshot: wait.snapshot, until: Date.now() + SETTLE_MS };
    settleFrame.current = requestAnimationFrame(holdPlace);
  };

  // Смена разговора. Ключ — id разговора, а не первого сообщения: при подгрузке
  // более ранних первое сообщение меняется, но прокрутку это запускать не
  // должно. Отлистанный раньше разговор — к его месту, layout-эффектом: место
  // ставится до отрисовки, без мигания низом.
  const restoresOnSwitch = useRef(false);
  useLayoutEffect(() => {
    shownId.current = conversationId;
    restoreScroll.current = undefined;
    stopHolding();
    const snapshot = conversationId ? feedPositions.get(conversationId) : undefined;
    restoresOnSwitch.current = Boolean(snapshot);
    pending.current = snapshot ? { snapshot, since: Date.now() } : undefined;
    isPinned.current = !snapshot;
    if (snapshot) tryRestore();
    // tryRestore читает только ref'ы — повторный запуск нужен лишь на смене разговора.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Остальные (и первое открытие) — к последнему сообщению, как и было, тем же
  // пассивным эффектом: момент прокрутки к низу не сдвигаем.
  useEffect(() => {
    if (!restoresOnSwitch.current) toBottom();
  }, [conversationId]);

  useEffect(() => {
    // Подгрузка более ранних не должна утягивать ленту вниз — её обрабатывает
    // отдельный layout-эффект восстановления позиции.
    if (restoreScroll.current !== undefined) return;
    if (isPinned.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messageCount, streamText, streamToolCount, stalled, permissionCount]);

  // Восстановление позиции после подгрузки более ранних: держим на экране то же
  // сообщение, что и было, компенсируя прокрутку приростом высоты сверху. И
  // второй случай — возврат в разговор, чья переписка доехала только сейчас.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (pending.current) tryRestore();
    if (!list || restoreScroll.current === undefined) return;
    list.scrollTop += list.scrollHeight - restoreScroll.current;
    restoreScroll.current = undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageCount]);

  // Заказанные кадры не должны пережить ленту.
  useEffect(
    () => () => {
      if (captureFrame.current !== undefined) cancelAnimationFrame(captureFrame.current);
      stopHolding();
    },
    [],
  );

  // Человек сам тронул ленту — держание места кончилось, решает он.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const release = (): void => stopHolding();
    for (const name of USER_SCROLL_EVENTS) list.addEventListener(name, release, { passive: true });
    return () => {
      for (const name of USER_SCROLL_EVENTS) list.removeEventListener(name, release);
    };
  }, [conversationId]);

  /** Запомнить место (или забыть: у низа разговор едет за ответом, как при первом открытии). */
  const capture = (list: HTMLDivElement, id: string | undefined): void => {
    captureFrame.current = undefined;
    if (!id || id !== shownId.current || pending.current) return;
    // Пока место держим, прокрутку двигаем мы, а не человек: снимок не нужен.
    if (settle.current) return;
    if (isPinned.current) feedPositions.delete(id);
    else feedPositions.set(id, snapshotOf(readRows(list), list.scrollTop));
  };

  return {
    bottomRef,
    listRef,
    /** Запомнить высоту перед «Загрузить ещё» — после прибавки позиция вернётся. */
    rememberHeight: () => {
      if (listRef.current) restoreScroll.current = listRef.current.scrollHeight;
    },
    /** Прокрутка человека: у низа — снова держимся, отлистал — отпускаем и запоминаем место. */
    onScroll: (list: HTMLDivElement) => {
      // Пока ждём переписку для возврата, на экране чужое окно: его прокрутка
      // ничего не значит. Ждём слишком долго — отпускаем, решает человек.
      if (pending.current) {
        if (Date.now() - pending.current.since <= RESTORE_WAIT_MS) return;
        pending.current = undefined;
      }
      isPinned.current = isPinnedAt(list);
      // Снимок — раз в кадр: читать положение всех сообщений на каждое событие
      // прокрутки незачем, их приходит по несколько за кадр.
      if (captureFrame.current !== undefined) return;
      const id = shownId.current;
      captureFrame.current = requestAnimationFrame(() => capture(list, id));
    },
  };
}

/** Сообщения ленты с их положением относительно верха видимой части. */
function readRows(list: HTMLDivElement): FeedRow[] {
  const top = list.getBoundingClientRect().top;
  return [...list.querySelectorAll<HTMLElement>(`[${ROW_ATTR}]`)].map((row) => {
    const rect = row.getBoundingClientRect();
    return { id: row.getAttribute(ROW_ATTR) ?? '', top: rect.top - top, bottom: rect.bottom - top };
  });
}

/** Что из снимка нарисовано сейчас и где. */
function probeFeed(list: HTMLDivElement, snapshot: FeedSnapshot): FeedProbe {
  const find = (id: string | undefined) =>
    id ? list.querySelector<HTMLElement>(`[${ROW_ATTR}="${CSS.escape(id)}"]`) : null;
  const anchor = find(snapshot.anchor?.id);
  const top = list.getBoundingClientRect().top;
  return {
    ...(anchor ? { anchorTop: anchor.getBoundingClientRect().top - top } : {}),
    hasLast: Boolean(find(snapshot.lastId)),
    scrollTop: list.scrollTop,
    maxScroll: list.scrollHeight - list.clientHeight,
  };
}
