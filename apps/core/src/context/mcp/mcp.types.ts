/** Инструмент сервера MCP человека, как его назвал `tools/list`. */
export interface OfferedTool {
  name: string;
  /**
   * Подсказка сервера `readOnlyHint`: `true` — только читает; `false` или нет подсказки —
   * считается пишущим (шаг только чтения его не получит: без подсказки «читает» не доказано).
   */
  readOnly: boolean | null;
}

/** Сервер человека, доступный проекту (порт `mcp-source` панели: пользовательские и `.mcp.json`). */
export interface McpOffer {
  id: string;
  /** Инструменты сервера; `null` — список не прочитан (сервер не ответил). */
  tools: readonly OfferedTool[] | null;
  /** Цена инструментов в окне, токенов; `null` — не замерена. */
  tokens: number | null;
}

/** Факт маршрута, под которым живёт список: окно модели (`route.context`) и локальность. */
export interface McpRouteFact {
  id: string;
  /** Маршрут на этой машине (своя модель): окно мало, сервер человека берётся только в запас окна. */
  local: boolean;
  /** Окно модели, токенов; `null` — факт `unknown`. */
  contextTokens: number | null;
}

export interface McpListInput {
  offers: readonly McpOffer[];
  /** Выбор человека по виду шага: какие свои серверы он дал этому виду (строгий список, по умолчанию — ни одного). */
  picks: Readonly<Partial<Record<string, readonly string[]>>>;
  /** База сеанса без MCP человека, токенов (замер G9) — для запаса окна. */
  baseTokens: number;
  /** Инструменты ядра (`agentdeck`), что этот CLI показал бы модели, — для запретов не своего вида. */
  coreTools: readonly string[];
}

export interface McpDropped {
  id: string;
  reason: string;
}

export interface McpList {
  stepKind: string;
  /** Серверы строгого списка: ядро (`agentdeck`, `agentdeck-permit`) + выбранные человеком. */
  servers: string[];
  /** Полные имена `mcp__<server>__<tool>`, запрещённые шагу (пишущие в шаге чтения, ядра не своего вида). */
  deniedTools: string[];
  dropped: McpDropped[];
  /** Запас окна после списка (локальный маршрут с известным окном), иначе `null`. */
  headroom: number | null;
  /** Отпечаток списка — `mcpHash` ключа базы. */
  hash: string;
}
