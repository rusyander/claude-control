import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify as stringifyToml } from 'smol-toml';
import type { AppSettings, ProviderEnvVar } from '@claude-control/contracts';
import { getActiveProvider } from '../providers/registry.ts';
import type { ConfigProvider } from '../providers/types.ts';
import { providerBackupName, readTextFile, writeTextFile } from '../lib/safe-io.ts';
import {
  UnrecognizedFormatError,
  parseCodexToml,
  stableToml,
  spliceCodexTableRegion,
} from '../lib/codex-toml.ts';
import { EnvKeyNotEncodableError, readAiderSetEnv, writeAiderSetEnv } from '../lib/aider-yaml.ts';
import { readDotenvVars, writeDotenvVars } from '../lib/dotenv-file.ts';

/**
 * Универсальный раздел переменных окружения — для провайдеров Codex (TOML),
 * Aider (YAML) и Gemini (`.env`). Claude
 * сюда НЕ попадает: его env живёт в settings.json и обслуживается собственными
 * богатыми роутами `/api/env` (источники settings/settings-local/secrets, маски,
 * перенос) — тот раздел не трогаем.
 * Роутинг «claude → /api/env, прочие → /api/provider-env» делает клиент по
 * активному провайдеру.
 *
 * БЕЗОПАСНОСТЬ ПРЕЖДЕ ВСЕГО. Codex env лежит в таблице
 * `[shell_environment_policy.set]` файла `~/.codex/config.toml`. Прочие ключи этой
 * секции (inherit / exclude / include_only / ignore_default_excludes) — ПОЛИТИКА,
 * их не трогаем и сохраняем по значениям.
 *
 * ЗАПИСЬ ХИРУРГИЧЕСКАЯ (не через полный stringify всего файла): разбираем секцию
 * `shell_environment_policy` целиком, меняем ТОЛЬКО ключ `set`, регенерируем блок
 * этой секции и вырезаем/вставляем регион `[shell_environment_policy…]` (покрывает
 * `[shell_environment_policy]` и `[shell_environment_policy.set]`). ВСЁ вне региона
 * (model / approval_policy / [mcp_servers] / комментарии) остаётся байт-в-байт.
 *
 * AIDER (формат `aider-yaml`): задокументированный ключ `set-env` в глобальном
 * `~/.aider.conf.yml` — список строк `КЛЮЧ=значение`. Правка идёт Document API
 * пакета `yaml` (`lib/aider-yaml.ts`): комментарии, порядок и все прочие ключи
 * (model, api-key, read, …) сохраняются, меняется ТОЛЬКО узел `set-env`; пустой
 * набор удаляет ключ (дефолт молча не пишем).
 *
 * GEMINI (формат `dotenv`, GEMINI-3): задокументированный файл `.env` —
 * глобальный `~/.gemini/.env` и проектный `<проект>/.gemini/.env`. Правка
 * ПОСТРОЧНАЯ (`lib/dotenv-file.ts`): меняются только строки затронутых ключей,
 * а комментарии, пустые строки, порядок и написание незатронутых значений
 * остаются байт-в-байт; новые ключи дописываются в конец файла.
 *
 * FAIL-CLOSED: config.toml не парсится, регион неоднозначен/разорван,
 * `~/.aider.conf.yml` не разбирается как YAML-отображение, строка `.env` не
 * является ни комментарием, ни присваиванием (в т.ч. незакрытая кавычка), или
 * итог не репарсится / не совпадает с намерением → НЕ пишем, бросаем
 * `UnrecognizedFormatError` (раздел только для чтения). Никогда не пишем наугад.
 */

// Переэкспорт для роутов/тестов; классы те же самые (из lib) — `instanceof` цел.
export { UnrecognizedFormatError, EnvKeyNotEncodableError };

/**
 * Имя переменной занято записью, которую панель хранит, но не моделирует
 * (`PORT = 8080`, `DEBUG = true`, вложенная таблица).
 *
 * Отдельный класс, а не `UnrecognizedFormatError`: файл разобран прекрасно и
 * раздел остаётся на запись — конфликт ровно в одном имени. Раньше этот случай
 * шёл общей ошибкой формата, и пользователь получал «формат файла не распознан —
 * запись запрещена»: неправда про его config.toml, и ни слова о том, какая
 * переменная мешает.
 */
export class EnvKeyPreservedError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `Переменная «${key}» задана в config.toml значением, которое панель не моделирует (число, булево или таблица), — переименуйте её здесь или измените значение в файле вручную. Остальные переменные не сохранены.`,
    );
    // Явное поле вместо parameter property: рантайм сервера — strip-types.
    this.name = 'EnvKeyPreservedError';
    this.key = key;
  }
}

interface ProviderEnvSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/** Формат файла переменных окружения, поддержанный универсальным разделом. */
export type ProviderEnvFormat = 'toml' | 'aider-yaml' | 'dotenv';

/** Разрешённая цель раздела: провайдер + формат + путь к файлу. */
export interface ProviderEnvTarget {
  provider: ConfigProvider;
  format: ProviderEnvFormat;
  filePath: string;
  cliDetected: boolean;
  /**
   * Имя резервной копии. По умолчанию — `<id>-<basename>` (глобальный файл
   * провайдера). Проектный уровень передаёт своё (`<id>-project-<basename>`),
   * чтобы копии проекта не делили ротацию с копиями глобального конфига.
   */
  backupName?: string;
}

/** Имя копии для этой цели: своё, если задано, иначе стандартное `<id>-<basename>`. */
function backupNameOf(target: ProviderEnvTarget): string {
  return target.backupName ?? providerBackupName(target.provider.id, target.filePath);
}

/**
 * Цель универсального env-раздела активного провайдера — или `undefined`, если он
 * им не поддержан (маршрут ответит 4xx). Поддержан, только когда `env` = `ready` И
 * задан `envConfig` (Codex — TOML, Aider — YAML, Gemini — `.env`). Claude сюда не
 * попадает (у него нет `envConfig`) — он на своих роутах. Fail-closed.
 */
export function resolveProviderEnvTarget(
  store: ProviderEnvSettingsSource,
): ProviderEnvTarget | undefined {
  const provider = getActiveProvider(store);
  if (provider.capabilities.env !== 'ready' || !provider.envConfig) return undefined;

  const filePath = provider.envConfig.path(store.getSettings().claudeDirOverride);
  return {
    provider,
    format: provider.envConfig.format,
    filePath,
    cliDetected: existsSync(dirname(filePath)),
  };
}

// --- Разбор черновика (валидация на стороне сервера) -------------------------

/**
 * Разобрать желаемый набор переменных из тела запроса. Схему contracts (zod) в
 * рантайме сервера использовать нельзя (значение из contracts роняет node ESM),
 * поэтому проверяем руками. Некорректное тело → `undefined` (маршрут ответит 400).
 * Дубликаты ключей и пустые имена отсекаются; последнее значение ключа побеждает.
 */
export function parseProviderEnvDraft(body: unknown): ProviderEnvVar[] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const raw = (body as { vars?: unknown }).vars;
  if (!Array.isArray(raw)) return undefined;

  const byKey = new Map<string, string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return undefined;
    const rec = item as Record<string, unknown>;
    const key = typeof rec.key === 'string' ? rec.key.trim() : '';
    const value = typeof rec.value === 'string' ? rec.value : undefined;
    if (!key || value === undefined) return undefined;
    byKey.set(key, value);
  }
  return [...byKey.entries()].map(([key, value]) => ({ key, value }));
}

// --- Codex (TOML: ~/.codex/config.toml, таблица [shell_environment_policy.set]) --

const POLICY_KEY = 'shell_environment_policy';

/** Разобрать секцию политики окружения как объект (или {}). Не-объект → fail-closed. */
function parsePolicy(text: string): Record<string, unknown> {
  const parsed = parseCodexToml(text);
  const policy = parsed[POLICY_KEY];
  if (policy === undefined) return {};
  if (typeof policy !== 'object' || Array.isArray(policy)) throw new UnrecognizedFormatError();
  return policy as Record<string, unknown>;
}

/**
 * Разложить `set` политики на то, что панель ВЕДЁТ (строковые значения), и то,
 * что она лишь ХРАНИТ. Строкой значение переменной окружения бывает не всегда:
 * человек мог написать `PORT = 8080` или `DEBUG = true` — TOML это позволяет.
 * Такие записи панель не показывает (её форма знает только строки), но и не
 * теряет: на записи они возвращаются в файл по значению.
 * Не-объект (строка/массив вместо таблицы) → fail-closed.
 */
function splitPolicySet(policy: Record<string, unknown>): {
  vars: ProviderEnvVar[];
  preserved: Record<string, unknown>;
} {
  const set = policy.set;
  if (set === undefined) return { vars: [], preserved: {} };
  if (typeof set !== 'object' || Array.isArray(set)) throw new UnrecognizedFormatError();

  const vars: ProviderEnvVar[] = [];
  const preserved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(set as Record<string, unknown>)) {
    if (typeof value === 'string') vars.push({ key, value });
    else preserved[key] = value;
  }
  return { vars, preserved };
}

/**
 * Прочитать переменные окружения активного провайдера. Формат выбирается по
 * `target.format`: Codex — ключ `set` таблицы `[shell_environment_policy]`,
 * Aider — список `set-env` в `~/.aider.conf.yml`. Значения приводим к строке.
 */
export function readProviderEnvVars(target: ProviderEnvTarget): ProviderEnvVar[] {
  const text = readTextFile(target.filePath);
  if (!text.trim()) return [];
  if (target.format === 'aider-yaml') {
    return readAiderSetEnv(text).sort((a, b) => a.key.localeCompare(b.key));
  }
  if (target.format === 'dotenv') {
    return readDotenvVars(text).sort((a, b) => a.key.localeCompare(b.key));
  }
  return splitPolicySet(parsePolicy(text)).vars.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Записать полный набор переменных как `shell_environment_policy.set`. Прочие
 * ключи политики сохраняются по значениям (меняется ТОЛЬКО `set`). Хирургически
 * заменяет регион политики; всё вне него — байт-в-байт. Итог репарсится и
 * сверяется с намерением — расхождение → fail-closed (не пишем). Нет файла →
 * создаётся только с `[shell_environment_policy.set]`.
 */
export function saveProviderEnvVars(
  target: ProviderEnvTarget,
  vars: ProviderEnvVar[],
  backupDir: string | undefined,
): string | undefined {
  if (target.format === 'aider-yaml') return saveAiderEnvVars(target, vars, backupDir);
  if (target.format === 'dotenv') return saveDotenvVars(target, vars, backupDir);

  const exists = existsSync(target.filePath);
  const original = exists ? readFileSync(target.filePath, 'utf8') : '';

  // Прочие ключи политики (inherit/exclude/…) берём из существующего файла и
  // сохраняем как есть; меняем только `set`. Оригинал обязан парситься (иначе не
  // знаем, где регион и какие ключи политики беречь) — fail-closed.
  const parsed = original.trim() ? parsePolicy(original) : {};
  const policy: Record<string, unknown> = { ...parsed };

  // Немоделируемые записи `set` (TOML-число, bool, вложенная таблица) панель не
  // показывает — и потому не может их «сохранить обратно» из формы. Переносим их
  // по значению: иначе обычное «Сохранить» без единой правки молча удаляло бы
  // `PORT = 8080` из чужого конфига, а верификация ниже этого не заметила бы —
  // она сверяет результат с намерением, собранным из того же списка.
  const { preserved } = splitPolicySet(parsed);
  const set: Record<string, unknown> = { ...preserved };
  for (const { key, value } of vars) {
    // Черновик назвал сохранённый ключ: чем он был в файле, панель не знает, а
    // записать строку поверх — потеря чужого значения. Отказ, но именной (409):
    // файл в порядке, мешает ровно эта переменная — так и говорим.
    if (key in preserved) throw new EnvKeyPreservedError(key);
    set[key] = value;
  }
  policy.set = set;

  const block = stringifyToml({ [POLICY_KEY]: policy });

  let next: string;
  if (!original.trim()) {
    next = `${block.replace(/\n+$/, '')}\n`;
  } else {
    next = spliceCodexTableRegion(original, block, POLICY_KEY);
  }

  // Верификация: итог обязан валидно репарситься, а его shell_environment_policy —
  // точно совпадать с намерением (тот же policy-объект). Иначе surgery что-то
  // испортила → не пишем.
  const reparsed = parseCodexToml(next);
  const got = reparsed[POLICY_KEY] ?? {};
  if (stableToml(got) !== stableToml(policy)) throw new UnrecognizedFormatError();

  // preserveForm:false — итог собран из исходного текста (байт-в-байт вне региона,
  // BOM исходника цел, CRLF учтён в splice); общая нормализация тут навредила бы.
  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
    preserveForm: false,
  });
}

// --- Aider (YAML: ~/.aider.conf.yml, задокументированный ключ `set-env`) ------

/**
 * Записать полный набор переменных в `set-env` файла `~/.aider.conf.yml`.
 *
 * Дерево правится Document API пакета `yaml`: комментарии (включая комментарий
 * над самим `set-env`), порядок и все прочие ключи сохраняются; round-trip
 * проверяется ДО записи (см. `lib/aider-yaml.ts`). Нет файла — создаётся только с
 * `set-env`. Пустой набор — ключ удаляется.
 *
 * preserveForm по умолчанию (в отличие от TOML-хирургии): текст здесь ПЕРЕСОБРАН
 * сериализатором `yaml` и всегда с LF, поэтому форму существующего файла (BOM +
 * CRLF) нужно вернуть — иначе у пользователя с CRLF-конфигом появились бы
 * смешанные окончания строк.
 */
function saveAiderEnvVars(
  target: ProviderEnvTarget,
  vars: ProviderEnvVar[],
  backupDir: string | undefined,
): string | undefined {
  const original = existsSync(target.filePath) ? readFileSync(target.filePath, 'utf8') : '';
  const next = writeAiderSetEnv(original, vars);

  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
  });
}

// --- Gemini (dotenv: ~/.gemini/.env и <проект>/.gemini/.env) -----------------

/**
 * Записать желаемый набор переменных в `.env` ПОСТРОЧНО.
 *
 * Меняются только строки затронутых ключей: комментарии, пустые строки, порядок,
 * префикс `export` и написание незатронутых значений остаются как были; удалённые
 * в панели ключи убираются, новые дописываются в конец. Round-trip проверяется ДО
 * записи (см. `lib/dotenv-file.ts`). Нет файла — создаётся с одними переменными.
 *
 * preserveForm по умолчанию: строки собираются с LF, поэтому форму существующего
 * файла (BOM + CRLF) возвращает `safe-io` — иначе у пользователя с CRLF-файлом
 * появились бы смешанные окончания строк. Каталог `.gemini` создаётся только
 * здесь, при явном сохранении (`writeTextFile` → mkdir recursive).
 */
function saveDotenvVars(
  target: ProviderEnvTarget,
  vars: ProviderEnvVar[],
  backupDir: string | undefined,
): string | undefined {
  const original = existsSync(target.filePath) ? readFileSync(target.filePath, 'utf8') : '';
  const next = writeDotenvVars(original, vars);

  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
  });
}
