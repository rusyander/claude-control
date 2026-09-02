import type {
  EnvVar,
  McpServer,
  PermissionRule,
  UniversalMcpServer,
} from '@claude-control/contracts';

/** Доступ к данным Claude — его читатели живут на своих файлах и знают про группы. */
export interface ClaudeSide {
  /** `~/.claude.json` — там же живут MCP-серверы. */
  mcpConfigPath: string;
  /** `~/.claude/settings.json` — переменные окружения и права; подпись колонки. */
  settingsPath: string;
  /** Путь CLAUDE.md выбирается обнаружением каталога, а не строится заново. */
  claudeMdPath: string;
  readMcp: () => McpServer[];
  readEnv: () => EnvVar[];
  readPermissions: () => PermissionRule[];
  /** Запись MCP-сервера в файл Claude; путь передаётся отдельно ради предпросмотра. */
  writeMcp: (filePath: string, server: UniversalMcpServer, backupDir: string | undefined) => void;
}

export interface CompareDeps {
  claudeDirOverride?: string;
  claude: ClaudeSide;
  /** Каталог резервных копий; в предпросмотре не используется. */
  backupDir?: string;
}

/** Одна прочитанная сторона раздела: что нашли и почему могли не найти. */
export interface SideRead {
  supported: boolean;
  filePath?: string;
  note?: string;
  rows: Row[];
}

/** Запись раздела, приведённая к общему виду. */
export interface Row {
  key: string;
  /** Что показать человеку. */
  display: string;
  /** По чему считать равенство. Не задано — сравниваем по `display`. */
  compare?: string;
  /** Значение не сравнивается по содержимому (секрет) — сверяем только наличие. */
  opaque?: boolean;
  /** Почему запись нельзя перенести. */
  blocked?: string;
  /** Данные для переноса. */
  payload?: UniversalMcpServer;
}

/** Неизвестный провайдер или сравнение провайдера с самим собой — маршрут ответит 400. */
export class CompareRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompareRequestError';
  }
}
