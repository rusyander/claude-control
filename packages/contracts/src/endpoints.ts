import { object, string, boolean, array, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Свой эндпоинт — адрес, по которому CLI ходит в модель вместо облака вендора:
 * локальная модель (Ollama, vLLM, LM Studio), корпоративный шлюз или прокси.
 *
 * Панель ведёт ПРОФИЛИ уровня панели (адрес + вид API + модель) и применяет
 * выбранный профиль к CLI через его же раздел переменных окружения. Имена
 * переменных берутся ИЗ ДОКУМЕНТАЦИИ каждого CLI (`endpointConfig` в реестре
 * провайдеров); CLI без задокументированного имени профиль не принимает —
 * угадывать переменную нельзя, молча не сработавшая настройка хуже отказа.
 */

/**
 * Вид API эндпоинта — им определяются и путь проверки связи, и то, какие CLI
 * профиль примут. Список УЖЕ, чем `AssistantApiKind` у провайдеров: `openai` и
 * `openai-compat` для своего адреса — одно и то же (совместимый со схемой
 * OpenAI сервер), а `none` не эндпоинт вовсе.
 */
export const endpointApiKinds = ['anthropic', 'google', 'openai-compat'] as const;
export type EndpointApiKind = (typeof endpointApiKinds)[number];

/**
 * Профиль своего эндпоинта. Хранится в настройках панели (`state.json`) —
 * ТОКЕНА здесь нет: он лежит в зашифрованном хранилище панели, наружу отдаётся
 * только маской, а в конфиг CLI попадает исключительно по явной галочке.
 */
export const endpointProfileSchema = object({
  /** Идентификатор профиля — генерируется панелью, в интерфейсе не показывается. */
  id: string().min(1),
  /** Имя профиля для списка («Ollama дома», «Шлюз компании»). */
  name: string().min(1),
  /**
   * Базовый адрес. Смысл зависит от вида API — панель НИЧЕГО к нему не
   * дописывает при записи в конфиг, а только при своей проверке связи:
   * `anthropic` и `google` — корень хоста (`https://gw.example.com`),
   * `openai-compat` — адрес вместе с версией (`http://127.0.0.1:11434/v1`),
   * как этого и ждут `OPENAI_BASE_URL` и его аналоги.
   */
  baseUrl: string().min(1),
  apiKind: zodEnum(endpointApiKinds),
  /** Имя модели на этом адресе. Пусто — переменную модели не трогаем. */
  model: string().default(''),
  /**
   * Писать токен в конфигурацию CLI при применении профиля. По умолчанию НЕТ:
   * в чужой конфиг уходят только адрес и модель — несекретные значения. С
   * галочкой токен попадёт в файл открытым текстом (у Claude — в `settings.json`,
   * у остальных — в их `.env`/`.aider.conf.yml`), и интерфейс об этом
   * предупреждает прямо на месте.
   */
  writeToken: boolean().default(false),
});

export type EndpointProfile = Infer<typeof endpointProfileSchema>;

export const endpointProfilesSchema = array(endpointProfileSchema);

/** Почему CLI не принимает профиль. Причина машиночитаемая — текст на клиенте. */
export const endpointUnsupportedReasons = [
  // У CLI вообще нет файла переменных окружения (Goose, Kimi, OpenCode, Cursor).
  'no_env_section',
  // Файл есть, но задокументированной переменной базового адреса у CLI нет:
  // Codex задаёт `base_url` только в `config.toml` (таблица `model_providers`),
  // Continue — полем `apiBase` у модели в `config.yaml`. Через окружение это не
  // переопределяется, поэтому профиль сюда не переносится.
  'no_documented_base_url',
  // CLI ходит в API другого вида: Claude понимает только `anthropic`, Gemini —
  // только `google`, Aider — только совместимый с OpenAI.
  'api_kind_mismatch',
] as const;
export type EndpointUnsupportedReason = (typeof endpointUnsupportedReasons)[number];

/** Одна переменная, которую панель запишет в конфигурацию CLI. */
export interface EndpointVarPlan {
  key: string;
  /** Значение; у секретной переменной — маска, полное значение не покидает сервер. */
  value: string;
  /** Токен: пишется только при `writeToken`, в ответы уходит замаскированным. */
  secret: boolean;
}

/**
 * Готовность одного CLI принять профиль. Считается для КОНКРЕТНОГО профиля —
 * поддержка зависит от вида API, поэтому «поддержан» без профиля не имеет смысла.
 */
export interface EndpointTarget {
  providerId: string;
  providerName: string;
  supported: boolean;
  reason?: EndpointUnsupportedReason;
  /** Виды API, которые этот CLI принимает через окружение (пусто — никакие). */
  apiKinds: EndpointApiKind[];
  /** Что именно будет записано (у неподдержанного — пусто). */
  plan: EndpointVarPlan[];
  /** Куда именно (файл конфигурации CLI). Пусто у неподдержанного. */
  filePath: string;
}

/** Ответ `GET /api/endpoints`: профили, маски токенов и готовность каждого CLI. */
export interface EndpointsInfo {
  profiles: EndpointProfile[];
  /** Маска сохранённого токена по id профиля; нет ключа — токен не задан. */
  tokenMasks: Record<string, string>;
  /** Готовность CLI для АКТИВНОГО профиля (`activeProfileId`). */
  targets: EndpointTarget[];
  /** Профиль, по которому посчитаны `targets` — первый в списке либо запрошенный. */
  activeProfileId: string;
  /** Ассистент самой панели: применяется ли к нему профиль. */
  assistantProfileId: string;
}

/** Результат проверки связи с эндпоинтом. */
export interface EndpointProbeResult {
  ok: boolean;
  /** Адрес, по которому стучались. Токена в нём НЕТ никогда. */
  url: string;
  status?: number;
  /** Список моделей с адреса; пусто — сервер его не отдал (это не отказ связи). */
  models: string[];
  /** Уходил ли токен в запрос. */
  tokenSent: boolean;
  /** Текст ошибки без секретов (тело ответа обрезано). */
  error?: string;
}

/** Результат применения профиля к CLI: что и куда записано. */
export interface EndpointApplyResult {
  providerId: string;
  filePath: string;
  /** Записанные переменные; значение токена — маска. */
  written: EndpointVarPlan[];
  /** Путь к резервной копии файла, если копии включены. */
  backupPath?: string;
}
