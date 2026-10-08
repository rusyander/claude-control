import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  getActiveProvider,
  pluginsModelOf,
  type SettingsSource,
} from '../../providers/registry.ts';
import type { ConfigProvider } from '../../providers/types/types.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';

/**
 * Отказ раздела, которого у активного CLI нет, — ДО запуска процесса и до
 * чтения чужого конфига.
 *
 * Без этой проверки маршрут работал «как у Claude» при любом CLI: `/api/plugins`
 * запускал `kimi plugin list --json` и читал каталог плагинов Claude, песочница
 * поднимала настоящий `claude`, а чат Cursor заводил разговор, который никто не
 * продолжит. Веб прятал эти разделы гейтом, но гейт — это клиент: телефон, агент
 * панели и прямой запрос его не проходят.
 *
 * Готовность берётся из карты возможностей провайдера (`capabilities`) — той же,
 * что гейтит страницы. Своего списка «кому можно» здесь нет: раздел, который
 * стал `ready` в каталоге, открывается и на сервере сам.
 */

/** Разделы с отказом на сервере. */
export type GuardedSection = 'chat' | 'sandbox' | 'panel-plugins';

const REFUSAL_CODE = {
  chat: 'provider-chat-unsupported',
  sandbox: 'sandbox-provider-unsupported',
  'panel-plugins': 'plugins-provider-unsupported',
} as const satisfies Record<GuardedSection, string>;

export interface SectionRefusal {
  error: 'provider_unsupported';
  message: string;
  messageCode: (typeof REFUSAL_CODE)[GuardedSection];
  params: { provider: string };
}

/**
 * Готов ли раздел у провайдера. Плагины Claude — отдельный случай: у Kimi Code,
 * OpenCode, Qwen Code и Codex раздел плагинов `ready`, но СВОЙ (`files`, другие
 * маршруты); `/api/plugins*` говорят только на языке `claude plugin …`.
 */
export function isSectionReady(provider: ConfigProvider, section: GuardedSection): boolean {
  if (section === 'panel-plugins') {
    return provider.capabilities.plugins === 'ready' && pluginsModelOf(provider) === 'panel';
  }
  return provider.capabilities[section] === 'ready';
}

/** Тело отказа для активного провайдера или undefined, если раздел у него есть. */
export function sectionRefusal(
  store: SettingsSource,
  section: GuardedSection,
): SectionRefusal | undefined {
  const provider = getActiveProvider(store);
  if (isSectionReady(provider, section)) return undefined;

  const code = REFUSAL_CODE[section];
  const params = { provider: provider.name };
  return {
    error: 'provider_unsupported',
    message: serverText(code, params),
    messageCode: code,
    params,
  };
}

/**
 * Отказ 409 в ответ, если раздела у активного CLI нет. Возвращает отправленный
 * ответ — обработчик отдаёт его как есть и дальше не идёт.
 */
export function refuseUnlessReady(
  store: SettingsSource,
  section: GuardedSection,
  reply: FastifyReply,
): FastifyReply | undefined {
  const refusal = sectionRefusal(store, section);
  return refusal ? reply.code(409).send(refusal) : undefined;
}

/**
 * Та же проверка хуком `preHandler` — для файла маршрутов, где отказывать
 * должен каждый обработчик: забыть строку в одном из восьми проще, чем в опциях.
 */
export function sectionGuard(store: SettingsSource, section: GuardedSection) {
  // Ранний ответ из async-хука — `return reply`, как велит документация Fastify.
  // Обработчик после отправленного ответа Fastify не зовёт и так (мутант без
  // `return` проверен: журнал CLI пуст), но явный возврат не держится на этой детали.
  return async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> =>
    refuseUnlessReady(store, section, reply);
}
