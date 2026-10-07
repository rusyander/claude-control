import type { LocalConnectInfo } from '@agentdeck/contracts/local-models';
import {
  PLATFORM_ASSISTANT_CONSUMER,
  foreignConsumerId,
} from '@agentdeck/contracts/platform-consumers';
import type { LocalMessageCode } from '@agentdeck/contracts/server-messages';
import { localError } from './errors.ts';

/**
 * Агенты панели на локальной модели — через КОНТУР, а не своей обвязкой.
 *
 * Контур уже умеет ровно то, что тут нужно: отдать адрес модели окружению
 * одного прогона (чат, группы, тесты, ассистент), не записав ни строки в
 * `~/.claude`; проверить связь и вызов инструментов пробным запросом; показать в
 * шапке чата, куда идёт работа; вернуть всё одной кнопкой. Ollama говорит на
 * Anthropic Messages сам, и пресет `ollama` шлёт запросы Claude Code к нему без
 * перевода. Своя вторая обвязка разошлась бы с этой на первой же правке.
 *
 * Контур заводится и включается через ТЕ ЖЕ маршруты, что и мастер контура:
 * проверки тела, транзакция активации и проба проходят и здесь.
 */

export const LOCAL_PLATFORM_ID = 'local-ollama';
/** Ключ-заглушка: Ollama ключ не проверяет, а контур без ключа прогон не поведёт. */
export const LOCAL_PLATFORM_TOKEN = 'ollama-local-key';

export interface InjectAnswer {
  status: number;
  body: unknown;
}
export type Inject = (request: {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  url: string;
  payload?: unknown;
}) => Promise<InjectAnswer>;

interface PlatformsInfoLite {
  activePlatformId: string;
  platforms: { platform: { id: string; title: string; defaultModel: string } }[];
}

function reasonOf(answer: InjectAnswer): string {
  // Маршруты контура отвечают `{code, message}` (проверка тела), прочие — `{error}`.
  const body = answer.body as { error?: string; message?: string } | undefined;
  return body?.message ?? body?.error ?? `HTTP ${answer.status}`;
}

function fail(code: LocalMessageCode, step: string, answer: InjectAnswer): Error {
  const reason = reasonOf(answer);
  return localError(code, `${step}: ${reason}`, { reason });
}

export function localPlatformSettings(input: {
  baseUrl: string;
  model: string;
  title: string;
  consumers: string[];
}): Record<string, unknown> {
  return {
    id: LOCAL_PLATFORM_ID,
    title: input.title,
    driver: 'ollama',
    // Адрес с версией: так его ждёт пресет `ollama` (`/v1`), а путь Anthropic
    // шлюз строит сам.
    baseUrl: `${input.baseUrl.replace(/\/$/, '')}/v1`,
    enabled: true,
    mode: 'required',
    // Схема сохранения контура требует эти поля без умолчаний (мастер шлёт их
    // всегда); без них «Отдать агентам» ловил 400. Файлами контур не применяется
    // — только окружением прогона, поэтому целей и проектов нет.
    targets: [],
    projectPaths: [],
    caCertPath: '',
    capabilities: ['models', 'chat', 'client-tools'],
    consumers: input.consumers,
    defaultModel: input.model,
  };
}

/** Кому отдать маршрут: все прогоны панели и Qwen Code, если контур его принимает. */
export const LOCAL_CONSUMERS = [PLATFORM_ASSISTANT_CONSUMER, 'chat', 'groups', 'tests'];

export async function describeConnect(inject: Inject): Promise<LocalConnectInfo> {
  const answer = await inject({ method: 'GET', url: '/api/platforms' });
  if (answer.status >= 400) return { configured: false, active: false, model: '' };
  const info = answer.body as PlatformsInfoLite;
  const own = info.platforms.find((item) => item.platform.id === LOCAL_PLATFORM_ID);
  const other =
    info.activePlatformId && info.activePlatformId !== LOCAL_PLATFORM_ID
      ? info.platforms.find((item) => item.platform.id === info.activePlatformId)
      : undefined;
  return {
    configured: Boolean(own),
    active: info.activePlatformId === LOCAL_PLATFORM_ID,
    model: own?.platform.defaultModel ?? '',
    ...(other ? { otherActive: other.platform.title } : {}),
  };
}

/**
 * Завести (или обновить) контур локальной модели и сделать его активным.
 * Qwen Code добавляется вторым проходом — только если план применения называет
 * его доступным: угадывать за контур, примет ли он чужой CLI, нельзя.
 */
export async function connectLocal(
  inject: Inject,
  input: { baseUrl: string; model: string; title: string },
): Promise<unknown> {
  const put = async (consumers: string[]): Promise<void> => {
    const answer = await inject({
      method: 'PUT',
      url: `/api/platforms/${LOCAL_PLATFORM_ID}`,
      payload: {
        settings: localPlatformSettings({ ...input, consumers }),
        token: LOCAL_PLATFORM_TOKEN,
      },
    });
    if (answer.status >= 400) throw fail('local-contour-save', 'сохранение контура', answer);
  };
  await put(LOCAL_CONSUMERS);
  const plan = await inject({ method: 'GET', url: `/api/platforms/${LOCAL_PLATFORM_ID}/apply` });
  if (plan.status < 400) {
    const options =
      (plan.body as { consumers?: { id: string; reason?: string }[] }).consumers ?? [];
    const qwen = options.find((option) => option.id === foreignConsumerId('qwen'));
    if (qwen && !qwen.reason) await put([...LOCAL_CONSUMERS, qwen.id]);
  }
  const activated = await inject({
    method: 'POST',
    url: `/api/platforms/${LOCAL_PLATFORM_ID}/activate`,
  });
  if (activated.status >= 400) throw fail('local-contour-activate', 'включение контура', activated);
  return activated.body;
}

export async function disconnectLocal(inject: Inject): Promise<void> {
  const answer = await inject({
    method: 'POST',
    url: `/api/platforms/${LOCAL_PLATFORM_ID}/deactivate`,
  });
  if (answer.status >= 400 && answer.status !== 404)
    throw fail('local-contour-deactivate', 'выключение контура', answer);
}
