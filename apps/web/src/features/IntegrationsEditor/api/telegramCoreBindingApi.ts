import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConfigView, CoreConfig, SetConfigReply } from '@agentdeck/contracts/core/config';
import { coreGet, corePost, fetchNonce, newUuidv7, pageLoadId } from '@entities/CoreTask';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import {
  withTelegramOwner,
  withTelegramRepos,
  type TelegramCoreBindingView,
  type TelegramRepo,
} from '../model/telegramCoreBinding';

const BINDING_KEY = ['integrations', 'telegram', 'answers', 'core-binding'] as const;

/** Отпечаток чата бота ответов и признаёт ли его ядро — считает сервер панели. */
export function useTelegramCoreBinding(enabled: boolean) {
  return useQuery({
    queryKey: BINDING_KEY,
    queryFn: async () => {
      const { data } = await apiClient.get<TelegramCoreBindingView>(
        '/integrations/telegram/answers/core-binding',
      );
      return data;
    },
    enabled,
    retry: false,
  });
}

/**
 * Настройка ядра — для поля репозиториев `/task`. Свой запрос, а не `useCoreConfig` из CoreLaunch
 * (чужой срез фичам недоступен); ключ общий — запись любого окна обновляет оба.
 */
export function useTelegramCoreConfig(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.core.config,
    queryFn: () => coreGet<ConfigView>('/config'),
    enabled,
    retry: false,
  });
}

/**
 * `set-config` с правкой раздела `telegram`; пишет окно панели числом страницы — сервер это право
 * не получает (P187: настройка — только человек). `baseDigest` судит ядро: настройку изменили
 * после того вида, от которого собрана правка, — 409 `stale-digest`, не тихая перезапись.
 */
async function writeTelegram({ doc, baseDigest }: { doc: CoreConfig; baseDigest: string }) {
  const page = pageLoadId();
  const nonce = await fetchNonce(page);
  return corePost<SetConfigReply>('/config', {
    cmdId: newUuidv7(),
    doc,
    baseDigest,
    proof: { nonce, page },
  });
}

/**
 * Включить/выключить ответы ядру: `telegram.owner` — отпечаток или `null`. Черновика у
 * переключателя нет — правка собирается от только что прочитанной настройки.
 */
export function useSetTelegramCoreOwner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (owner: string | null) =>
      writeTelegram(withTelegramOwner(await coreGet<ConfigView>('/config'), owner)),
    // Отказ ядра показан строкой под переключателем — второй тост не нужен.
    meta: { successMessage: 'telegramAnswers.core.saved', silentError: true },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.core.config });
      await queryClient.invalidateQueries({ queryKey: BINDING_KEY });
    },
  });
}

/**
 * Репозитории записей `/task` (W2-D): `telegram.repos`, пустой список снимает поле. Правка — от
 * вида, который человек видел (`base`), НЕ от перечитанного: иначе чужая запись между чтением и
 * «Сохранить» тихо перетиралась бы; так ядро отвечает 409 и поле предлагает перечитать.
 */
export function useSetTelegramRepos() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ base, repos }: { base: ConfigView; repos: readonly TelegramRepo[] }) =>
      writeTelegram(withTelegramRepos(base, repos)),
    // Отказ ядра показан строкой под полем — второй тост не нужен.
    meta: { successMessage: 'telegramAnswers.core.reposSaved', silentError: true },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.core.config });
    },
  });
}
