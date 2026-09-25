import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentEnvironment, EnvItemKind } from '@agentdeck/contracts/portable-env';
import {
  PANEL_CANON_PROVIDER,
  type EnvSubscription,
  type SubscriptionApplyAnswer,
  type SubscriptionDriftAnswer,
  type SubscriptionDriftPlan,
  type SubscriptionDriftResolution,
  type SubscriptionSyncPlan,
  type SubscriptionsAnswer,
} from '@agentdeck/contracts/portable-subscribe';
import type { CarryApplyAnswer, CarryPlan } from '@agentdeck/contracts/portable-carry';
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
  return useMutation({ meta: { silentError: true }, mutationFn: postPlan });
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
    meta: { silentError: true },
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
    meta: { silentError: true },
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

// Подписка: канон — источник, чужой CLI — его проекция (П5.1, П5.2).
//
// Источник НИ В ОДИН из шести запросов не передаётся. Канон подписки —
// собственная среда панели, и добавить сюда выбранный на экране источник
// значило бы сделать подписку вторым переносом, у которого истин столько же,
// сколько CLI на машине.

/** Адрес подписки: цель на уровне. Больше ничем две подписки не отличаются. */
export interface SubscriptionAddress extends PortabilityLevel {
  target: string;
}

async function getSubscriptions(): Promise<SubscriptionsAnswer> {
  const { data } = await apiClient.get<SubscriptionsAnswer>('/portability/subscriptions');
  return data;
}

/**
 * Все подписки панели — то, с чем экран ОТКРЫВАЕТСЯ.
 *
 * Обычный запрос списком, а не по выбранной цели: маршрут отдаёт их разом, и
 * человек, переключающий цель, не должен ждать сети ради ответа, который уже
 * лежит в кэше.
 */
export function useSubscriptions() {
  return useQuery({
    queryKey: queryKeys.portabilitySubscriptions,
    queryFn: getSubscriptions,
  });
}

async function putSubscription(
  request: SubscriptionAddress & { layers: readonly EnvItemKind[] },
): Promise<{ subscription: EnvSubscription }> {
  const { data } = await apiClient.put<{ subscription: EnvSubscription }>(
    '/portability/subscription',
    request,
  );
  return data;
}

/**
 * Подписать цель на слои — и отписать ею же, пустым списком.
 *
 * Отписка ничего у цели не удаляет: подписка её файлами не владела, она
 * обещала их обновлять. Память о спроецированном сохраняется, поэтому повторная
 * подписка не объявит новым каждый файл, который панель уже писала.
 */
export function useSaveSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: putSubscription,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.portabilitySubscriptions });
    },
  });
}

async function deleteSubscription(address: SubscriptionAddress): Promise<{ ok: boolean }> {
  const { data } = await apiClient.delete<{ ok: boolean }>('/portability/subscription', {
    params: { target: address.target, ...levelParams(address) },
  });
  return data;
}

/**
 * Забыть подписку целиком — вместе с памятью о спроецированном. Файлы цели
 * остаются такими, какими их оставили: панель перестаёт их обновлять, а не
 * стирает.
 */
export function useForgetSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: deleteSubscription,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.portabilitySubscriptions });
    },
  });
}

async function postSubscriptionPlan(
  address: SubscriptionAddress,
): Promise<{ plan: SubscriptionSyncPlan }> {
  const { data } = await apiClient.post<{ plan: SubscriptionSyncPlan }>(
    '/portability/subscription/plan',
    address,
  );
  return data;
}

/**
 * План пересборки: что разошлось с каноном и что из-за этого будет записано.
 *
 * Мутация по той же причине, что и план переноса: сервер ничего не пишет, но
 * считает план НАСТОЯЩЕЙ записью адаптеров по временным копиям, и тянуть это
 * фоном при каждом открытии страницы было бы неверно понятым «только чтением».
 */
export function usePlanSubscription() {
  return useMutation({ meta: { silentError: true }, mutationFn: postSubscriptionPlan });
}

async function postSubscriptionApply(
  request: SubscriptionAddress & { fingerprint: string },
): Promise<SubscriptionApplyAnswer> {
  const { data } = await apiClient.post<SubscriptionApplyAnswer>(
    '/portability/subscription/apply',
    request,
  );
  return data;
}

/**
 * Пересобрать разошедшееся. Пишет тот же `applyTransfer`, что и разовый
 * перенос, — с теми же резервными копиями и тем же откатом при провале.
 *
 * После успеха устаревает не только список подписок, но и паспорт ЦЕЛИ: в неё
 * только что записали, и прежний паспорт говорил бы о среде, которой уже нет.
 */
export function useApplySubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { silentError: true },
    mutationFn: postSubscriptionApply,
    onSuccess: (_answer, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.portabilitySubscriptions });
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

/** Адрес исхода: подписка плюс файл и то, что с ним решили сделать (П5.2). */
export interface DriftAddress extends SubscriptionAddress {
  filePath: string;
  resolution: SubscriptionDriftResolution;
}

async function postDriftPlan(address: DriftAddress): Promise<{ plan: SubscriptionDriftPlan }> {
  const { data } = await apiClient.post<{ plan: SubscriptionDriftPlan }>(
    '/portability/subscription/drift/plan',
    address,
  );
  return data;
}

/**
 * Что сделает выбранный исход расхождения — до того, как он сделан.
 *
 * Отдельная пара «план → применение», а не поле общей пересборки: исход
 * разбирает ОДИН файл, и показать его вместе с пересборкой значило бы показать
 * два разных решения одним диффом.
 */
export function usePlanDrift() {
  return useMutation({ meta: { silentError: true }, mutationFn: postDriftPlan });
}

async function postDriftApply(
  request: DriftAddress & { fingerprint?: string },
): Promise<SubscriptionDriftAnswer> {
  const { data } = await apiClient.post<SubscriptionDriftAnswer>(
    '/portability/subscription/drift/apply',
    request,
  );
  return data;
}

/**
 * Сделать выбранное. `fingerprint` — того плана, который человеку ПОКАЗАЛИ;
 * у `unsubscribe` его нет, и это не упущение: этот исход не трогает у цели ни
 * одного байта, показывать в нём нечего.
 *
 * Паспорт цели устаревает у двух исходов из трёх, канон панели — у одного:
 * `canon` пишет в файлы САМОЙ панели, и после него устарел паспорт источника
 * канона, а не цели.
 */
export function useApplyDrift() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: postDriftApply,
    onSuccess: (answer, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.portabilitySubscriptions });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.portabilityPassport(
          answer.resolution === 'canon' ? PANEL_CANON_PROVIDER : variables.target,
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
  return useMutation({ meta: { silentError: true }, mutationFn: postProbe });
}

/**
 * Незакрытая работа, которую панель предлагает перенести к новому CLI (П6.1).
 *
 * Запрос за ресурсом, а не мутация: список ничего не заводит и не запускает —
 * он только читает разговоры и считает по ним предохранители. Свежесть нужна
 * настоящая (разговор мог закрыться минуту назад), поэтому кэш здесь короткий.
 */
export function useCarryPlan() {
  return useQuery({
    queryKey: queryKeys.portabilityCarry,
    queryFn: async (): Promise<CarryPlan> => {
      const { data } = await apiClient.get<CarryPlan>('/portability/carry');
      return data;
    },
    staleTime: 15_000,
  });
}

async function postCarryApply(keys: string[]): Promise<CarryApplyAnswer> {
  const { data } = await apiClient.post<CarryApplyAnswer>('/portability/carry/apply', { keys });
  return data;
}

/**
 * Перенести выбранное. Список после этого обязан перечитаться: перенесённый
 * разговор перестаёт быть кандидатом (его опора уже отмечена), а у цели
 * появился новый — и он, в свою очередь, кандидатом не является.
 */
export function useApplyCarry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: postCarryApply,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.portabilityCarry });
    },
  });
}
