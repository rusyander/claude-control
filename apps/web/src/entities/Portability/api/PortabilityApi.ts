import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentEnvironment } from '@agentdeck/contracts/portable-env';
import type { FidelityAnswer } from '@agentdeck/contracts/portable-fidelity';
import type { ProbeAnswer } from '@agentdeck/contracts/portable-probe';
import type {
  TransferApplyAnswer,
  TransferPlan,
  TransferRevertAnswer,
  TransferStateAnswer,
} from '@agentdeck/contracts/portable-transfer';
import { parseAgentEnvironment } from '@agentdeck/contracts/portable-env-schema';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

/**
 * Уровень, на котором открыт экран: дом или проект.
 *
 * Едет ВО ВСЕ четыре запроса и во все ключи кэша. Молчаливого умолчания здесь
 * нет намеренно: уровень выбирает человек, и «по умолчанию дом» после
 * переключения на проект показал бы ему домашний паспорт из кэша под заголовком
 * проекта.
 */
export interface PortabilityLevel {
  scope: 'global' | 'project';
  /** Идентификатор проекта из реестра панели; пуст на глобальном уровне. */
  project?: string;
}

/** Уровень в параметрах запроса. Пустой проект не отправляется вовсе. */
function levelParams(level: PortabilityLevel): Record<string, string> {
  return { scope: level.scope, ...(level.project ? { project: level.project } : {}) };
}

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

async function getFidelity(
  provider: string,
  target: string,
  level: PortabilityLevel,
): Promise<FidelityAnswer> {
  const { data } = await apiClient.get<FidelityAnswer>('/portability/fidelity', {
    params: { provider, target, ...levelParams(level) },
  });
  return data;
}

/**
 * Отчёт верности переноса «источник → цель». Запрашивается ДО всякого
 * применения: строка «работает только при запуске через панель» обязана быть
 * видна человеку раньше, чем он решится переносить.
 *
 * Цель не выбрана — запроса нет вовсе (`enabled`), а не запрос «куда-нибудь»:
 * отчёт о цели по умолчанию отвечал бы на вопрос, которого не задавали.
 */
export function useFidelityReport(provider: string, target: string, level: PortabilityLevel) {
  return useQuery({
    queryKey: queryKeys.portabilityFidelity(provider, target, level.scope, level.project),
    queryFn: () => getFidelity(provider, target, level),
    enabled: Boolean(provider && target) && (level.scope === 'global' || Boolean(level.project)),
  });
}

/** Пара «источник → цель» на одном уровне: всё, чем три шага переноса отличаются. */
interface TransferPair extends PortabilityLevel {
  provider: string;
  target: string;
}

async function getTransferState(pair: TransferPair): Promise<TransferStateAnswer> {
  const { data } = await apiClient.get<TransferStateAnswer>('/portability/transfer', {
    params: pair,
  });
  return data;
}

async function postPlan(pair: TransferPair): Promise<TransferPlan> {
  const { data } = await apiClient.post<TransferPlan>('/portability/plan', pair);
  return data;
}

async function postApply(
  pair: TransferPair & { fingerprint: string },
): Promise<TransferApplyAnswer> {
  const { data } = await apiClient.post<TransferApplyAnswer>('/portability/apply', pair);
  return data;
}

async function postRevert(
  pair: TransferPair & { confirm: readonly string[] },
): Promise<TransferRevertAnswer> {
  const { data } = await apiClient.post<TransferRevertAnswer>('/portability/revert', pair);
  return data;
}

/**
 * След применённого переноса — то, с чем страница ОТКРЫВАЕТСЯ.
 *
 * Обычный запрос, а не память вкладки: человек, вернувшийся к экрану на
 * следующий день, обязан увидеть кнопку отмены. Держи мы след только в
 * состоянии компонента, F5 оставлял бы его с перенесённой средой и без единого
 * способа её вернуть — ровно та неизвестная цена ошибки, из-за которой первую
 * кнопку не нажимают.
 */
export function useTransferState(provider: string, target: string, level: PortabilityLevel) {
  return useQuery({
    queryKey: queryKeys.portabilityTransfer(provider, target, level.scope, level.project),
    queryFn: () => getTransferState({ provider, target, ...level }),
    enabled: Boolean(provider && target) && (level.scope === 'global' || Boolean(level.project)),
  });
}

/**
 * План переноса. Мутация, хотя сервер ничего не пишет: это не ресурс, который
 * можно тянуть фоном при каждом открытии страницы, — план выполняет настоящие
 * операции адаптеров по временным копиям и считается только по нажатию.
 */
export function usePlanTransfer() {
  return useMutation({ mutationFn: postPlan });
}

/**
 * Применение плана. `fingerprint` — того плана, который человеку ПОКАЗАЛИ:
 * сервер сверяет его дважды и без показа отвечает 409.
 *
 * После успеха обновляется и след (появилась кнопка отмены), и отчёт верности:
 * файлы цели теперь другие, и прежний отчёт говорил бы о среде, которой уже нет.
 */
export function useApplyTransfer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: postApply,
    onSuccess: (_answer, variables) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.portabilityTransfer(
          variables.provider,
          variables.target,
          variables.scope,
          variables.project,
        ),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.portabilityFidelity(
          variables.provider,
          variables.target,
          variables.scope,
          variables.project,
        ),
      });
      // Паспорт ЦЕЛИ тоже устарел: в неё только что записали. Паспорт источника
      // перенос не трогает.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.portabilityPassport(
          variables.target,
          variables.scope,
          variables.project,
        ),
      });
    },
  });
}

/**
 * Отмена переноса. `confirm` — файлы, которые человек правил после переноса и
 * всё же велел вернуть: без его слова они не трогаются.
 */
export function useRevertTransfer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: postRevert,
    onSuccess: (_answer, variables) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.portabilityTransfer(
          variables.provider,
          variables.target,
          variables.scope,
          variables.project,
        ),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.portabilityFidelity(
          variables.provider,
          variables.target,
          variables.scope,
          variables.project,
        ),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.portabilityPassport(
          variables.target,
          variables.scope,
          variables.project,
        ),
      });
    },
  });
}

/** Что нужно пробе: цель и уровень. Источник ей не нужен — она про ЦЕЛЬ. */
interface ProbeRequest {
  target: string;
  scope: 'global' | 'project';
}

async function postProbe(request: ProbeRequest): Promise<ProbeAnswer> {
  const { data } = await apiClient.post<ProbeAnswer>('/portability/probe', request);
  return data;
}

/**
 * Приёмочная проба (П2.4). Мутация, и не потому что сервер что-то пишет в дом
 * человека — он его не трогает вовсе, — а потому что маршрут ЗАПУСКАЕТ чужой
 * процесс. Запросом за ресурсом это означало бы, что открытая вкладка сама
 * решает, когда поднять целевой CLI, и повторяет это при каждом обновлении.
 *
 * Ответ никуда не складывается: отчёт пробы — измерение МОМЕНТА, и показанный
 * из кэша на следующий день он говорил бы о переносе, которого уже нет.
 */
export function useRunProbe() {
  return useMutation({ mutationFn: postProbe });
}
