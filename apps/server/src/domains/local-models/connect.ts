import { LOCAL_PLATFORM_ID, type LocalConnectInfo } from '@agentdeck/contracts/local-models';
import type { OurRules } from '@agentdeck/contracts/platform';
import {
  PLATFORM_ASSISTANT_TARGET,
  defaultOurRules,
  defaultPlatformRules,
} from '@agentdeck/contracts/platform';
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
 * шапке чата, куда идёт работа; вернуть всё одной кнопкой. llama-server говорит на
 * Anthropic Messages сам, и пресет `llama-cpp` шлёт запросы Claude Code к нему без
 * перевода. Своя вторая обвязка разошлась бы с этой на первой же правке.
 *
 * Контур заводится и включается через ТЕ ЖЕ маршруты, что и мастер контура:
 * проверки тела, транзакция активации и проба проходят и здесь.
 */

/**
 * Идентификатор контура остался прежним при смене движка с Ollama на llama.cpp:
 * по нему живёт всё, что человек уже настроил (разделы маршрута, бюджет, журнал).
 * Значение — в контрактах: по нему же экран называет контур «Локальная модель».
 */
export { LOCAL_PLATFORM_ID };
/** Пресет контура: `llama-server` говорит на Anthropic Messages сам. */
export const LOCAL_DRIVER = 'llama-cpp';
/** Ключ-заглушка: сервер моделей ключ не проверяет, а контур без ключа прогон не поведёт. */
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
  platforms: {
    platform: {
      id: string;
      title: string;
      defaultModel: string;
      driver?: string;
      rules?: { platform?: unknown; ours?: unknown };
    };
  }[];
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

/**
 * Облегчённый набор локального контура (L1b, замер 13.10.2026) — ТОЛЬКО по выбору
 * человека на карточке контура: без MCP-серверов (около 19 тыс. токенов) и с рабочим
 * набором инструментов (минус около 11 тыс.). Правила, хуки и скиллы остаются.
 *
 * По умолчанию локальный контур идёт с ПОЛНЫМ набором, как облачный Claude (слово
 * владельца 15.10: десять часов без присмотра на локальной модели со всем, что есть
 * у облака). Облегчённый набор без MCP толкал модель в обход — субагент ревью ходил
 * в GitLab curl'ом с ключом из файла секретов, потому что MCP-сервера у него не было.
 * Под полный набор поднято окно в каталоге (`defaultContext`), а не урезан набор.
 */
export function localLeanRules(): OurRules {
  return { ...defaultOurRules(), mcp: false, tools: false };
}

export function localPlatformSettings(input: {
  baseUrl: string;
  model: string;
  title: string;
  consumers: string[];
  /** Правила действующего контура этого же вида — переживают повторное «Подключить». */
  rules?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: LOCAL_PLATFORM_ID,
    title: input.title,
    driver: LOCAL_DRIVER,
    // Адрес с версией: так его ждёт пресет (`/v1`), а путь Anthropic шлюз строит сам.
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
    rules: input.rules ?? { platform: defaultPlatformRules(), ours: defaultOurRules() },
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
  await saveLocalContour(inject, input);
  const activated = await inject({
    method: 'POST',
    url: `/api/platforms/${LOCAL_PLATFORM_ID}/activate`,
  });
  if (activated.status >= 400) throw fail('local-contour-activate', 'включение контура', activated);
  return applyAssistant(inject, activated.body);
}

/** Записать контур локальной модели (без включения): адрес, модель, кому он отдан. */
export async function saveLocalContour(
  inject: Inject,
  input: { baseUrl: string; model: string; title: string },
): Promise<void> {
  // Контур этого же вида уже есть — его слои человек мог править на карточке, и
  // повторное «Подключить» их не сбрасывает. Контур старого вида (Ollama) или
  // новый получает полный набор.
  const known = await inject({ method: 'GET', url: '/api/platforms' });
  const own =
    known.status < 400
      ? (known.body as Partial<PlatformsInfoLite>).platforms?.find(
          (item) => item.platform.id === LOCAL_PLATFORM_ID,
        )
      : undefined;
  const rules =
    own?.platform.driver === LOCAL_DRIVER && own.platform.rules
      ? (own.platform.rules as Record<string, unknown>)
      : undefined;
  const put = async (consumers: string[]): Promise<void> => {
    const answer = await inject({
      method: 'PUT',
      url: `/api/platforms/${LOCAL_PLATFORM_ID}`,
      payload: {
        settings: localPlatformSettings({ ...input, consumers, ...(rules ? { rules } : {}) }),
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
}

/**
 * Включить уже заведённый контур одним нажатием (кнопка в шапке чата): без пробы — она
 * ждала бы ответа модели, которая в этот момент только грузится. Профиль ассистента
 * назначается тем же шагом, что и при «Подключить»: выключение возвращает его откатом.
 */
export async function switchLocalOn(inject: Inject): Promise<unknown> {
  const activated = await inject({
    method: 'POST',
    url: `/api/platforms/${LOCAL_PLATFORM_ID}/activate?probe=skip`,
  });
  if (activated.status >= 400) throw fail('local-contour-activate', 'включение контура', activated);
  return applyAssistant(inject, activated.body);
}

async function applyAssistant(inject: Inject, activated: unknown): Promise<unknown> {
  // Агент панели, помощники и наблюдатель ходят профилем «Ассистента панели», а не
  // окружением прогона: его назначает применение цели `assistant`, как в мастере
  // контура. Без этого шага при недоступном Claude они уходили в облако и падали
  // «Not logged in» (живой прогон 08.10). Прежний выбор профиля перекрывается —
  // «Подключить» обещает модель везде, — а `deactivate` возвращает его откатом.
  const applied = await inject({
    method: 'POST',
    url: `/api/platforms/${LOCAL_PLATFORM_ID}/apply`,
    payload: { targets: [PLATFORM_ASSISTANT_TARGET], overwrite: [PLATFORM_ASSISTANT_TARGET] },
  });
  if (applied.status >= 400) throw fail('local-contour-activate', 'ассистент панели', applied);
  const skipped = (applied.body as { skipped?: { reason?: string }[] } | undefined)?.skipped ?? [];
  // Шлюз не поднялся (порт занят): включение уже отдало красную проверку с
  // причиной — она человеку и нужна, а не 409 с кодом цели поверх неё.
  if (skipped.every((item) => item.reason === 'gateway_down')) return activated;
  if (skipped.length > 0) {
    throw fail('local-contour-activate', 'ассистент панели', {
      status: 409,
      body: { message: `цель пропущена: ${skipped[0]?.reason ?? 'причина не названа'}` },
    });
  }
  return activated;
}

export async function disconnectLocal(inject: Inject): Promise<void> {
  const answer = await inject({
    method: 'POST',
    url: `/api/platforms/${LOCAL_PLATFORM_ID}/deactivate`,
  });
  if (answer.status >= 400 && answer.status !== 404)
    throw fail('local-contour-deactivate', 'выключение контура', answer);
}
