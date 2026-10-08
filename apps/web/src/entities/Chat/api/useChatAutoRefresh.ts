import { useQueryClient, useQuery } from '@tanstack/react-query';
import { chatKeys } from './ChatApi.constants';
import { apiClient } from '@shared/api/client';
import { useRef, useEffect } from 'react';

/**
 * Как часто опрос отпечатка вправе перечитывать СПИСОК разговоров (мс).
 *
 * Основной повод для списка — наблюдатель за файлами: он точечный. Опрос здесь
 * оставлен подстраховкой на случай выключенного наблюдения, и десяти секунд ей
 * достаточно: в списке меняются превью, время и порядок, а не то, ради чего
 * человек смотрит на экран.
 */
export const LIST_REFRESH_MS = 10_000;

/**
 * Держать открытый разговор в актуальном состоянии — без F5.
 *
 * Панель владеет не каждым прогоном: тот же чат идёт из терминала, из
 * расширения редактора, из соседнего окна панели. Своего потока событий в таком
 * разговоре нет, и до появления этой страховки лента показывала снимок на
 * момент открытия — вопрос агента человек видел только после перезагрузки
 * страницы.
 *
 * Дорог тут не опрос, а перечитывание ленты, поэтому спрашиваем отпечаток
 * (одна `stat` на сервере) и трогаем ленту, только когда он изменился. Второй,
 * более быстрый канал — `/api/events` от наблюдателя за файлами; этот работает
 * и тогда, когда наблюдение выключено тумблером или поток оборван.
 */
export function useChatAutoRefresh(
  chatId: string | undefined,
  isRunning: boolean,
  /**
   * Связь с потоком потеряна. Прогон идёт, но его ход рисует уже не пузырь, а
   * история — значит, экономить на её перечитывании больше нельзя (см. ниже).
   */
  isStalled = false,
): void {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: chatKeys.version(chatId ?? ''),
    queryFn: async () => {
      const { data: version } = await apiClient.get<{ mtimeMs: number; size: number }>(
        `/chats/${chatId}/version`,
      );
      return version;
    },
    enabled: Boolean(chatId),
    // Пока идёт свой прогон, лента и так живёт потоком, но чужой ход виден
    // только отсюда — опрашиваем чаще, стоит это одной `stat`.
    refetchInterval: isRunning ? 2000 : 5000,
    // Вкладку свернули — опрашивать некому и незачем; вернулись к ней —
    // спрашиваем сразу, не дожидаясь очередного такта.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const stamp = data ? `${data.mtimeMs}:${data.size}` : undefined;
  const seen = useRef<string | undefined>(undefined);
  const listRefreshedAt = useRef(0);

  useEffect(() => {
    if (!chatId || !stamp) return;
    // Первый ответ — это то, что уже показано: перечитывать нечего.
    if (seen.current === undefined) {
      seen.current = stamp;
      return;
    }
    if (seen.current === stamp) return;
    seen.current = stamp;
    // Список чатов перечитываем не чаще, чем раз в `LIST_REFRESH_MS`.
    //
    // Тот же список инвалидирует наблюдатель за файлами — там это точечно и по
    // делу. Здесь же отпечаток меняется на КАЖДОМ шаге агента, то есть раз в
    // две секунды: два повода вместо одного, и каждый — полный ререндер списка
    // с пересчётом `visibleChats` и пульта детей. Совсем убрать нельзя, это
    // единственный канал, когда наблюдение выключено тумблером или его поток
    // оборван; поэтому оставляем как редкую подстраховку, а не как второй
    // основной источник. В списке меняются превью и время — им спешить некуда.
    const now = Date.now();
    if (now - listRefreshedAt.current >= LIST_REFRESH_MS) {
      listRefreshedAt.current = now;
      void queryClient.invalidateQueries({ queryKey: chatKeys.list });
    }
    // Пока идёт свой прогон, транскрипт меняется на каждом шаге агента, а ход
    // рисует поток — перечитывать ленту на каждый шаг незачем: это полная
    // страница сообщений раз в две секунды. Ленту перечитают по завершении.
    //
    // Но ровно на этой экономии и держался «висит бесконечно»: когда поток
    // замолкал, пузырь замирал на полуслове, а ленту не перечитывали до конца
    // прогона — которого могло не наступить. Потеряли связь — источник правды
    // снова транскрипт, и он должен доезжать сам, без F5.
    if (isRunning && !isStalled) return;
    void queryClient.invalidateQueries({ queryKey: chatKeys.messages(chatId) });
  }, [chatId, stamp, isRunning, isStalled, queryClient]);

  // Потеря связи перечитывает ленту НЕМЕДЛЕННО, не дожидаясь следующего
  // изменения отпечатка. Ждать нечего: ход этого прогона в показанном окне
  // отсутствует целиком — его всё это время рисовал поток, — а агент мог уже
  // всё дописать и замолчать. Без этого пузырь гаснет, а на его месте не
  // появляется ничего.
  useEffect(() => {
    if (!chatId || !isStalled) return;
    void queryClient.invalidateQueries({ queryKey: chatKeys.messages(chatId) });
  }, [chatId, isStalled, queryClient]);

  // Смена разговора начинает счёт заново — иначе первый же отпечаток нового
  // чата выглядел бы изменением и дёргал ленту сразу после открытия.
  useEffect(() => {
    seen.current = undefined;
  }, [chatId]);
}
