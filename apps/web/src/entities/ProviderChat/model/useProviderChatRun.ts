import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ProviderChatPermission, ProviderChatQueued } from '@agentdeck/contracts';
import { isAnswerRunningRefusal } from './sendRefusal';
import { sendProviderChatMessage } from '../lib/sendProviderChatMessage';
import { cancelProviderChatQueued } from '../lib/cancelProviderChatQueued';
import { sendProviderChatQueued } from '../lib/sendProviderChatQueued';
import { answerProviderChatPermission } from '../lib/answerProviderChatPermission';
import { stopProviderChat } from '../lib/stopProviderChat';
import { readProviderChatStatus } from '../lib/readProviderChatStatus';
import { openProviderChatStream } from '../lib/openProviderChatStream';
import { providerChatKeys } from '../api/ProviderChatApi.constants';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/**
 * Идущий ответ открытого разговора: текст, который уже напечатан, и признак
 * работы.
 *
 * Ответ принадлежит серверу, а не вкладке. Поэтому здесь всего два действия —
 * подключиться к потоку и сверить состояние: закрыли вкладку, ушли на другую
 * страницу, нажали F5 — ответ всё это время шёл, и по возвращении показывается
 * то, что успело накопиться, а не пустой экран.
 */
export interface ProviderChatRunState {
  /** Текст, напечатанный к этому моменту (пустой — ответа сейчас нет). */
  partial: string;
  isRunning: boolean;
  /**
   * Идущий ход принимает сообщения посреди ответа (В1): отправленное сейчас
   * уйдёт в этот же ход. `false` — дождётся конца ответа в очереди.
   */
  isSteerable: boolean;
  /** Текст ошибки последнего ответа: показывается один раз, до нового вопроса. */
  error?: string;
  /**
   * Дописанное, пока шёл ответ, — очередь сервера по порядку: уйдёт само по
   * концу ответа. Серверная, поэтому одна на все вкладки и телефон.
   */
  queued: ProviderChatQueued[];
  /**
   * Очередь стоит: ход остановили или панель перезапускалась — сама она не
   * уйдёт, нужна кнопка «Отправить» (Ф13).
   */
  queueHeld: boolean;
  /**
   * Просьбы CLI о разрешении, ждущие человека («Разрешить правки» выключен).
   * Серверные: одни на все вкладки и телефон, ответ в одной снимает их везде.
   */
  permissions: ProviderChatPermission[];
  answerPermission: (askId: string, decision: 'allow' | 'deny') => Promise<void>;
  send: (text: string, attachments?: string[]) => Promise<void>;
  stop: () => Promise<void>;
  /** Убрать сообщение из очереди, пока оно не ушло. */
  cancelQueued: (queuedId: string) => Promise<void>;
  /** Отправить ждущее сообщение очереди. */
  sendQueued: (queuedId: string) => Promise<void>;
}

export function useProviderChatRun(chatId: string | undefined): ProviderChatRunState {
  const queryClient = useQueryClient();
  const [partial, setPartial] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [isSteerable, setIsSteerable] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [queued, setQueued] = useState<ProviderChatQueued[]>([]);
  const [queueHeld, setQueueHeld] = useState(false);
  const [permissions, setPermissions] = useState<ProviderChatPermission[]>([]);
  const abortRef = useRef<AbortController | undefined>(undefined);
  // Ответ идёт — следующее сообщение ставится в очередь; ref, чтобы второе
  // нажатие до перерисовки тоже знало об этом.
  const runningRef = useRef(false);
  runningRef.current = isRunning;
  const attachRef = useRef<((id: string) => Promise<void>) | undefined>(undefined);

  /** Ответ кончился: перечитываем переписку и сверяемся с сервером. */
  const settle = useCallback(
    async (id: string) => {
      void queryClient.invalidateQueries({ queryKey: providerChatKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: providerChatKeys.list });

      try {
        const status = await readProviderChatStatus(id);
        setIsRunning(status.isRunning);
        setIsSteerable(Boolean(status.steerable));
        setPartial(status.isRunning ? status.partial : '');
        setQueued(status.queued ?? []);
        setQueueHeld(Boolean(status.queueHeld));
        setPermissions(status.permissions ?? []);
        // Конец ответа отпустил очередь: сервер уже начал следующий ход —
        // подключаемся к нему, иначе его текст появился бы только после F5.
        if (status.isRunning) void attachRef.current?.(id);
      } catch {
        setIsRunning(false);
        setIsSteerable(false);
        setPartial('');
        setPermissions([]);
      }
    },
    [queryClient],
  );

  const attach = useCallback(
    async (id: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await openProviderChatStream(
          id,
          (event) => {
            if (event.type === 'delta') setPartial((prev) => prev + (event.text ?? ''));
            else if (event.type === 'error') setError(event.error);
            else if (event.type === 'steerable') setIsSteerable(true);
            else if (event.type === 'permissions') setPermissions(event.permissions ?? []);
            // Реплику подхватил идущий ход (В1) — она уже в переписке, и её видят
            // все вкладки, а не только та, что её отправила.
            else if (event.type === 'steered') {
              void queryClient.invalidateQueries({ queryKey: providerChatKeys.detail(id) });
            }
          },
          controller.signal,
        );
      } catch {
        // Обрыв потока — не потеря ответа: он пишется на сервере, и сверка ниже
        // покажет, чем всё кончилось.
      }

      if (controller.signal.aborted) return;
      // Поток кончился — вкладка больше ни к чему не подключена: по этой
      // ссылке отказ 409 решает, подхватывать ли идущий ход.
      if (abortRef.current === controller) abortRef.current = undefined;
      await settle(id);
    },
    [settle, queryClient],
  );

  attachRef.current = attach;

  /**
   * Подхватить ход, идущий на сервере: напечатанное к этому моменту берём из
   * статуса (поток шлёт только новые куски), дальше — поток. Хода уже нет —
   * просто сверяемся.
   */
  const followRunning = useCallback(
    async (id: string) => {
      try {
        const status = await readProviderChatStatus(id);
        if (!status.isRunning) return settle(id);
        setPartial(status.partial);
        setIsRunning(true);
        setIsSteerable(Boolean(status.steerable));
        setPermissions(status.permissions ?? []);
      } catch {
        return settle(id);
      }
      await attach(id);
    },
    [attach, settle],
  );

  // Открыли разговор — узнаём, не идёт ли по нему ответ прямо сейчас.
  useEffect(() => {
    setPartial('');
    setIsRunning(false);
    setIsSteerable(false);
    setError(undefined);
    setQueued([]);
    setQueueHeld(false);
    setPermissions([]);
    if (!chatId) return;

    let cancelled = false;
    void (async () => {
      try {
        const status = await readProviderChatStatus(chatId);
        if (cancelled) return;
        setQueued(status.queued ?? []);
        setQueueHeld(Boolean(status.queueHeld));
        if (!status.isRunning) return;
        setPartial(status.partial);
        setIsRunning(true);
        setIsSteerable(Boolean(status.steerable));
        setPermissions(status.permissions ?? []);
        void attach(chatId);
      } catch {
        // Разговора нет или сервер недоступен — показывать нечего.
      }
    })();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
      abortRef.current = undefined;
    };
  }, [chatId, attach]);

  const send = useCallback(
    async (text: string, attachments?: string[]) => {
      if (!chatId) return;

      // Ответ идёт: сообщение уходит в этот же ход, если у CLI есть вход посреди
      // ответа (В1), иначе ждёт его конца в очереди сервера. Идущий ход не
      // трогаем — ни индикатор, ни напечатанное.
      if (runningRef.current) {
        try {
          const reply = await sendProviderChatMessage(chatId, {
            text,
            ...(attachments?.length ? { attachments } : {}),
            queueIfBusy: true,
          });
          if ('queued' in reply) {
            setQueued((items) => [...items, reply.queued]);
            return;
          }
          if (reply.steered) {
            void queryClient.invalidateQueries({ queryKey: providerChatKeys.detail(chatId) });
            return;
          }
          // Ответ успел кончиться — сообщение ушло сразу, как обычное.
          setPartial('');
          void queryClient.invalidateQueries({ queryKey: providerChatKeys.detail(chatId) });
          await attach(chatId);
        } catch (cause) {
          setError(toErrorMessage(cause));
        }
        return;
      }

      setError(undefined);
      setIsRunning(true);
      setIsSteerable(false);
      try {
        await sendProviderChatMessage(chatId, {
          text,
          ...(attachments?.length ? { attachments } : {}),
        });
      } catch (cause) {
        setError(toErrorMessage(cause));
        // 409 — идёт прошлый ответ: индикатор и напечатанное не трогаем, а если
        // вкладка этот ход не видела (начат в другой вкладке или автоматом) —
        // подключаемся к нему. Гасим только ход, который так и не начался.
        if (isAnswerRunningRefusal(cause)) {
          const attached = abortRef.current && !abortRef.current.signal.aborted;
          if (!attached) await followRunning(chatId);
          return;
        }
        setIsRunning(false);
        return;
      }

      // Напечатанное прошлого хода стираем, только когда новый ход принят:
      // отказ не должен съесть текст идущего ответа.
      setPartial('');
      void queryClient.invalidateQueries({ queryKey: providerChatKeys.detail(chatId) });
      await attach(chatId);
    },
    [chatId, attach, followRunning, queryClient],
  );

  const stop = useCallback(async () => {
    if (!chatId) return;
    try {
      await stopProviderChat(chatId);
    } catch {
      // Гасить нечего либо сервер уже закрыл прогон — состояние сверит поток.
    }
  }, [chatId]);

  const cancelQueued = useCallback(
    async (queuedId: string) => {
      if (!chatId) return;
      setQueued((items) => items.filter((item) => item.id !== queuedId));
      try {
        await cancelProviderChatQueued(chatId, queuedId);
      } catch {
        // Не снялось на сервере — сверка по концу ответа вернёт его в список.
      }
    },
    [chatId],
  );

  const sendQueued = useCallback(
    async (queuedId: string) => {
      if (!chatId) return;
      setError(undefined);
      setIsRunning(true);
      setIsSteerable(false);
      setQueueHeld(false);
      setQueued((items) => items.filter((item) => item.id !== queuedId));
      try {
        await sendProviderChatQueued(chatId, queuedId);
      } catch (cause) {
        setError(toErrorMessage(cause));
        // Ход уже идёт (другая вкладка) — подключаемся; иначе сверка вернёт
        // очередь как есть.
        if (isAnswerRunningRefusal(cause)) return followRunning(chatId);
        setIsRunning(false);
        return settle(chatId);
      }
      setPartial('');
      void queryClient.invalidateQueries({ queryKey: providerChatKeys.detail(chatId) });
      await attach(chatId);
    },
    [chatId, attach, followRunning, settle, queryClient],
  );

  /**
   * Ответ на просьбу о разрешении. Карточка снимается сразу; не дошло (ход
   * кончился, ответили в другой вкладке) — ошибка показывается, а список сверит
   * событие сервера.
   */
  const answerPermission = useCallback(
    async (askId: string, decision: 'allow' | 'deny') => {
      if (!chatId) return;
      setPermissions((items) => items.filter((item) => item.id !== askId));
      try {
        await answerProviderChatPermission(chatId, askId, decision);
      } catch (cause) {
        setError(toErrorMessage(cause));
      }
    },
    [chatId],
  );

  return {
    partial,
    isRunning,
    isSteerable,
    ...(error ? { error } : {}),
    queued,
    queueHeld,
    permissions,
    answerPermission,
    send,
    stop,
    cancelQueued,
    sendQueued,
  };
}
