/**
 * Выключатель инструментов MCP группы в OpenCode (P-16, план экономии 6.1).
 *
 * Панель кладёт в окружение прогона один свой ключ — список шаблонов имён
 * инструментов (`<сервер>_*` — сервер целиком, `<сервер>_<имя>` — одно имя). До CLI
 * он не доходит: живая сессия `opencode serve` получает его правилами `deny` набора
 * сессии, одиночный `opencode run` — переменной `OPENCODE_PERMISSION` (правило
 * `<шаблон>: deny`). Оба канала снимают имя из запроса к модели (проверено
 * OpenCode 1.18.35 телом запроса: `check-opencode-mcp-off.mjs`). Ключ — настройка,
 * которую общий сервер применяет сам, поэтому ход с ним не уходит в одиночный запуск.
 */
export const OPENCODE_TOOL_DENY_ENV = 'AGENTDECK_OPENCODE_TOOL_DENY';

/** Имя сервера или инструмента так, как OpenCode складывает имя инструмента MCP. */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Шаблоны имён: снятые серверы целиком и снятые поимённо инструменты остальных. */
export function opencodeToolDeny(
  off: readonly string[],
  tools?: Readonly<Record<string, readonly string[]>>,
): string[] {
  const servers = off.filter(Boolean).map((name) => `${sanitize(name)}_*`);
  const named = Object.entries(tools ?? {})
    .filter(([server]) => server && !off.includes(server))
    .flatMap(([server, names]) =>
      names.filter(Boolean).map((name) => `${sanitize(server)}_${sanitize(name)}`),
    );
  return [...new Set([...servers, ...named])];
}

/** Шаблоны из окружения прогона; нет ключа или битое значение — пусто. */
export function readToolDeny(env: Readonly<Record<string, string>> | undefined): string[] {
  const raw = env?.[OPENCODE_TOOL_DENY_ENV];
  if (raw === undefined) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
  } catch {
    return [];
  }
}

/**
 * Окружение одиночного `opencode run`: ключ панели снят, шаблоны — правилами `deny`
 * в `OPENCODE_PERMISSION` поверх того, что там уже было (объект человека не теряется;
 * не объект — заменяется: OpenCode сам пропустил бы битый JSON). Нет ключа — как было.
 */
export function withToolDenyEnv(
  env: Record<string, string>,
  inherited: string | undefined,
): Record<string, string> {
  if (!(OPENCODE_TOOL_DENY_ENV in env)) return env;
  const deny = readToolDeny(env);
  const { [OPENCODE_TOOL_DENY_ENV]: _own, ...rest } = env;
  if (deny.length === 0) return rest;
  const base = parseObject(rest.OPENCODE_PERMISSION ?? inherited);
  const permission = { ...base, ...Object.fromEntries(deny.map((pattern) => [pattern, 'deny'])) };
  return { ...rest, OPENCODE_PERMISSION: JSON.stringify(permission) };
}

function parseObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Правила набора сессии: `deny` на каждый шаблон — последними, OpenCode судит последним. */
export function toolDenyRules(
  deny: readonly string[],
): { permission: string; pattern: string; action: 'deny' }[] {
  return deny.map((permission) => ({ permission, pattern: '*', action: 'deny' as const }));
}
