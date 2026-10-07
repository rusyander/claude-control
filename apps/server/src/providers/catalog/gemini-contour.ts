import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Почему Gemini CLI пойдёт по адресу контура только с ключом API.
 *
 * Адрес (`GOOGLE_GEMINI_BASE_URL`) gemini 0.62 читает лишь при способе входа
 * `gemini-api-key`: вход Google-аккаунтом и Vertex AI ходят своими серверами, и
 * переменной, которая их перебила бы, нет. Способа не задано вовсе — CLI сам
 * выбирает `gateway` по той же переменной адреса и падает «Invalid auth method
 * selected» (живая проба 07.10.2026, `x7/gemini-probe`). Сменить способ одним
 * прогоном нельзя: перебивающий файл системных настроек CLI принимает только из
 * каталога, писать в который может лишь администратор.
 *
 * Поэтому решение — до запуска: способ входа не `gemini-api-key` → контур
 * отказывает, назвав настройку (обязательный) или идёт мимо, сказав это (по
 * возможности).
 */

/** Способ входа, при котором CLI идёт по `GOOGLE_GEMINI_BASE_URL`. */
export const GEMINI_CONTOUR_AUTH = 'gemini-api-key';

/** Название настройки для отказа: имя и значение, которого она требует. */
export const GEMINI_AUTH_SETTING = `security.auth.selectedType ≠ "${GEMINI_CONTOUR_AUTH}"`;

function readSettings(file: string): Record<string, unknown> {
  try {
    const root: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return root && typeof root === 'object' && !Array.isArray(root)
      ? (root as Record<string, unknown>)
      : {};
  } catch {
    // Нет файла или он не JSON: своего способа входа он не задаёт.
    return {};
  }
}

/** Способ входа из одного файла: нынешний ключ, затем старый (`selectedAuthType`). */
function authOf(settings: Record<string, unknown>): string | undefined {
  const security = settings.security as Record<string, unknown> | undefined;
  const auth = security?.auth as Record<string, unknown> | undefined;
  const value = auth?.selectedType ?? settings.selectedAuthType;
  return typeof value === 'string' && value ? value : undefined;
}

/** Системные настройки CLI: переменная перебивает каталог ОС (`Storage.getSystemSettingsPath`). */
function systemSettingsPath(): string {
  const override = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  if (override) return override;
  if (process.platform === 'win32') return 'C:\\ProgramData\\gemini-cli\\settings.json';
  if (process.platform === 'darwin') return '/Library/Application Support/GeminiCli/settings.json';
  return '/etc/gemini-cli/settings.json';
}

function systemDefaultsPath(): string {
  return (
    process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ??
    join(dirname(systemSettingsPath()), 'system-defaults.json')
  );
}

/**
 * Способ входа, который выберет CLI: системные настройки сильнее пользовательских,
 * те — умолчаний системы. Настройки проекта (`<проект>/.gemini/settings.json`) не
 * читаются: CLI берёт их только у доверенной папки, а прогон о папке здесь не
 * знает, — проект, сменивший способ входа, получит отказ уже от самого CLI.
 */
export function geminiAuthType(
  userSettings: string = join(homedir(), '.gemini', 'settings.json'),
): string | undefined {
  return (
    authOf(readSettings(systemSettingsPath())) ??
    authOf(readSettings(userSettings)) ??
    authOf(readSettings(systemDefaultsPath()))
  );
}

/** Настройка, из-за которой контур не дойдёт до CLI; `undefined` — дойдёт. */
export function geminiContourBypass(userSettings?: string): string | undefined {
  return geminiAuthType(userSettings) === GEMINI_CONTOUR_AUTH ? undefined : GEMINI_AUTH_SETTING;
}
