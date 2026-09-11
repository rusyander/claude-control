import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  Platform,
  PlatformActivationResult,
  PlatformAgentAnswer,
  PlatformAgentSession,
  PlatformApplyPlan,
  PlatformBridgeInfo,
  PlatformApplyResult,
  PlatformGatewayInfo,
  PlatformHealthRecord,
  PlatformProbeResult,
  PlatformRollbackResult,
  PlatformStatus,
  PlatformsInfo,
  PlatformSpendInfo,
} from '@agentdeck/contracts';
import { apiClient, LONG_TIMEOUTS } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

const path = (id: string, suffix = ''): string => `/platforms/${encodeURIComponent(id)}${suffix}`;

/**
 * Список приезжает ЦЕЛИКОМ — с активным контуром и разовым рассказом о переносе
 * — и целиком же лежит в кеше. Отбросить лишнее здесь, как делалось раньше,
 * значило бы завести второй запрос за активным контуром и получить два ответа
 * на один вопрос: список, где контур уже активен, и поле, где ещё нет.
 */
async function getPlatformsInfo(): Promise<PlatformsInfo> {
  const { data } = await apiClient.get<PlatformsInfo>('/platforms');
  return data;
}

async function getGateway(): Promise<PlatformGatewayInfo> {
  const { data } = await apiClient.get<PlatformGatewayInfo>('/platforms/gateway');
  return data;
}

async function restartGateway(): Promise<PlatformGatewayInfo> {
  const { data } = await apiClient.post<PlatformGatewayInfo>('/platforms/gateway/restart');
  return data;
}

/**
 * Сохранить контур. Ключ едет РЯДОМ с настройкой и только когда его тронули:
 * форма правки поля ключа не присылает вовсе, и сохранённый остаётся на месте.
 */
async function savePlatform(input: {
  platform: Platform;
  token?: string;
}): Promise<PlatformStatus> {
  const { data } = await apiClient.put<PlatformStatus>(path(input.platform.id), {
    settings: input.platform,
    ...(input.token === undefined ? {} : { token: input.token }),
  });
  return data;
}

async function checkPlatform(id: string): Promise<PlatformProbeResult> {
  const { data } = await apiClient.post<PlatformProbeResult>(path(id, '/check'));
  return data;
}

async function getApplyPlan(id: string): Promise<PlatformApplyPlan> {
  const { data } = await apiClient.get<PlatformApplyPlan>(path(id, '/apply'));
  return data;
}

async function applyPlatform(input: {
  id: string;
  targets: string[];
  overwrite?: string[];
  model?: string;
}): Promise<PlatformApplyResult> {
  const { data } = await apiClient.post<PlatformApplyResult>(path(input.id, '/apply'), {
    targets: input.targets,
    overwrite: input.overwrite ?? [],
    ...(input.model === undefined ? {} : { model: input.model }),
  });
  return data;
}

/** Снять применение: целиком либо точечно — одну строку журнала. */
async function disablePlatform(input: {
  id: string;
  targets?: string[];
}): Promise<PlatformRollbackResult> {
  const { data } = await apiClient.post<PlatformRollbackResult>(
    path(input.id, '/disable'),
    input.targets ? { targets: input.targets } : undefined,
  );
  return data;
}

/**
 * Сделать контур активным. Запрос ходит в сеть дважды (проба и пробный запрос
 * через свой же шлюз), поэтому таймаут — свой: общих 60 с не хватает контуру,
 * который думает над ответом, а оборванный браузером запрос выглядел бы как
 * «активация не удалась» при удавшейся активации.
 */
async function activatePlatform(id: string): Promise<PlatformActivationResult> {
  const { data } = await apiClient.post<PlatformActivationResult>(
    path(id, '/activate'),
    undefined,
    { timeout: LONG_TIMEOUTS.platformActivate },
  );
  return data;
}

/** Вернуть провайдер по умолчанию: применения снимаются, тумблер гаснет. */
async function deactivatePlatform(id: string): Promise<PlatformRollbackResult> {
  const { data } = await apiClient.post<PlatformRollbackResult>(path(id, '/deactivate'));
  return data;
}

async function dismissActivationNotice(): Promise<void> {
  await apiClient.delete('/platforms/activation-notice');
}

async function deletePlatform(id: string): Promise<void> {
  await apiClient.delete(path(id));
}

/**
 * Вопрос агенту контура. Ответ приходит ЛЮБЫМ исходом со статусом 200:
 * «агентов нет в лицензии компании» — это состояние карточки, а не сбой сети.
 */
async function askAgent(input: {
  id: string;
  agent: string;
  message: string;
  session?: string;
}): Promise<PlatformAgentAnswer> {
  const { data } = await apiClient.post<PlatformAgentAnswer>(
    path(input.id, '/agents/ask'),
    {
      agent: input.agent,
      message: input.message,
      ...(input.session ? { session: input.session } : {}),
    },
    // Свой таймаут обязателен: общие 60 с короче бюджета сервера (125 с), и
    // ответ агента длиннее минуты браузер обрывал бы ложной ошибкой, пока
    // контур доводит прогон и списывает его с ключа.
    { timeout: LONG_TIMEOUTS.agentAsk },
  );
  return data;
}

async function getAgentSession(id: string, sessionId: string): Promise<PlatformAgentSession> {
  const { data } = await apiClient.get<PlatformAgentSession>(
    path(id, `/agents/sessions/${encodeURIComponent(sessionId)}`),
  );
  return data;
}

async function resetAgentSession(input: { id: string; sessionId: string }): Promise<void> {
  await apiClient.delete(path(input.id, `/agents/sessions/${encodeURIComponent(input.sessionId)}`));
}

/**
 * Расход контура по дням. Как и список карточек, наружу этот запрос НЕ ходит:
 * остаток бюджета у контура не спросить, всё считается по своему учёту.
 */
async function getSpend(id: string): Promise<PlatformSpendInfo> {
  const { data } = await apiClient.get<PlatformSpendInfo>(path(id, '/spend'));
  return data;
}

/** Снять отметку «бюджет исчерпан» — только по слову человека, см. маршрут. */
async function clearExhausted(id: string): Promise<PlatformSpendInfo> {
  const { data } = await apiClient.delete<PlatformSpendInfo>(path(id, '/spend/exhausted'));
  return data;
}

/** Переходник MCP: одна ручка на три действия — узнать, подключить, убрать. */
async function getBridge(): Promise<PlatformBridgeInfo> {
  const { data } = await apiClient.get<PlatformBridgeInfo>('/platforms/mcp/connect');
  return data;
}

async function connectBridge(): Promise<PlatformBridgeInfo> {
  const { data } = await apiClient.post<PlatformBridgeInfo>('/platforms/mcp/connect');
  return data;
}

async function disconnectBridge(): Promise<PlatformBridgeInfo> {
  const { data } = await apiClient.delete<PlatformBridgeInfo>('/platforms/mcp/connect');
  return data;
}

/**
 * Сбросить всё, чего касается запись контура в чужие файлы.
 *
 * Список длиннее, чем кажется с первого взгляда, и в этом суть: контур пишет не
 * в свой раздел, а в переменные окружения CLI и в настройки панели (управляемый
 * профиль эндпоинта). Не сбросив их, панель показывала бы состояние ДО записи в
 * трёх разных разделах сразу.
 */
function invalidateApplied(queryClient: QueryClient, id: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.platforms });
  void queryClient.invalidateQueries({ queryKey: queryKeys.platformApply(id) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
  void queryClient.invalidateQueries({ queryKey: queryKeys.env });
  void queryClient.invalidateQueries({ queryKey: queryKeys.providerEnv });
  void queryClient.invalidateQueries({ queryKey: queryKeys.history });
  void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
}

/**
 * Контуры с масками ключей и итогом последней пробы. В сеть этот запрос НЕ
 * ходит: сервер только читает настройки, — поэтому его можно звать при каждом
 * открытии раздела, а живая проверка остаётся отдельной кнопкой.
 */
export function usePlatforms() {
  return useQuery({
    queryKey: queryKeys.platforms,
    queryFn: getPlatformsInfo,
    select: (info: PlatformsInfo) => info.platforms,
  });
}

/**
 * То же самое, но целиком: активный контур и рассказ о переносе. Запрос тот же
 * — react-query держит один ответ под одним ключом, и раздел с карточками не
 * ходит на сервер дважды.
 */
export function usePlatformsInfo() {
  return useQuery({ queryKey: queryKeys.platforms, queryFn: getPlatformsInfo });
}

/**
 * Состояние локального шлюза. Отдельный запрос от списка: слушатель один на все
 * контуры, и его порт с адресами — не свойство конкретного контура.
 */
export function usePlatformGateway() {
  return useQuery({ queryKey: queryKeys.platformGateway, queryFn: getGateway });
}

/**
 * Поднять или погасить слушатель ПО СОХРАНЁННОЙ НАСТРОЙКЕ. Своих параметров у
 * маршрута нет: настройка правится общим PATCH, здесь применяется уже
 * сохранённое.
 */
export function useRestartGateway() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: restartGateway,
    onSuccess: (info) => {
      queryClient.setQueryData(queryKeys.platformGateway, info);
      // Поднявшийся шлюз меняет `ready` в плане применения каждого контура:
      // без сброса кнопка «Применить» осталась бы заблокированной у живого шлюза.
      void queryClient.invalidateQueries({ queryKey: queryKeys.platforms });
    },
  });
}

/** Сохранить контур целиком (и ключ, если его тронули). */
export function useSavePlatform() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: savePlatform,
    onSuccess: (_status, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.platforms });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.platformApply(variables.platform.id),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.platformGateway });
    },
  });
}

/**
 * Дата последнего успеха живёт по тому же правилу, что и на сервере: неудачная
 * проба её не стирает. Иначе карточка теряла бы «а три часа назад отвечал» до
 * перезагрузки списка.
 */
function lastOkPatch(
  fresh: PlatformHealthRecord,
  previous: PlatformHealthRecord | undefined,
): { lastOkAt?: string } {
  if (fresh.outcome === 'ok') return { lastOkAt: fresh.checkedAt };
  if (previous?.lastOkAt) return { lastOkAt: previous.lastOkAt };
  return {};
}

/**
 * Живая проба. Ответ никогда не отказ: недоступный контур — это результат с
 * причиной. Итог кладём в кеш списка сами — он переживает F5 на сервере, но
 * перезапрашивать весь список ради одной карточки незачем.
 */
export function useCheckPlatform() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: checkPlatform,
    onSuccess: (health, id) => {
      queryClient.setQueryData<PlatformsInfo>(queryKeys.platforms, (info) =>
        info
          ? {
              ...info,
              platforms: info.platforms.map((item) =>
                item.platform.id === id
                  ? {
                      ...item,
                      // Дата последнего успеха живёт по тому же правилу, что и
                      // на сервере: неудачная проба её не стирает. Иначе
                      // карточка теряла бы «а три часа назад отвечал» до
                      // перезагрузки списка.
                      health: { ...health, ...lastOkPatch(health, item.health) },
                    }
                  : item,
              ),
            }
          : info,
      );
      // Проба уточняет возможности контура — значит и то, что панель считает
      // применимым.
      void queryClient.invalidateQueries({ queryKey: queryKeys.platformApply(id) });
    },
  });
}

/**
 * Предпросмотр применения: что и куда ляжет, что уже занято, что панель уже
 * писала и что человек правил после неё. Ни одной записи здесь не происходит.
 */
export function usePlatformApplyPlan(id: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.platformApply(id),
    queryFn: () => getApplyPlan(id),
    enabled: (options.enabled ?? true) && id !== '',
  });
}

/** Записать контур в названные цели. */
export function useApplyPlatform() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: applyPlatform,
    onSuccess: (_result, variables) => invalidateApplied(queryClient, variables.id),
  });
}

/**
 * Снять применение: файлы возвращаются в исходный вид, управляемый профиль
 * удаляется. Сам контур остаётся включённым — это разные решения человека.
 */
export function useDisablePlatform() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: disablePlatform,
    onSuccess: (_result, variables) => invalidateApplied(queryClient, variables.id),
  });
}

/**
 * Сделать контур активным.
 *
 * Сбрасывается не только карточка: активация СНИМАЕТ применения прежнего
 * контура — то есть меняет переменные окружения CLI, управляемый профиль в
 * настройках и историю правок. Прежний контур назван в ответе, и его
 * предпросмотр применения сбрасывается отдельно: иначе он продолжал бы
 * показывать записанное, которого в файлах уже нет.
 */
export function useActivatePlatform() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: activatePlatform,
    onSuccess: (result, id) => {
      invalidateApplied(queryClient, id);
      if (result.previousPlatformId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.platformApply(result.previousPlatformId),
        });
      }
    },
    // Отказ перечитывается ТАК ЖЕ. Сервер возвращает состояние к прежнему сам,
    // но «прежнее» — это его состояние, а не наш снимок: активацию мог увести
    // другой вкладкой или телефоном, и тогда отказ означает, что экран устарел
    // весь. Оставить его как есть — значит показывать вчерашнюю картину до F5.
    onError: (_error, id) => invalidateApplied(queryClient, id),
  });
}

/**
 * Вернуть провайдер по умолчанию. Один маршрут на две кнопки — на карточке
 * контура и в строке провайдера: «вернуть как было» это одно действие.
 */
export function useDeactivatePlatform() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deactivatePlatform,
    onSuccess: (_result, id) => invalidateApplied(queryClient, id),
  });
}

/**
 * Закрыть рассказ о переносе. Разовый: сервер стирает его у себя, и второй раз
 * он не приедет — иначе он висел бы на экране у человека, который его прочитал.
 */
export function useDismissActivationNotice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: dismissActivationNotice,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.platforms }),
  });
}

/** Удалить контур: настройка, ключ и след пробы уходят вместе с применением. */
export function useDeletePlatform() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deletePlatform,
    onSuccess: (_result, id) => invalidateApplied(queryClient, id),
  });
}

/**
 * Спросить агента контура.
 *
 * Мутация, а не запрос: вызов агента тратит деньги ключа и пишется в его
 * историю — повторить его «на всякий случай» при перерисовке нельзя. Ответ
 * всегда 200 с исходом внутри, поэтому `onError` здесь ловит только беду с
 * самой панелью.
 */
export function useAskAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: askAgent,
    // Сессию перечитываем ПОСЛЕ хода: она заводится на контуре только вместе с
    // первым удачным ходом, и прочитанная до него «пустая» переписка иначе
    // осталась бы на экране навсегда — рядом с настоящим ответом агента.
    onSuccess: (_answer, variables) => {
      if (!variables.session) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.platformAgentSession(variables.id, variables.session),
      });
    },
  });
}

/**
 * Переписка сессии у КОНТУРА. Своей копии панель не держит — она разошлась бы
 * с той историей, из которой агент на самом деле отвечает.
 */
export function useAgentSession(id: string, sessionId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.platformAgentSession(id, sessionId),
    queryFn: () => getAgentSession(id, sessionId),
    enabled: enabled && id !== '' && sessionId !== '',
  });
}

/** Забыть сессию у контура: после сброса агент начинает разговор с нуля. */
export function useResetAgentSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: resetAgentSession,
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.platformAgentSession(variables.id, variables.sessionId),
      });
    },
  });
}

/**
 * Расход контура по дням. Спрашивается только там, где его рисуют: в карточке
 * итог за период уже есть — он приезжает вместе со списком.
 */
export function usePlatformSpend(id: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.platformSpend(id),
    queryFn: () => getSpend(id),
    enabled: (options.enabled ?? true) && id !== '',
  });
}

/**
 * Снять отметку «бюджет исчерпан». Сбрасываем и список карточек: итог по
 * бюджету едет в нём, и карточка иначе продолжала бы утверждать отказ.
 */
export function useClearExhausted() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: clearExhausted,
    onSuccess: (info) => {
      queryClient.setQueryData(queryKeys.platformSpend(info.platformId), info);
      void queryClient.invalidateQueries({ queryKey: queryKeys.platforms });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
  });
}

/** Зарегистрирован ли переходник контура в конфигурации активного CLI. */
export function usePlatformBridge() {
  return useQuery({ queryKey: queryKeys.platformMcp, queryFn: getBridge });
}

/**
 * Подключить или убрать переходник. Запись уходит в конфигурацию CLI, поэтому
 * сбрасывается и список MCP-серверов: раздел «MCP» показывает тот же файл.
 */
export function useConnectPlatformBridge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connect: boolean) => (connect ? connectBridge() : disconnectBridge()),
    onSuccess: (info) => {
      queryClient.setQueryData(queryKeys.platformMcp, info);
      void queryClient.invalidateQueries({ queryKey: queryKeys.mcp });
    },
  });
}
