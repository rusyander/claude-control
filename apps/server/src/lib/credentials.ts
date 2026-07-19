import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  chmodSync,
  openSync,
  closeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/**
 * Доступ Claude Code к аккаунту — там, где его держит конкретная система.
 *
 * Зачем это вообще нужно. Чат, помощник форм, плагины и MCP запускают `claude`
 * в вашем настоящем каталоге конфигурации, и авторизацией занимается сам CLI —
 * панели там знать ничего не нужно. Исключение одно: **песочница**. Она
 * намеренно собирает пустой временный каталог и запускает Claude с
 * `CLAUDE_CONFIG_DIR`, поэтому доступ туда надо перенести руками.
 *
 * Дальше начинаются различия систем. На Windows и Linux токен лежит файлом
 * `<config>/.credentials.json`. На macOS его там нет — Claude Code держит токен
 * в связке ключей. Поэтому источник ищется цепочкой, а не по одному пути.
 */

export type CredentialsSource =
  /** `<config>/.credentials.json` — Windows и Linux. */
  | 'file'
  /** Связка ключей macOS. */
  | 'keychain'
  /** Файл, которым управляет сама панель: ручной ввод и нестандартные случаи. */
  | 'panel'
  /** Ключ Anthropic API — им Claude Code тоже авторизуется. */
  | 'apiKey'
  | 'none';

export interface CredentialsLookup {
  source: CredentialsSource;
  /** Содержимое `.credentials.json` — готовое к записи в каталог песочницы. */
  content?: string;
  /** Ключ API: его передают переменной окружения, а не файлом. */
  apiKey?: string;
  /** Почему не нашлось — текст для интерфейса, а не для журнала. */
  reason?: string;
}

/**
 * Имя записи в связке ключей macOS. Переопределяется переменной окружения:
 * Anthropic может её переименовать, и тогда достаточно подставить своё имя,
 * не трогая код.
 */
const KEYCHAIN_SERVICES = [
  process.env.CLAUDE_CONTROL_KEYCHAIN_SERVICE,
  'Claude Code-credentials',
  'Claude Code',
].filter((name): name is string => Boolean(name));

/** Связка ключей может спросить разрешение — дольше этого не ждём. */
const KEYCHAIN_TIMEOUT_MS = 10_000;

/** Файл панели: сюда попадает то, что ввели руками в настройках. */
export function panelCredentialsPath(): string {
  return join(homedir(), '.claude-control', 'credentials.json');
}

/**
 * Что панель принимает в своём файле. Три формы, все разбираются одинаково
 * прозрачно — какая удобнее, ту и используйте.
 */
interface PanelCredentials {
  /** Точная форма Claude Code: кладётся в песочницу как есть. */
  claudeAiOauth?: Record<string, unknown>;
  /** Ключ Anthropic API вместо токена подписки. */
  apiKey?: string;
  /** Путь к своему файлу с токеном — панель прочитает его вместо своего. */
  readFrom?: string;
}

export function readClaudeCredentials(configRoot: string): CredentialsLookup {
  // Заданное руками идёт первым — и это главное в порядке.
  //
  // Задают его ровно тогда, когда автоматический источник не работает:
  // токен просрочен, связка ключей недоступна, файл лежит не там. Если бы
  // штатный источник побеждал, ручная настройка не помогала бы в тех самых
  // случаях, ради которых она и нужна. Убрать её можно кнопкой в настройках.
  const panel = readPanelFile();
  if (panel?.content || panel?.apiKey) return panel;

  const standard = readStandard(configRoot);
  if (standard.content) return standard;

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) return { source: 'apiKey', apiKey };

  // Причина от разбора ручного файла точнее общей: она называет конкретную
  // ошибку в том, что человек только что вводил.
  return panel?.reason ? panel : { source: 'none', reason: notFoundReason(configRoot) };
}

/** Штатный источник системы: файл везде, кроме macOS, где это связка ключей. */
function readStandard(configRoot: string): CredentialsLookup {
  const path = join(configRoot, '.credentials.json');

  if (existsSync(path)) {
    try {
      return { source: 'file', content: readFileSync(path, 'utf8') };
    } catch {
      return { source: 'none', reason: `Файл ${path} не читается — проверьте права доступа.` };
    }
  }

  if (process.platform === 'darwin') return readFromKeychain();

  return { source: 'none' };
}

/**
 * Чтение из связки ключей macOS.
 *
 * Первый запрос система сопроводит окном «node хочет получить доступ к ключу» —
 * это нормально и происходит один раз, если нажать «Всегда разрешать».
 */
function readFromKeychain(): CredentialsLookup {
  for (const service of KEYCHAIN_SERVICES) {
    try {
      const value = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
        encoding: 'utf8',
        timeout: KEYCHAIN_TIMEOUT_MS,
        // Диалог связки пишет в stderr — в вывод сервера он не нужен.
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      // В связке лежит тот же JSON, что и в файле на других системах.
      if (value.startsWith('{')) return { source: 'keychain', content: value };
    } catch {
      // Записи с таким именем нет либо в доступе отказано — пробуем следующее.
    }
  }

  return { source: 'none' };
}

/** Файл панели: ручной ввод, свой путь или ключ API. */
function readPanelFile(): CredentialsLookup | undefined {
  const path = panelCredentialsPath();
  if (!existsSync(path)) return undefined;

  let parsed: PanelCredentials;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as PanelCredentials;
  } catch {
    return {
      source: 'none',
      reason: `Файл ${path} — не JSON. Исправьте его или удалите: панель тогда вернётся к обычному поиску.`,
    };
  }

  if (parsed.readFrom) {
    if (!existsSync(parsed.readFrom)) {
      return { source: 'none', reason: `Указанный файл не найден: ${parsed.readFrom}` };
    }
    try {
      return { source: 'panel', content: readFileSync(parsed.readFrom, 'utf8') };
    } catch {
      return { source: 'none', reason: `Файл ${parsed.readFrom} не читается.` };
    }
  }

  if (parsed.claudeAiOauth) {
    return { source: 'panel', content: JSON.stringify({ claudeAiOauth: parsed.claudeAiOauth }) };
  }

  if (parsed.apiKey?.trim()) return { source: 'panel', apiKey: parsed.apiKey.trim() };

  return {
    source: 'none',
    reason: `В файле ${path} нет ни одного известного поля: ожидается claudeAiOauth, apiKey или readFrom.`,
  };
}

function notFoundReason(configRoot: string): string {
  const path = join(configRoot, '.credentials.json');

  return process.platform === 'darwin'
    ? 'Ни в связке ключей macOS, ни в файле доступ не найден. Войдите командой `claude` в терминале ' +
        'или задайте доступ вручную в настройках панели.'
    : `Файл ${path} не найден. Войдите командой \`claude\` в терминале ` +
        'или задайте доступ вручную в настройках панели.';
}

/**
 * Проверка того, что ввели руками, — до записи на диск. Ошибку лучше показать
 * сразу, чем потом ловить её отказом песочницы.
 */
export function validatePanelCredentials(raw: string): { ok: true } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'Пусто: вставьте JSON или ключ API.' };

  let parsed: PanelCredentials;
  try {
    parsed = JSON.parse(text) as PanelCredentials;
  } catch {
    return { ok: false, error: 'Это не JSON. Проверьте кавычки и запятые.' };
  }

  if (parsed.readFrom) {
    if (!existsSync(parsed.readFrom)) {
      return { ok: false, error: `Файл не найден: ${parsed.readFrom}` };
    }
    return { ok: true };
  }

  if (parsed.claudeAiOauth) {
    const token = (parsed.claudeAiOauth as { accessToken?: unknown }).accessToken;
    if (typeof token !== 'string' || !token) {
      return { ok: false, error: 'В claudeAiOauth нет поля accessToken со строкой.' };
    }
    return { ok: true };
  }

  if (typeof parsed.apiKey === 'string' && parsed.apiKey.trim()) return { ok: true };

  return {
    ok: false,
    error: 'Нужно одно из полей: claudeAiOauth (с accessToken), apiKey или readFrom.',
  };
}

/**
 * Запись файла с секретом: права 600 **с момента создания**.
 *
 * Не `writeFileSync` + `chmodSync`: между ними файл успевает полежать с
 * обычными правами, и в этот промежуток его может прочитать кто угодно на
 * машине. Здесь права задаются самим вызовом создания.
 *
 * Старый файл сначала удаляется: `mode` действует только при создании, и
 * перезапись сохранила бы прежние — возможно, широкие — права. Флаг `wx`
 * означает «создать, а если уже существует — упасть»: за это время на место
 * файла нельзя подсунуть ссылку на чужой путь.
 */
export function writeSecretFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  // Каталог мог существовать раньше с более широкими правами — сужаем.
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    // На Windows права POSIX не действуют: каталог и так внутри профиля.
  }

  rmSync(path, { force: true });

  const handle = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(handle, content, 'utf8');
  } finally {
    closeSync(handle);
  }
}

/** Файл панели с доступом к аккаунту. */
export function savePanelCredentials(raw: string): void {
  writeSecretFile(panelCredentialsPath(), `${raw.trim()}\n`);
}

export function removePanelCredentials(): void {
  rmSync(panelCredentialsPath(), { force: true });
}
