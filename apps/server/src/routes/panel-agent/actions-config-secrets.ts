import type { McpServer } from '@agentdeck/contracts';
import {
  isSecretFree,
  isSecretName,
  maskArgList,
  maskNamedValue,
  maskSecretsInText,
} from '../../lib/secret-mask.ts';

/**
 * Секреты в действиях «Конфигурация» (А7): что модель НЕ видит и что она не
 * может прислать.
 *
 * Маршрут `GET /api/mcp` отдаёт env и заголовки серверов как есть — окну панели
 * они нужны для формы правки. Модели — нет: всё, что прочитано действием, едет
 * в её контекст и дальше в журнал запросов провайдера. Поэтому проекция для
 * модели прячет значения ТЕМ ЖЕ детектором, что дифф карточки
 * (`lib/secret-mask.ts`), и отказ в приёме секрета от модели считается им же:
 * «маскируется при чтении» и «не принимается при записи» не могут разойтись.
 * Ссылки `${VAR}` остаются — это не секрет, а адрес секрета.
 */

export { isSecretFree };

const maskRecord = (record: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, maskNamedValue(key, value)]),
  );

/** Аргумент после флага-секрета (`--token abc`) прячется так же, как `--token=abc`. */
export function maskArgs(args: readonly string[]): string[] {
  return maskArgList(args);
}

/** Сервер MCP для модели: без значений секретов и без служебных полей окна. */
export function maskMcpServer(server: McpServer): Record<string, unknown> {
  return {
    name: server.name,
    transport: server.transport,
    ...(server.command ? { command: maskSecretsInText(server.command) } : {}),
    args: maskArgs(server.args),
    ...(server.url ? { url: maskSecretsInText(server.url) } : {}),
    env: maskRecord(server.env),
    headers: maskRecord(server.headers),
    isEnabled: server.isEnabled,
    health: server.health,
    hasOAuth: server.hasOAuth,
    groupIds: server.groupIds,
  };
}

/**
 * Где модель пытается прислать секрет открытым текстом — пути полей для отказа.
 * Секрет вводит только человек, на странице MCP; модель оставляет поле пустым
 * или ссылкой `${VAR}`.
 */
export function literalSecretPaths(draft: {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  args?: string[];
  url?: string;
  command?: string;
}): string[] {
  const found: string[] = [];
  const check = (field: string, record: Record<string, string> | undefined): void => {
    for (const [key, value] of Object.entries(record ?? {})) {
      if (maskNamedValue(key, value) !== value) found.push(`${field}.${key}`);
    }
  };
  check('env', draft.env);
  check('headers', draft.headers);
  maskArgs(draft.args ?? []).forEach((masked, index) => {
    if (masked !== draft.args?.[index]) found.push(`args.${index}`);
  });
  if (draft.url && maskSecretsInText(draft.url) !== draft.url) found.push('url');
  if (draft.command && maskSecretsInText(draft.command) !== draft.command) found.push('command');
  return found;
}

/** Секретные поля, оставшиеся пустыми, — их человеку предстоит заполнить. */
export function emptySecretFields(draft: {
  env: Record<string, string>;
  headers: Record<string, string>;
}): string[] {
  const empty = (field: string, record: Record<string, string>): string[] =>
    Object.entries(record)
      .filter(([key, value]) => isSecretName(key) && value.trim() === '')
      .map(([key]) => `${field}.${key}`);
  return [...empty('env', draft.env), ...empty('headers', draft.headers)];
}

/**
 * Что у сохранённого сервера уже лежит секретного: значения, которые маска
 * прячет, и вход OAuth. Пусто — перенацеливать сервер безопасно.
 */
export function storedSecretPaths(server: McpServer): string[] {
  return [...literalSecretPaths(server), ...(server.hasOAuth ? ['oauth'] : [])];
}

const MASKED_ID = 'masked:';

/**
 * Id права — это `решение:шаблон`, то есть шаблон целиком, и секрет из
 * `Bash(curl -H "Authorization: Bearer …":*)` уехал бы модели в id, даже когда
 * поле `pattern` рядом замаскировано. Такому праву модель получает непрозрачный
 * id из хеша; удаление находит право по нему, перечитав список.
 */
export function permissionIdForModel(id: string, hash: (value: string) => string): string {
  return maskSecretsInText(id) === id ? id : `${MASKED_ID}${hash(id).slice(0, 16)}`;
}

/** Настоящий id права по тому, что прислала модель; `undefined` — не нашли. */
export function resolvePermissionId(
  sent: string,
  ids: readonly string[],
  hash: (value: string) => string,
): string | undefined {
  if (!sent.startsWith(MASKED_ID)) return sent;
  return ids.find((id) => permissionIdForModel(id, hash) === sent);
}
