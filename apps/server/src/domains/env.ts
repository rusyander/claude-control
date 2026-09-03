import type { EnvVar, EnvVarDraft, Group } from '@claude-control/contracts';
import { ENV_KEY_PATTERN, isSecretEnvKey } from '@claude-control/contracts/env-secret';
import { readTextFile, writeTextFile, readJsonFile, writeJsonFile } from '../lib/safe-io.ts';

/**
 * Переменные окружения живут в двух местах: settings.json → env (их видит сам
 * Claude Code) и .mcp-secrets.env (их читает лаунчер MCP-серверов). Работаем
 * с обоими, но по-разному: json — структурой, env-файл — построчно, сохраняя
 * комментарии, потому что в них записано, где брать каждый токен.
 */

/** Черновик не годится для записи; причина — человеку, маршрут отвечает 400. */
export class InvalidEnvDraftError extends Error {}
/** Переменной с таким ключом в этом файле нет; маршрут отвечает 404. */
export class EnvVarNotFoundError extends Error {}
/** В файле-приёмнике уже лежит переменная с таким ключом; маршрут отвечает 409. */
export class EnvVarExistsError extends Error {}

type WritableSource = 'settings' | 'settings-local' | 'secrets';

const FILE_NAMES: Record<WritableSource, string> = {
  settings: 'settings.json',
  'settings-local': 'settings.local.json',
  secrets: '.mcp-secrets.env',
};

const BAD_KEY_MESSAGE =
  'Имя переменной — латинские буквы, цифры и подчёркивание, не с цифры: MY_TOKEN, а не «my token».';
const BAD_SOURCE_MESSAGE =
  'Куда сохранить: settings, settings-local или secrets. Переменные групп правятся на странице групп.';

function isWritableSource(source: unknown): source is WritableSource {
  return source === 'settings' || source === 'settings-local' || source === 'secrets';
}

/**
 * Проверка черновика ДО записи. Пока её не было, маршрут писал всё, что пришло:
 * ключ с пробелом ломал строку `KEY=value`, перевод строки в ключе или в
 * значении секрета дописывал в .mcp-secrets.env ЧУЖУЮ строку (`A=1\nEVIL=2` —
 * вторая становилась переменной), а source `group` или вовсе отсутствующий
 * получал «ok», хотя ничего не сохранялось. В JSON-файлах перевод строки в
 * значении допустим — JSON его экранирует; в env-файле строка и есть запись.
 */
export function assertEnvDraft(draft: unknown): asserts draft is EnvVarDraft {
  if (!draft || typeof draft !== 'object') {
    throw new InvalidEnvDraftError('Тело запроса пустое: нужны key, value и source.');
  }
  const { key, value, source, comment } = draft as Record<string, unknown>;
  if (typeof key !== 'string' || !ENV_KEY_PATTERN.test(key)) {
    throw new InvalidEnvDraftError(BAD_KEY_MESSAGE);
  }
  if (typeof value !== 'string') throw new InvalidEnvDraftError('Значение переменной — строка.');
  if (!isWritableSource(source)) throw new InvalidEnvDraftError(BAD_SOURCE_MESSAGE);
  if (source === 'secrets' && /[\r\n]/.test(value)) {
    throw new InvalidEnvDraftError(
      'Значение для .mcp-secrets.env — одна строка: перевод строки стал бы отдельной переменной.',
    );
  }
  if (comment !== undefined && typeof comment !== 'string') {
    throw new InvalidEnvDraftError('Комментарий — строка.');
  }
}

/**
 * Ключ и источник из строки запроса (чтение, удаление, перенос). Мягче, чем у
 * черновика: имя, записанное в файл руками не по правилу, всё равно должно
 * удаляться отсюда — иначе испорченная строка застряла бы в файле навсегда.
 */
function assertEnvRef(key: unknown, source: unknown): asserts source is WritableSource {
  if (typeof key !== 'string' || key.trim() === '' || /[\r\n=]/.test(key)) {
    throw new InvalidEnvDraftError(BAD_KEY_MESSAGE);
  }
  if (!isWritableSource(source)) throw new InvalidEnvDraftError(BAD_SOURCE_MESSAGE);
}

const notFound = (key: string, source: WritableSource): EnvVarNotFoundError =>
  new EnvVarNotFoundError(`Переменной ${key} нет в ${FILE_NAMES[source]}.`);

interface RawSettings {
  env?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Переменные из обоих файлов настроек и из файла секретов. Локальные помечены
 * источником: Claude Code их применяет, а панель — только показывает.
 */
export function readEnvVars(
  settingsPath: string,
  secretsPath: string,
  settingsLocalPath?: string,
): EnvVar[] {
  const fromSettings = readSettingsEnv(settingsPath, 'settings');
  const fromLocal = settingsLocalPath ? readSettingsEnv(settingsLocalPath, 'settings-local') : [];

  return [...fromSettings, ...fromLocal, ...parseEnvFile(readTextFile(secretsPath))];
}

/**
 * Переменные, которые задаёт ВКЛЮЧЁННАЯ группа, лежат в settings.json как обычные,
 * но хозяин у них — группа: панель снимает и возвращает их вместе с ней. В списке
 * они помечаются source `group` + groupId (контракт держал этот источник, но никто
 * его не выдавал): страница показывает имя группы и не даёт править и удалять —
 * удалённую здесь группа вернула бы при следующем включении. Записи из
 * settings.local.json и файла секретов не трогаем; выключенная группа не в счёт —
 * её ключи в файле уже пользовательские. Две группы с одним ключом: хозяин — первая
 * по порядку применения.
 */
export function markGroupEnv(vars: EnvVar[], groups: Group[]): EnvVar[] {
  const owners = new Map<string, string>();
  for (const group of [...groups].sort((a, b) => a.order - b.order)) {
    if (!group.isEnabled) continue;
    // Группа из старого state.json может прийти без поля env (хранилище записи
    // не нормализует) — Object.keys(undefined) валил бы весь список переменных.
    const env: Record<string, string> = group.env ?? {};
    for (const key of Object.keys(env)) if (!owners.has(key)) owners.set(key, group.id);
  }
  if (owners.size === 0) return vars;
  return vars.map((item): EnvVar => {
    const groupId = item.source === 'settings' ? owners.get(item.key) : undefined;
    if (groupId === undefined) return item;
    return { ...item, id: `group:${item.key}`, source: 'group', groupId };
  });
}

/**
 * Значения переменных ОТКРЫТЫМ текстом из всех трёх файлов — для подстановки
 * ссылок ${VAR} в записи MCP-сервера при проверке связи (mcp-client.ts).
 * Порядок наложения: settings.json, поверх него settings.local.json, поверх —
 * файл секретов. В ответы API это не попадает.
 */
export function readEnvLookup(
  settingsPath: string,
  secretsPath: string,
  settingsLocalPath?: string,
): Record<string, string> {
  const fromJson = (path?: string): Record<string, string> =>
    path ? (readJsonFile<RawSettings>(path, {}).env ?? {}) : {};
  const secrets = Object.fromEntries(
    parseEnvFile(readTextFile(secretsPath), false).map((item) => [item.key, item.value]),
  );

  return { ...fromJson(settingsPath), ...fromJson(settingsLocalPath), ...secrets };
}

function readSettingsEnv(path: string, source: EnvVar['source']): EnvVar[] {
  const settings = readJsonFile<RawSettings>(path, {});
  return Object.entries(settings.env ?? {}).map(([key, value]) => toEnvVar(key, value, source));
}

/**
 * Полное значение — отдельным запросом, по явному действию пользователя.
 * Нет такой переменной — EnvVarNotFoundError: маршрут, возвращавший здесь
 * `undefined`, не отвечал вовсе (Fastify ждёт тело), и запрос висел до таймаута.
 */
export function revealEnvValue(
  settingsPath: string,
  secretsPath: string,
  key: string,
  source: string | undefined,
  settingsLocalPath?: string,
): string {
  // Переменная группы (source `group`, см. markGroupEnv) физически лежит в
  // settings.json — показ читает оттуда; править и удалять её отсюда нельзя.
  const file = source === 'group' ? 'settings' : source;
  assertEnvRef(key, file);
  let value: string | undefined;
  if (file === 'settings') {
    value = readJsonFile<RawSettings>(settingsPath, {}).env?.[key];
  } else if (file === 'settings-local') {
    // Локальную переменную показать можно — это чтение; прятать значение,
    // которое лежит открытым текстом рядом, смысла нет.
    value = settingsLocalPath
      ? readJsonFile<RawSettings>(settingsLocalPath, {}).env?.[key]
      : undefined;
  } else {
    value = parseEnvFile(readTextFile(secretsPath), false).find((item) => item.key === key)?.value;
  }
  if (value === undefined) throw notFound(key, file);
  return value;
}

/** Имена переменных, уже лежащих в settings.json → env. */
export function existingEnvKeys(settingsPath: string): string[] {
  return Object.keys(readJsonFile<RawSettings>(settingsPath, {}).env ?? {});
}

/**
 * Применить и снять переменные группы в settings.json одним заходом. `set` —
 * ключи со значениями, которые группа добавляет; `remove` — ключи, которые она
 * снимает (когда их больше никто не держит). Возвращает путь резервной копии.
 */
export function applyGroupEnv(
  settingsPath: string,
  set: Record<string, string>,
  remove: string[],
  backupDir?: string,
): string | undefined {
  const settings = readJsonFile<RawSettings>(settingsPath, {});
  const env = { ...settings.env };
  for (const [key, value] of Object.entries(set)) env[key] = value;
  for (const key of remove) delete env[key];
  settings.env = env;
  return writeJsonFile(settingsPath, settings, { backupDir });
}

/**
 * Запись в env одного из файлов настроек. Без проверки черновика: у переноса
 * ключ уже лежит на диске, проверяет его вызывающий.
 */
function writeSettingsEnv(
  path: string,
  key: string,
  value: string,
  backupDir?: string,
): string | undefined {
  const settings = readJsonFile<RawSettings>(path, {});
  settings.env = { ...settings.env, [key]: value };
  return writeJsonFile(path, settings, { backupDir });
}

/**
 * Запись переменной. Локальная уходит в свой файл: панель показывает оба и
 * правит каждый на месте — переезд в общий конфиг сделал бы личную настройку
 * общей, чего никто не просил.
 */
export function saveEnvVar(
  settingsPath: string,
  secretsPath: string,
  draft: EnvVarDraft,
  backupDir?: string,
  settingsLocalPath?: string,
): string | undefined {
  assertEnvDraft(draft);

  if (draft.source === 'settings-local') {
    if (!settingsLocalPath) throw new Error('Не задан путь к settings.local.json');
    return writeSettingsEnv(settingsLocalPath, draft.key, draft.value, backupDir);
  }

  if (draft.source === 'settings') {
    return writeSettingsEnv(settingsPath, draft.key, draft.value, backupDir);
  }

  // source === 'secrets' (assertEnvDraft отсёк всё прочее; env групп применяют
  // маршруты групп через applyGroupEnv, а не /api/env).
  return upsertEnvFileLine(secretsPath, draft.key, draft.value, draft.comment, backupDir);
}

/**
 * Удаление. Ключа нет — EnvVarNotFoundError, а не «ok»: раньше маршрут отвечал
 * успехом и ПЕРЕПИСЫВАЛ файл (с копией в backups) даже для чужого имени, и
 * интерфейс не мог отличить удалённое от никогда не существовавшего.
 */
export function deleteEnvVar(
  settingsPath: string,
  secretsPath: string,
  key: string,
  source: string | undefined,
  backupDir?: string,
  settingsLocalPath?: string,
): string | undefined {
  assertEnvRef(key, source);

  if (source === 'settings-local') {
    if (!settingsLocalPath) throw new Error('Не задан путь к settings.local.json');

    const local = readJsonFile<RawSettings>(settingsLocalPath, {});
    if (local.env?.[key] === undefined) throw notFound(key, source);
    delete local.env[key];
    return writeJsonFile(settingsLocalPath, local, { backupDir });
  }

  if (source === 'settings') {
    const settings = readJsonFile<RawSettings>(settingsPath, {});
    if (settings.env?.[key] === undefined) throw notFound(key, source);
    delete settings.env[key];
    return writeJsonFile(settingsPath, settings, { backupDir });
  }

  return deleteSecretLine(secretsPath, key, backupDir);
}

/**
 * Перенос переменной между settings.json и settings.local.json. Секреты из
 * .mcp-secrets.env и env групп так не переносятся — у них своя природа, вызов с
 * таким источником отвергается. Значение берётся из файла-источника как есть: в
 * settings оно лежит открытым текстом (маскировка — только в списке), поэтому
 * переносим ровно то, что реально хранится. Приёмник пишем напрямую, минуя
 * проверку черновика: имя, записанное в файл руками не по правилу, уже лежит на
 * диске и должно переезжать так же мягко, как удаляется (assertEnvRef), — иначе
 * перенос отвечал 400, а удаление того же ключа «ок». Удаление — deleteEnvVar.
 * Возвращает путь резервной копии.
 */
export function moveEnvVar(
  settingsPath: string,
  secretsPath: string,
  key: string,
  source: string | undefined,
  backupDir?: string,
  settingsLocalPath?: string,
): string | undefined {
  if (source !== 'settings' && source !== 'settings-local') {
    throw new InvalidEnvDraftError(
      'Переносить между файлами настроек можно только переменные settings.json / settings.local.json.',
    );
  }
  assertEnvRef(key, source);
  if (!settingsLocalPath) throw new Error('Не задан путь к settings.local.json');

  const sourcePath = source === 'settings-local' ? settingsLocalPath : settingsPath;
  const targetSource: WritableSource = source === 'settings-local' ? 'settings' : 'settings-local';
  const targetPath = source === 'settings-local' ? settingsPath : settingsLocalPath;

  const value = readJsonFile<RawSettings>(sourcePath, {}).env?.[key];
  if (value === undefined) throw notFound(key, source);

  // В приёмнике уже есть такой ключ — не затирать: значения разные по смыслу
  // (общее и личное), и молчаливая перезапись уносила бы одно из них без следа.
  if (readJsonFile<RawSettings>(targetPath, {}).env?.[key] !== undefined) {
    throw new EnvVarExistsError(
      `В ${FILE_NAMES[targetSource]} уже есть ${key} — сначала удалите или переименуйте её там.`,
    );
  }

  writeSettingsEnv(targetPath, key, value, backupDir);
  return deleteEnvVar(settingsPath, secretsPath, key, source, backupDir, settingsLocalPath);
}

/**
 * Удаляет строку `KEY=…` из env-файла вместе с прилегающим сверху блоком
 * комментариев: он привязан к переменной (см. parseEnvFile) и описывает, где
 * брать именно этот токен. Осиротев, комментарий копит мусор и вводит в
 * заблуждение, поэтому уходит вместе с переменной.
 */
function deleteSecretLine(path: string, key: string, backupDir?: string): string | undefined {
  const lines = readTextFile(path).split(/\r?\n/);
  const index = lines.findIndex((line) => startsWithKey(line, key));
  if (index === -1) throw notFound(key, 'secrets');

  // Забираем и непрерывный блок комментариев прямо над переменной (до пустой
  // строки или не-комментария) — ровно то, что parseEnvFile привязал к ней.
  let start = index;
  while (start > 0 && (lines[start - 1]?.trim().startsWith('#') ?? false)) start -= 1;

  lines.splice(start, index - start + 1);
  return writeTextFile(path, lines.join('\n'), { backupDir });
}

/**
 * Разбор env-файла. Комментарий, стоящий над переменной, привязываем к ней:
 * в этом файле комментарии объясняют, где выпускать каждый токен.
 */
function parseEnvFile(content: string, mask = true): EnvVar[] {
  const result: EnvVar[] = [];
  let pendingComment: string[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      pendingComment = [];
      continue;
    }
    if (line.startsWith('#')) {
      pendingComment.push(line.replace(/^#\s?/, ''));
      continue;
    }

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    result.push(toEnvVar(key, value, 'secrets', pendingComment.join(' ') || undefined, mask));
    pendingComment = [];
  }

  return result;
}

function toEnvVar(
  key: string,
  value: string,
  source: EnvVar['source'],
  comment?: string,
  mask = true,
): EnvVar {
  const isSecret = isSecretEnvKey(key);
  return {
    id: `${source}:${key}`,
    key,
    value: isSecret && mask ? maskValue(value) : value,
    isSecret,
    source,
    comment,
  };
}

/** Показываем начало и хвост: этого хватает, чтобы отличить один токен от другого. */
function maskValue(value: string): string {
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 4)}${'•'.repeat(Math.min(12, value.length - 8))}${value.slice(-4)}`;
}

/**
 * Комментарий → строки файла. Каждая строка получает свой `#`: комментарий с
 * переводом строки, записанный одной строкой, развалил бы файл (вторая половина
 * стала бы «мусорной» строкой без `=`, и parseEnvFile молча её потерял бы).
 */
function commentLines(comment: string | undefined): string[] {
  if (!comment?.trim()) return [];
  return comment.split(/\r?\n/).map((part) => `# ${part.trim()}`.trimEnd());
}

/**
 * Начало непрерывного блока комментариев прямо над строкой `index` — ровно то,
 * что parseEnvFile привязывает к переменной (до пустой строки или не-комментария).
 */
function commentBlockStart(lines: string[], index: number): number {
  let start = index;
  while (start > 0 && (lines[start - 1]?.trim().startsWith('#') ?? false)) start -= 1;
  return start;
}

/** Обновляет строку в env-файле на месте, сохраняя порядок и комментарии. */
function upsertEnvFileLine(
  path: string,
  key: string,
  value: string,
  comment: string | undefined,
  backupDir?: string,
): string | undefined {
  const lines = readTextFile(path).split(/\r?\n/);
  const index = lines.findIndex((line) => startsWithKey(line, key));

  if (index >= 0) {
    lines[index] = `${key}=${value}`;

    // Комментарий — часть той же записи: parseEnvFile отдаёт его форме вместе с
    // переменной, deleteSecretLine удаляет вместе с ней. Ветка правки его
    // раньше игнорировала: пользователь исправлял текст «где перевыпустить
    // токен», панель отвечала «сохранено», а в файле оставался старый.
    //
    // `undefined` = поля не присылали (массовое добавление строк `KEY=value`) —
    // чужой комментарий тогда не трогаем. Строка, в том числе пустая, = форма
    // прислала поле целиком, и оно итоговое: пусто → комментарий убираем.
    if (comment !== undefined) {
      const start = commentBlockStart(lines, index);
      const current = lines
        .slice(start, index)
        .map((line) => line.trim().replace(/^#\s?/, ''))
        .join(' ');

      // Не изменился — блок не трогаем вовсе: иначе многострочный комментарий
      // схлопывался бы в одну строку от одной лишь правки значения.
      if (current !== comment) lines.splice(start, index - start, ...commentLines(comment));
    }
  } else {
    if (lines.at(-1)?.trim() !== '') lines.push('');
    lines.push(...commentLines(comment));
    lines.push(`${key}=${value}`);
  }

  return writeTextFile(path, lines.join('\n'), { backupDir });
}

function startsWithKey(line: string, key: string): boolean {
  const trimmed = line.trim();
  return !trimmed.startsWith('#') && trimmed.startsWith(`${key}=`);
}
