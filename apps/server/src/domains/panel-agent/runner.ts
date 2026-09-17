import type { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  PanelAgentMessage,
  PanelAgentPageContext,
  PanelAgentRunEvent,
} from '@agentdeck/contracts/panel-agent';
import {
  PANEL_AGENT_BRIDGE_ID,
  PANEL_AGENT_MCP_TOOL_TIMEOUT_MS,
  PANEL_AGENT_RUN_TIMEOUT_MS,
} from '@agentdeck/contracts/panel-agent';
import { spawnCliProcess } from '../../lib/cli-spawn.ts';
import { lightWindowLayers } from '../platform/layers.ts';
import { killChildTree } from '../../lib/process-tree.ts';

/**
 * Один ход агента панели процессом `claude -p`.
 *
 * Агент — ЛЁГКОЕ окно (решение владельца 3): ни файловой системы, ни оболочки,
 * ни правки — только инструменты панели через переходник. Каждый флаг ниже
 * держит это обещание, и снятие любого из них отдаёт агенту больше, чем ему
 * положено:
 * - `--tools ""` — встроенных инструментов нет вовсе (Read/Bash/Edit…);
 * - `--strict-mcp-config` + свой `--mcp-config` — из MCP только переходник, ни
 *   личные серверы человека, ни `.mcp.json` проекта;
 * - `--allowedTools mcp__agentdeck-panel__*` — вызовы переходника идут без
 *   вопроса CLI: спрашивать в `-p` некого, а подтверждение живёт в карточке панели;
 * - наши слои сняты ВСЕ и теми же флагами, что снятые галочки контура
 *   (`lightWindowLayers`, `platform/layers.ts`): `--setting-sources local` — ни
 *   личных хуков, прав и правил, ни `~/.claude/CLAUDE.md`, который CLI иначе
 *   находит поиском вверх от временной папки; `--disable-slash-commands` — скиллы
 *   ведут к инструментам, которых здесь нет; `--strict-mcp-config` — см. выше;
 * - `--no-session-persistence` — ход не ложится в `~/.claude/projects` и не
 *   всплывает в чатах человека; история — файл панели.
 *
 * Системный промпт уходит ФАЙЛОМ (`--append-system-prompt-file`), разговор — в
 * stdin: на Windows текст с кавычками и переводами строк в argv разваливается
 * (`.claude/gotchas.md` §Sessions).
 */

export const PANEL_AGENT_TOOL_PREFIX = `mcp__${PANEL_AGENT_BRIDGE_ID}__`;

/** Путь к переходнику: лежит в репозитории панели, как и переходник контура. */
export function panelBridgeScript(): string {
  return fileURLToPath(new URL('../../../../../tools/mcp/panel.mjs', import.meta.url));
}

/** Системная дописка: модель читает её каждый ход, поэтому английская и сжатая. */
export function panelAgentSystemPrompt(context: PanelAgentPageContext): string {
  const where = [
    `route ${context.route}`,
    ...(context.title ? [`page "${context.title}"`] : []),
    ...(context.projectPath ? [`selected project ${context.projectPath}`] : []),
  ].join(', ');
  return [
    'You are the agent of the AgentDeck panel (a local web app over Claude Code configuration).',
    `You act ONLY through the tools of the "${PANEL_AGENT_BRIDGE_ID}" MCP server; each tool is one panel action.`,
    'You have no file system, shell or editing tools. Never claim an action happened unless a tool result says so.',
    'Change/danger actions wait for the human to click a confirmation card in the panel. A rejected or timed-out action is final: do not retry it, do not look for a workaround, ask the human instead.',
    'Never ask for keys, tokens or passwords in chat; the panel opens its own secret field.',
    'After an action, open the relevant page with open_page when the action did not do it.',
    'A "how do I / what is / why" question about the panel: search_help, then read_help_topic, and answer from that text (name the topic). Never answer panel questions from memory; if help has nothing, say so.',
    'A request to do something: find the action among your tools and call it; if no tool does it, say which page the human should open instead of describing API calls.',
    'Connecting a contour by link: save_contour_draft (the human types the key in the opened field), check contour_status, then enable_contour; its result lists applied and skipped consumers, report skipped ones.',
    'Reply briefly, in the language the human writes in.',
    `Human is now at: ${where}. where_am_i returns the same.`,
  ].join('\n');
}

/**
 * Разговор одним текстом в stdin. Последняя реплика — вопрос этого хода; прежние
 * помечены ролями, чтобы модель не приняла свой старый ответ за просьбу человека.
 */
export function panelAgentPrompt(messages: PanelAgentMessage[]): string {
  if (messages.length === 1) return messages[0]!.content;
  const history = messages
    .slice(0, -1)
    .map((message) => `${message.role === 'user' ? 'Human' : 'Assistant'}: ${message.content}`)
    .join('\n\n');
  const last = messages[messages.length - 1]!;
  return `Conversation so far:\n\n${history}\n\nHuman (current request): ${last.content}`;
}

export function panelAgentArgs(files: {
  mcpConfig: string;
  systemPrompt: string;
  /** Промпт контура — ВМЕСТО промпта CLI, как у чата через контур (`ChatRunner`). */
  contourPrompt?: string;
}): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    // Флаги снятия слоёв — не свой список: разойдись он с контуром, карточка
    // обещала бы «слои сняты», а агент жил бы по другим правилам.
    ...lightWindowLayers().args,
    ...(files.contourPrompt ? ['--system-prompt-file', files.contourPrompt] : []),
    '--mcp-config',
    files.mcpConfig,
    '--tools',
    '',
    '--allowedTools',
    `${PANEL_AGENT_TOOL_PREFIX}*`,
    // Флаг-значение последним среди вариадических: `--mcp-config`,
    // `--tools` и `--allowedTools` съели бы следующий голый аргумент.
    '--append-system-prompt-file',
    files.systemPrompt,
  ];
}

/**
 * Что из окружения панели нужно самому CLI, чтобы запуститься и остаться в
 * аккаунте: путь поиска, дом и каталоги профиля (там `.credentials.json` и
 * конфиг), временные каталоги, оболочка Windows, язык, прокси и сертификаты
 * сети, свой каталог конфигурации и путь к git-bash. Всё прочее окружение панели
 * — ключ API, переменные контура и интеграций, `PLATFORM_*` — агенту не нужно и
 * до его процесса не доходит. Проверено настоящим `claude -p` с этим списком
 * (`.agent/tmp/wave3/fix-server.md`, M6).
 */
export const PANEL_AGENT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'USER',
  'LOGNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'SHELL',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_GIT_BASH_PATH',
];

/**
 * Окружение процесса агента: разрешённое из окружения панели плюс добавка
 * маршрута (контур) и то, что нужно самому ходу. Имена на Windows сравниваются
 * без регистра — там `Path` и `PATH` одна переменная.
 */
export function panelAgentEnv(
  parent: NodeJS.ProcessEnv,
  extra: Record<string, string>,
): Record<string, string> {
  const allowed = new Set(PANEL_AGENT_ENV_ALLOWLIST.map((name) => name.toLowerCase()));
  const caseless = process.platform === 'win32';
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const pass = caseless
      ? allowed.has(name.toLowerCase())
      : PANEL_AGENT_ENV_ALLOWLIST.includes(name);
    if (pass) env[name] = value;
  }
  return { ...env, ...extra };
}

export interface PanelAgentRunOptions {
  command: string;
  /** Добавка маршрута (контур) к окружению процесса. */
  env: Record<string, string>;
  /** Адрес панели для переходника — единственное, что уходит в его окружение. */
  selfBaseUrl: string;
  conversationId: string;
  context: PanelAgentPageContext;
  messages: PanelAgentMessage[];
  /**
   * Системный промпт контура (`contourRunPrompt`) — у хода через контур с
   * включённым промптом; пусто — промпт CLI. Дописка агента едет в обоих случаях:
   * это не наш слой, а сам агент.
   */
  contourPrompt?: string;
  onEvent: (event: PanelAgentRunEvent) => void;
  spawnImpl?: typeof nodeSpawn;
  timeoutMs?: number;
  /**
   * Ждёт ли сейчас карточка этого разговора клика человека. Пока ждёт, потолок
   * хода не идёт: две карточки подряд по 10 минут длиннее потолка, и одобрение
   * под конец выполнялось бы, а агента убивали бы, не дав ответить.
   */
  waitingHuman?: () => boolean;
  /** Шаг счёта потолка; подмена — для проверок. */
  ceilingTickMs?: number;
  /** Процесс запущен (pid) и завершён — для журнала процессов агента. */
  onSpawn?: (pid: number) => void;
  onExit?: () => void;
  /** Подмена скрипта переходника — для проверок. */
  bridgeScript?: string;
}

export interface PanelAgentRunResult {
  ok: boolean;
  reply: string;
  error?: string;
}

export interface PanelAgentRunHandle {
  done: Promise<PanelAgentRunResult>;
  /** Остановить ход (окно закрыли): процесс снимается деревом. */
  stop: () => void;
}

export function startPanelAgentRun(options: PanelAgentRunOptions): PanelAgentRunHandle {
  const dir = mkdtempSync(join(tmpdir(), 'cc-panel-agent-'));
  const mcpConfig = join(dir, 'mcp.json');
  const systemPrompt = join(dir, 'system-prompt.txt');
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        [PANEL_AGENT_BRIDGE_ID]: {
          command: process.execPath,
          // Разговор — аргументом, а не переменной: окружение переходника держит
          // ровно адрес панели, и это проверяется. Шаблон id не пускает в argv
          // ничего, кроме букв, цифр, `_` и `-`.
          args: [
            options.bridgeScript ?? panelBridgeScript(),
            '--conversation',
            options.conversationId,
          ],
          env: { AGENTDECK_URL: options.selfBaseUrl },
        },
      },
    }),
    'utf8',
  );
  writeFileSync(systemPrompt, panelAgentSystemPrompt(options.context), 'utf8');
  // Файлом, как у чата: текст многострочный, argv на Windows его разваливает.
  const contourText = options.contourPrompt?.trim();
  const contourPrompt = contourText ? join(dir, 'contour-system-prompt.txt') : undefined;
  if (contourPrompt && contourText) writeFileSync(contourPrompt, contourText, 'utf8');

  const cleanup = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Временная папка без секретов; не удалилась — не повод ронять ход.
    }
  };

  const spawned = spawnCliProcess(
    options.command,
    panelAgentArgs({ mcpConfig, systemPrompt, contourPrompt }),
    {
      spawnImpl: options.spawnImpl,
      cwd: dir,
      // Окружение — список, а не окружение панели целиком: ключ API и переменные
      // контура/интеграций в процессе агента не нужны и не должны быть видны.
      inheritEnv: false,
      env: panelAgentEnv(process.env, {
        ...options.env,
        AGENTDECK_URL: options.selfBaseUrl,
        // Ожидание карточки дольше стандартного ожидания инструмента у CLI.
        MCP_TOOL_TIMEOUT: String(PANEL_AGENT_MCP_TOOL_TIMEOUT_MS),
      }),
    },
  );

  if (spawned.error) {
    cleanup();
    const message = spawned.error.message;
    options.onEvent({ kind: 'error', message });
    return { done: Promise.resolve({ ok: false, reply: '', error: message }), stop: () => {} };
  }

  const child = spawned.child;
  if (child.pid !== undefined) options.onSpawn?.(child.pid);
  let stopped = false;
  const done = new Promise<PanelAgentRunResult>((resolve) => {
    let pending = Buffer.alloc(0);
    const errChunks: Buffer[] = [];
    const texts: string[] = [];
    let result: { text: string; isError: boolean } | undefined;
    const toolNames = new Map<string, string>();
    let settled = false;

    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      let event: StreamEvent;
      try {
        event = JSON.parse(line) as StreamEvent;
      } catch {
        return;
      }
      if (event.type === 'assistant') {
        for (const block of event.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            texts.push(block.text);
            options.onEvent({ kind: 'text', text: block.text });
          } else if (block.type === 'tool_use' && block.name) {
            const name = actionName(block.name);
            if (block.id) toolNames.set(block.id, name);
            options.onEvent({ kind: 'tool', name });
          }
        }
      } else if (event.type === 'user') {
        for (const block of event.message?.content ?? []) {
          if (block.type !== 'tool_result') continue;
          const name = (block.tool_use_id && toolNames.get(block.tool_use_id)) || 'unknown';
          options.onEvent({ kind: 'tool-result', name, isError: block.is_error === true });
        }
      } else if (event.type === 'result') {
        result = {
          text: typeof event.result === 'string' ? event.result : '',
          isError: event.is_error === true,
        };
      }
    };

    // Строки режем по байту `\n`, а декодируем целой строкой: граница чтения рвёт
    // многобайтовую UTF-8 последовательность, и русский ответ превращался бы в мусор.
    child.stdout.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      let at = pending.indexOf(0x0a);
      while (at >= 0) {
        handleLine(pending.subarray(0, at).toString('utf8'));
        pending = pending.subarray(at + 1);
        at = pending.indexOf(0x0a);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    // Потолок считает только время БЕЗ ждущей карточки: ожидание человека — не
    // работа агента, и снимать ход, пока человек читает дифф, значит потерять
    // ответ на уже одобренное действие.
    const ceiling = options.timeoutMs ?? PANEL_AGENT_RUN_TIMEOUT_MS;
    const tick = options.ceilingTickMs ?? 1000;
    let active = 0;
    const timer = setInterval(() => {
      if (options.waitingHuman?.()) return;
      active += tick;
      if (active < ceiling) return;
      finish({ ok: false, reply: '', error: 'Агент не закончил ход за отведённое время.' });
      killChildTree(child);
    }, tick);
    timer.unref?.();

    const finish = (outcome: PanelAgentRunResult): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      cleanup();
      if (outcome.ok) options.onEvent({ kind: 'done', reply: outcome.reply });
      else options.onEvent({ kind: 'error', message: outcome.error ?? 'Агент не ответил.' });
      resolve(outcome);
    };

    child.on('error', (error) => {
      options.onExit?.();
      finish({ ok: false, reply: '', error: error.message });
    });
    child.on('close', (code) => {
      // Запись журнала снимается по смерти процесса, а не по концу хода: ход по
      // потолку кончается раньше, чем дерево процессов действительно убито.
      options.onExit?.();
      if (pending.length) handleLine(pending.toString('utf8'));
      if (stopped) return finish({ ok: false, reply: '', error: 'Ход остановлен.' });
      const reply = (result?.text || texts.join('\n\n')).trim();
      if (result && !result.isError && reply) return finish({ ok: true, reply });
      const stderr = Buffer.concat(errChunks).toString('utf8').trim().slice(0, 500);
      finish({
        ok: false,
        reply: '',
        error:
          (result?.isError ? result.text : '') ||
          stderr ||
          `CLI завершился с кодом ${code ?? '?'} без ответа.`,
      });
    });

    // Ошибка записи в stdin — CLI закрылся раньше; необработанная роняла бы сервер.
    child.stdin.on('error', () => {});
    child.stdin.end(panelAgentPrompt(options.messages));
  });

  return {
    done,
    stop: () => {
      if (stopped) return;
      stopped = true;
      killChildTree(child);
    },
  };
}

/** `mcp__agentdeck-panel__list_sections` → `list_sections`; чужое имя — как есть. */
function actionName(tool: string): string {
  return tool.startsWith(PANEL_AGENT_TOOL_PREFIX)
    ? tool.slice(PANEL_AGENT_TOOL_PREFIX.length)
    : tool;
}

interface StreamBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

interface StreamEvent {
  type?: string;
  message?: { content?: StreamBlock[] };
  result?: unknown;
  is_error?: boolean;
}
