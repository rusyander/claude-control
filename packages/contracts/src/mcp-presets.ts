import type { McpTransport } from './mcp';

/**
 * Готовые заготовки MCP-серверов. Смысл в том, чтобы не вспоминать имя пакета
 * и синтаксис запуска: выбираете сервер — поля заполняются, остаётся вписать
 * свои значения переменных.
 */
/**
 * Подстановка домашнего каталога в аргументах заготовки.
 *
 * Раньше в пресете файловой системы стоял буквальный `C:/work` — на Linux и
 * macOS такого пути нет вовсе, и заготовка получалась нерабочей. Настоящий
 * путь знает только сервер (`/api/system`), а contracts работают и на фронте,
 * поэтому здесь стоит метка, которую форма заменяет при подстановке.
 */
export const HOME_DIR_TOKEN = '{{home}}';

export interface McpPreset {
  id: string;
  title: string;
  description: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  /** Переменные, которые нужно заполнить. Значения — подсказки, не секреты. */
  env: Record<string, string>;
  /** Требует ли сервер токена: интерфейс подскажет вынести его в файл секретов. */
  needsSecret: boolean;
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'filesystem',
    title: 'Файловая система',
    description: 'Доступ к файлам в указанных каталогах: чтение, запись, поиск.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', HOME_DIR_TOKEN],
    env: {},
    needsSecret: false,
  },
  {
    id: 'github',
    title: 'GitHub',
    description: 'Репозитории, issues, pull requests на github.com.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    needsSecret: true,
  },
  {
    id: 'gitlab',
    title: 'GitLab',
    description: 'Merge requests, ветки, коммиты и комментарии в GitLab.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@zereight/mcp-gitlab'],
    env: { GITLAB_API_URL: 'https://gitlab.example.com/api/v4', GITLAB_PERSONAL_ACCESS_TOKEN: '' },
    needsSecret: true,
  },
  {
    id: 'postgres',
    title: 'PostgreSQL',
    description: 'Чтение схемы и выполнение запросов к базе.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
    env: {},
    needsSecret: true,
  },
  {
    id: 'playwright',
    title: 'Playwright',
    description: 'Управление браузером: открыть страницу, кликнуть, снять скриншот.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    env: {},
    needsSecret: false,
  },
  {
    id: 'sse',
    title: 'Локальный SSE-сервер',
    description: 'Подключение к уже работающему серверу по адресу — например, Figma Dev Mode.',
    transport: 'sse',
    args: [],
    url: 'http://127.0.0.1:3845/sse',
    env: {},
    needsSecret: false,
  },
];
