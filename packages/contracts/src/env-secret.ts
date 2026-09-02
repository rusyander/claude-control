/**
 * Секрет ли переменная окружения — ЕДИНСТВЕННОЕ правило для сервера и формы.
 *
 * Решает имя: одно из слов TOKEN, SECRET, KEY, PASSWORD, PAT, CREDENTIAL(S)
 * стоит ЦЕЛЫМ сегментом между подчёркиваниями или у края имени. Подстрока не
 * считается: GIT_BASH_PATH — не PAT, MAX_THINKING_TOKENS — не TOKEN, а вот
 * GITLAB_PERSONAL_ACCESS_TOKEN, ANTHROPIC_API_KEY и GITHUB_PAT — секреты.
 *
 * Пока правило жило двумя копиями (сервер и форма), они расходились: сервер
 * знал слово CREDENTIAL, форма — нет, и переменная с ним уезжала в settings.json
 * открытым текстом, а список показывал её замаскированной. Путь к bash с
 * подстрокой PAT в обеих копиях считался токеном.
 *
 * ВАЖНО про импорт на сервере: он идёт под `node --experimental-strip-types` и
 * значения из бочки `@claude-control/contracts` брать не может (реэкспорты без
 * расширений Node не резолвит). Поэтому модуль самодостаточен и вынесен в свою
 * точку экспорта `@claude-control/contracts/env-secret`. Импортов сюда не
 * добавлять — сервер перестанет стартовать.
 */
const SECRET_WORD = /(?:^|_)(?:TOKEN|SECRET|KEY|PASSWORD|PAT|CREDENTIALS?)(?:_|$)/i;

/** Слова, по которым имя считается секретом — для справки и подсказок, тот же список. */
export const SECRET_ENV_WORDS: readonly string[] = [
  'TOKEN',
  'SECRET',
  'KEY',
  'PASSWORD',
  'PAT',
  'CREDENTIAL',
];

export function isSecretEnvKey(key: string): boolean {
  return SECRET_WORD.test(key);
}

/**
 * Допустимое имя переменной окружения: латинские буквы, цифры и подчёркивание,
 * не с цифры. Так его понимают и оболочка, и `env` в settings.json, и строка
 * `KEY=value` в .mcp-secrets.env — пробел или перевод строки в имени ломают
 * env-файл, а перевод строки ещё и дописывает в него чужую переменную.
 */
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
