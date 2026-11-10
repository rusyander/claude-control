import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConfigView, SetConfigReply } from '@agentdeck/contracts/core/config';
import type {
  InboxCreateReply,
  InboxItem,
  InboxSearchReply,
  InboxSection,
} from '@agentdeck/contracts/core/inbox';
import {
  CORE_BOARD_KEY,
  coreGet,
  corePost,
  fetchNonce,
  newUuidv7,
  pageLoadId,
} from '@entities/CoreTask';
import { queryKeys } from '@shared/api/query-keys';
import { withInbox } from '../InboxSources/inboxSources.lib';
import { createBody, searchParams } from '../InboxSearch/inboxSearch.lib';
import { setPresetBody } from './entryPreset.lib';

/**
 * Ручки входящих доски (этап 12, I7): настройка ядра (ключ кэша общий с экранами настройки — один
 * ответ на все), запись раздела `inbox`, поиск по источнику и заведение выбранного. Каждая запись
 * — с числом страницы от ядра (доказательство человека); задачу ни одна не создаёт.
 */

/** Действующая настройка ядра с отпечатком — из неё строка над доской и окно источников. */
export function useInboxConfig() {
  return useQuery({
    queryKey: queryKeys.core.config,
    queryFn: () => coreGet<ConfigView>('/config'),
    retry: false,
    meta: { silentError: true },
  });
}

export interface SaveInboxInput {
  /** Настройка, от которой открыто окно: её отпечаток — сверка записи у ядра (409 — устарел). */
  view: ConfigView;
  section: InboxSection;
}

/** Запись раздела `inbox` (`set-config`, строгий суд); принятый документ сразу кладётся в кэш. */
export function useSaveInbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ view, section }: SaveInboxInput) => {
      const page = pageLoadId();
      const nonce = await fetchNonce(page);
      const { doc, baseDigest } = withInbox(view, section);
      return corePost<SetConfigReply>('/config', {
        cmdId: newUuidv7(),
        doc,
        baseDigest,
        proof: { nonce, page },
      });
    },
    // Отказ (409, суд ядра) окно показывает само, с «Перечитать», — общий тост его бы удвоил.
    meta: { silentError: true },
    onSuccess: (reply) => queryClient.setQueryData(queryKeys.core.config, reply.view),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.core.config }),
  });
}

/** Поиск по источнику: только чтение, запрос — параметром ручки поиска и больше нигде (P167). */
export function useInboxSearch() {
  return useMutation({
    mutationFn: ({ sourceId, q }: { sourceId: string; q: string }) =>
      coreGet<InboxSearchReply>('/inbox/search', undefined, searchParams(sourceId, q)),
    meta: { silentError: true },
  });
}

export interface InboxCreateInput {
  sourceId: string;
  items: InboxItem[];
  /** Ключ повтора: тот же после обрыва связи — ядро не заведёт второй раз. */
  cmdId: string;
}

/** Заведение выбранного во «Входящие» (`inbox-create`, класс human); после — доска перечитана. */
export function useInboxCreate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sourceId, items, cmdId }: InboxCreateInput) => {
      const page = pageLoadId();
      const nonce = await fetchNonce(page);
      return corePost<InboxCreateReply>(
        '/inbox',
        createBody(sourceId, items, { nonce, page }, cmdId),
      );
    },
    meta: { silentError: true },
    onSettled: () => queryClient.invalidateQueries({ queryKey: CORE_BOARD_KEY }),
  });
}

/** Смена пресета записи до старта (ход `set-preset`, класс human); отказ окно показывает само. */
export function useSetEntryPreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ entryId, preset }: { entryId: string; preset: string }) => {
      const page = pageLoadId();
      const nonce = await fetchNonce(page);
      return corePost<unknown>('/board/move', setPresetBody(entryId, preset, { nonce, page }));
    },
    meta: { silentError: true },
    onSettled: () => queryClient.invalidateQueries({ queryKey: CORE_BOARD_KEY }),
  });
}
