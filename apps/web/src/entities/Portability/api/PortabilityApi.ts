import { useQuery } from '@tanstack/react-query';
import type { AgentEnvironment } from '@agentdeck/contracts/portable-env';
import { parseAgentEnvironment } from '@agentdeck/contracts/portable-env-schema';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import type { PortabilityLevel } from './PortabilityApi.types';
import { levelParams } from '../lib/levelParams';

/**
 * Паспорт среды одного провайдера.
 *
 * Ответ разбирается СХЕМОЙ канона, а не берётся на веру: паспорт мог быть снят
 * сервером другой версии, и поле, сменившее смысл, привело бы к экрану, который
 * уверенно показывает не ту среду. Схема отказывает закрыто — лучше «паспорт не
 * прочитан» с причиной, чем правдоподобная картинка.
 */
async function getPassport(provider: string, level: PortabilityLevel): Promise<AgentEnvironment> {
  const { data } = await apiClient.get<unknown>('/portability/passport', {
    params: { ...(provider ? { provider } : {}), ...levelParams(level) },
  });
  return parseAgentEnvironment(data);
}

/**
 * Паспорт среды. Обычный запрос: сервер только читает файлы, так что открытие
 * страницы ничего не меняет и ни одного чужого CLI не запускает.
 */
export function usePortabilityPassport(provider: string, level: PortabilityLevel) {
  return useQuery({
    queryKey: queryKeys.portabilityPassport(provider, level.scope, level.project),
    queryFn: () => getPassport(provider, level),
    // Уровень проекта без выбранного проекта — не запрос «куда-нибудь»: сервер
    // на него отвечает 400, и спрашивать его ради этого незачем.
    enabled: level.scope === 'global' || Boolean(level.project),
  });
}
