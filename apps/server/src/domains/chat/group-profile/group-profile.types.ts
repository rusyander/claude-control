import type { CascadeStage } from '@agentdeck/contracts/model-cascade';

/** Запись MCP-сервера, как её видит профиль: имя и настройка из файла. */
export interface ProfileMcpEntry {
  id: string;
  config: Record<string, unknown>;
}

/** Зачем сервер группе — по этому решается, едет ли он в её прогон. */
export type McpRole = 'tracker' | 'forge' | 'design' | 'messenger' | 'other';

export interface GroupProfileInput {
  /** Серверы из файлов настроек: личные и проектный `.mcp.json`, только включённые. */
  entries: readonly ProfileMcpEntry[];
  /** Текст задач группы: задачи, бриф, заметки, общее, ответ человека. */
  tasksText: string;
  /** Серверы, которые группа уже попросила блоком `mcp` (`group.mcpExtra`). */
  extra: readonly string[];
  /** Навыки и плагины прогона (1.3); нет — перечень навыков не трогается. */
  skills?: SkillScopeInput;
  /**
   * Звено цепочки, которое пойдёт этим прогоном (L1.2, L1.3): план и ревью
   * (проверка правок — тоже ревью) получают MCP трекера и хранилища кода только
   * на чтение; ревью, правки и доставка — описания только своих навыков. Нет —
   * профиль группы целиком, как до разбивки по звеньям.
   */
  stage?: CascadeStage;
  /**
   * Окно автосжатия группы в токенах (2.1, рычаг A/B): `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
   * прогона. Нет — CLI решает сам, как до плана.
   */
  compactWindow?: number;
  /**
   * Команда хука свёртки ответов трекера (2.3): `node "<abs>/tools/tracker-brief-hook.mjs"`.
   * Нет — хука нет.
   */
  trackerHook?: string;
  /**
   * Команда хука списка задач без описаний (5.2): `node "<abs>/tools/board-fields-hook.mjs"`.
   * Нет — хука нет.
   */
  boardHook?: string;
  /**
   * Очередь тяжёлых шагов (3.2): команда хука `tools/heavy-queue-hook.mjs` и общий
   * на машину каталог очереди. Нет — группы гоняют гейты, не дожидаясь друг друга.
   */
  heavyQueue?: { hook: string; dir: string };
  /**
   * `BASH_MAX_TIMEOUT_MS`, уже действующие для прогона: окружение панели, личные и
   * проектные настройки. Профиль потолок только поднимает — больший из них остаётся.
   */
  bashCeilings?: readonly (string | undefined)[];
}

/** Что профилю известно о навыках: личные, навыки групп панели прогона, плагины. */
export interface SkillScopeInput {
  /** Имена включённых личных навыков (`~/.claude/skills`). */
  user: readonly string[];
  /** Навыки групп панели, действующих в прогоне, — им описание оставляется. */
  group: readonly string[];
  /** Включённые плагины (`enabledPlugins`), `имя@каталог`. */
  plugins: readonly string[];
}

/** Почему сервер не поехал — строка для группы и для тестов. */
export type DropReason = 'messenger' | 'no-design-link' | 'duplicate-tracker';

export interface GroupProfile {
  kept: ProfileMcpEntry[];
  dropped: { id: string; reason: DropReason }[];
}

/** Что реестр прогонов кладёт в запуск группы. */
export interface GroupRunProfile {
  /** `--strict-mcp-config`: всё, что не приехало своим `--mcp-config`, снято. */
  args: string[];
  /** Подключения claude.ai снимаются переменной — флаг их не касается. */
  env: Record<string, string>;
  /** Оставленные серверы — своим `--mcp-config`. Нет — серверы прогона не трогаются. */
  mcp?: { ids: string[]; config: unknown };
  /** Строка к системному промпту: что подключено, что снято и как попросить. */
  note: string;
  /**
   * Настройки поверх личных (`--settings`, 1.3): `skillOverrides` — навыкам вне
   * группы только имя, `enabledPlugins` — плагины не по делу выключены. Пусто —
   * навыки не тронуты.
   */
  settings: Record<string, unknown>;
}

/** Профиль, который сам решает набор серверов прогона: группа и чат вопросов о ходе. */
export type ServerSetRunProfile = GroupRunProfile & Required<Pick<GroupRunProfile, 'mcp'>>;
