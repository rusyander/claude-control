import type {
  ChatProgress,
  ProgressTask,
  ProgressAgent,
  ProgressShell,
  ProgressActiveTool,
} from '@agentdeck/contracts';
import {
  findTranscript,
  readTranscriptRecords,
  type TranscriptRecord,
  type TranscriptBlock,
} from './ChatHistory.ts';
import { isHumanPrompt } from './chat-inbox.ts';

/**
 * Прогресс агента по его собственному следу в транскрипте.
 *
 * Ничего своего панель здесь не заводит: чекпоинты — это последний вызов
 * `TodoWrite` (агент сам ведёт этот список и переписывает его целиком), дерево —
 * вызовы `Task`, то есть запущенные им субагенты, вместе с их результатом.
 * Отсюда и read-only: план принадлежит агенту, панель его только показывает.
 *
 * Почему из транскрипта, а не из живого потока: транскрипт переживает и
 * перезагрузку страницы, и конец прогона — открыв вчерашний разговор, видно, чем
 * он кончился. Живой поток дал бы то же самое только в одной вкладке и только
 * пока она открыта.
 */

/** Сколько символов ответа субагента показывать: это заглядывание, не чтение. */
const RESULT_LIMIT = 600;

export function readChatProgress(projectsDir: string, chatId: string): ChatProgress {
  const path = findTranscript(projectsDir, chatId);
  if (!path) return { tasks: [], agents: [] };

  return buildProgress(readTranscriptRecords(path));
}

export function buildProgress(records: TranscriptRecord[]): ChatProgress {
  let tasks: ProgressTask[] = [];
  const agents = new Map<string, ProgressAgent>();
  const shells = new Shells();
  let updatedAt: string | undefined;
  let skill: ChatProgress['skill'];

  for (const record of records) {
    const content = record.message?.content;
    if (record.timestamp) updatedAt = record.timestamp;
    // Новое слово человека — новая задача: навык прошлой ей не шаг. Иначе хаб
    // часами звал бы шагом навык, вызванный утром (холодная проверка 29.09, N4).
    // Тело навыка CLI пишет служебной репликой (isMeta) — она не сброс.
    // Сводка сжатия и реплики субагента — тоже не слово человека (ревью r2, R3).
    const service = record.isMeta || record.isCompactSummary || record.isSidechain;
    if (record.type === 'user' && !service && isHumanPrompt(content)) skill = undefined;
    // Итог фоновой команды или субагента приходит отдельной репликой-уведомлением, строкой.
    if (typeof content === 'string') {
      shells.notice(content);
      applyAgentNotices(content, agents);
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === 'tool_use') {
        applyToolUse(block, agents, (next) => (tasks = next));
        shells.use(block, record.timestamp);
        skill = skillOf(block, record.timestamp) ?? skill;
      }
      if (block.type === 'tool_result') {
        applyToolResult(block, agents);
        shells.result(block, resultText(block));
      }
      if (block.type === 'text' && record.type === 'user' && typeof block.text === 'string') {
        shells.notice(block.text);
        applyAgentNotices(block.text, agents);
      }
    }
  }

  const listed = shells.list();
  return {
    tasks,
    agents: [...agents.values()],
    ...(listed.length > 0 ? { shells: listed } : {}),
    ...(shells.active ? { activeTool: shells.active } : {}),
    ...(skill ? { skill } : {}),
    updatedAt,
  };
}

/**
 * Навык, которым агент ведёт работу, — шаг его пути без плана (ревью 29.09:
 * агенты групп TodoWrite не зовут вовсе, и шаг по плану не появлялся никогда,
 * а вызов навыка — `deep-review`, `live-check` — есть в каждом шаге).
 */
function skillOf(block: TranscriptBlock, at: string | undefined): ChatProgress['skill'] {
  if (block.name !== 'Skill') return undefined;
  const name = (block.input as { skill?: unknown } | undefined)?.skill;
  if (typeof name !== 'string' || !name.trim()) return undefined;
  return { name: name.trim(), ...(at ? { startedAt: at } : {}) };
}

/** Сколько фоновых команд держать в панели: хвост, а не история разговора. */
const SHELL_LIMIT = 8;

/** Что агент увёл в фон и чем это кончилось, плюс вызов, который идёт сейчас. */
class Shells {
  private readonly byUse = new Map<string, ProgressShell>();
  /** id фоновой задачи CLI → id вызова, который её завёл. */
  private readonly byTask = new Map<string, string>();
  private readonly pending = new Map<string, ProgressActiveTool>();
  private readonly commands = new Map<string, string>();
  /** Вызовы, гасящие процессы по порту, — до их ответа. */
  private readonly kills = new Map<string, KilledPorts>();
  /** Вызовы, которые только ищут процесс по порту, — до их ответа (PID в нём). */
  private readonly lookups = new Map<string, { ports: Set<string>; bare: boolean }>();
  /** PID → порт, напечатанные поиском: гасят их часто следующим вызовом. */
  private readonly pidPorts = new Map<string, string>();
  /** Полный текст фоновых команд: порт бывает не в первой строке. */
  private readonly fullCommands = new Map<string, string>();
  /**
   * Фон, который, возможно, погашен вызовом без доказательства (`kill … || true`
   * с пустым ответом): погашенным он станет, только если после этого упадёт.
   */
  private readonly suspects = new Set<string>();

  use(block: TranscriptBlock, at: string | undefined): void {
    if (!block.id || !block.name) return;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const summary = toolSummary(input);
    this.pending.set(block.id, { name: block.name, summary, ...(at ? { startedAt: at } : {}) });
    if (STOP_TOOLS.has(block.name)) {
      this.stopTask(input);
      return;
    }
    if (block.name !== 'Bash') return;
    // В строке фона нужна сама команда: описание «Install deps» не скажет,
    // что именно висит двадцать минут.
    const command = typeof input.command === 'string' ? firstLine(input.command) : summary;
    this.commands.set(block.id, command);
    if (typeof input.command === 'string') {
      // Порт через переменную (`P=9123 && kill $(lsof -ti:$P)`) — тот же порт.
      const full = expandVars(input.command);
      this.fullCommands.set(block.id, full);
      const kill = killedPorts(full, this.pidPorts);
      const found = lookupPorts(full);
      if (kill.ports.size > 0) this.kills.set(block.id, kill);
      else if (found.size > 0) {
        this.lookups.set(block.id, { ports: found, bare: onlyLookups(full) });
      }
    }
    if (input.run_in_background === true) {
      this.byUse.set(block.id, {
        id: block.id,
        command,
        ...(at ? { startedAt: at } : {}),
        status: 'running',
      });
    }
  }

  result(block: TranscriptBlock, text: string): void {
    const id = block.tool_use_id;
    if (!id) return;
    const started = this.pending.get(id);
    this.pending.delete(id);
    // Погашение засчитывается по ответу, а не по вызову: упавший kill сервер
    // не остановил. А вызов, чей отказ заглушён (`kill … || true`), успехом
    // ничего не доказывает — нужен найденный процесс (ревью разделения 29.09):
    // PID от прошлого поиска или след процесса в ответе.
    const kill = this.kills.get(id);
    if (kill) {
      this.kills.delete(id);
      if (!block.is_error) {
        const proven = !kill.masked || kill.found || FOUND_PROCESS.test(text);
        for (const shell of this.onPorts(kill.ports, id)) {
          if (proven) this.stop(shell);
          else this.suspects.add(shell);
        }
      }
    }
    const found = this.lookups.get(id);
    if (found) {
      this.lookups.delete(id);
      for (const [pid, port] of pidsOf(text, found.ports, found.bare)) {
        this.pidPorts.set(pid, port);
      }
    }
    // Вызов, уведённый в фон, ответил распиской с id задачи: сам он кончился, а
    // команда живёт дальше — и по таймауту тоже, хотя агент фон не просил.
    const task = /(?:background with ID|background \(ID):\s*([\w-]+)/i.exec(text)?.[1];
    if (!task) return;
    this.byTask.set(task, id);
    if (!this.byUse.has(id)) {
      this.byUse.set(id, {
        id,
        command: this.commands.get(id) ?? '',
        ...(started?.startedAt ? { startedAt: started.startedAt } : {}),
        status: 'running',
      });
    }
  }

  /** `<task-notification>` — итог фоновой задачи, пришедший репликой. */
  notice(text: string): void {
    if (!text.includes('<task-notification>')) return;
    const task = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1]?.trim();
    const status = /<status>([^<]+)<\/status>/.exec(text)?.[1]?.trim();
    const id = task ? this.byTask.get(task) : undefined;
    const shell = id ? this.byUse.get(id) : undefined;
    if (!id || !shell) return;
    // Итог задачи, которую агент уже погасил сам, — след его же уборки (ревью
    // 29.09: он возвращал «оборвана»).
    if (shell.status === 'killed') return;
    // Упал сразу после погашения без доказательства — значит, погашение нашло его.
    const next = shellStatus(status);
    this.byUse.set(id, {
      ...shell,
      status: next === 'failed' && this.suspects.has(id) ? 'killed' : next,
    });
  }

  /**
   * Агент сам остановил фоновую задачу инструментом (TaskStop/KillShell) —
   * это его решение, а не обрыв (живой прогон 29.09: уборка агента за собой
   * читалась человеком как «фон оборван»).
   */
  private stopTask(input: Record<string, unknown>): void {
    const task = [input.task_id, input.shell_id].find((v) => typeof v === 'string') as
      string | undefined;
    const id = task ? this.byTask.get(task) : undefined;
    const shell = id ? this.byUse.get(id) : undefined;
    if (id && shell?.status === 'running') this.byUse.set(id, { ...shell, status: 'killed' });
  }

  /**
   * Агент погасил фоновый сервер командой по его порту (`taskkill` по PID из
   * `netstat … :9123`, `kill $(lsof -ti:9123)`): CLI об этом не узнаёт, и без
   * этой сверки dev-сервер, убранный агентом, числился идущим или оборванным.
   * Только порт: по нему агент и находит процесс, а имя команды у всех
   * dev-серверов одинаковое. Сам гасящий вызов не в счёт: фоновое «освободи
   * порт и подними сервер» (`kill-port 9123 && npm run dev -- --port 9123`)
   * гасит прежний сервер, а не себя (ревью r2, R1).
   */
  private onPorts(ports: ReadonlySet<string>, killer: string): string[] {
    const ids: string[] = [];
    for (const [id, shell] of this.byUse) {
      if (id === killer || shell.status !== 'running') continue;
      const command = this.fullCommands.get(id) ?? shell.command;
      if ([...portsOf(command)].some((port) => ports.has(port))) ids.push(id);
    }
    return ids;
  }

  private stop(id: string): void {
    const shell = this.byUse.get(id);
    if (shell) this.byUse.set(id, { ...shell, status: 'killed' });
  }

  list(): ProgressShell[] {
    return [...this.byUse.values()].slice(-SHELL_LIMIT);
  }

  /** Последний вызов без результата. Параллельных бывает несколько — важен свежий. */
  get active(): ProgressActiveTool | undefined {
    return [...this.pending.values()].at(-1);
  }
}

/** Инструменты, которыми агент сам останавливает фоновую задачу. */
const STOP_TOOLS = new Set(['TaskStop', 'KillShell', 'KillBash']);

/**
 * Команда, которая гасит процесс, — словом команды, а не словом в тексте: в
 * начале строки, после `;`/`&`/`|`/`(`/`{`, внутри `$(`, после `do`/`xargs`
 * (и его ключей: `xargs -r kill`, `xargs -0 kill`).
 * Кавычки перед проверкой вырезаются: `echo "kill"` и `grep "kill"` — не kill.
 */
const KILL_COMMAND =
  /(?:^|[;&|(`\n{]|\$\(|\bdo\b|\bxargs(?:\s+-\S+)*)\s*(?:sudo\s+)?(?:taskkill|kill|pkill|killall|Stop-Process|fuser|(?:npx\s+)?kill-port)\b/i;

/** Чем агент находит процесс по порту: без поиска порт в команде — просто адрес. */
const PORT_LOOKUP = /\b(?:netstat|lsof|fuser|Get-NetTCPConnection|kill-port|ss)\b|-LocalPort\b/i;

/**
 * Гасит ли команда процесс. Кавычки вырезаются (`echo "kill"` — не kill), но
 * тело `powershell -Command "…"` и `bash -c "…"` — сама команда, и в Windows
 * это обычный вид погашения (холодная проверка 29.09, N5).
 */
function kills(command: string): boolean {
  // Кавычки заменяются номерами: снаружи их текст не команда, а тело оболочки
  // потом достаётся по номеру.
  const quoted: string[] = [];
  const outer = command.replace(/"([^"]*)"|'([^']*)'/g, (_m, dq?: string, sq?: string) => {
    quoted.push(dq ?? sq ?? '');
    return `"${quoted.length - 1}"`;
  });
  if (KILL_COMMAND.test(outer)) return true;
  // Только тело оболочки, стоящей словом команды: `grep -c "kill"` — счёт
  // строк, `./check.sh` — файл, `echo "bash -c '…'"` — текст (ревью r2, R2).
  const bodies =
    /(?:^|[;&|(\n])\s*(?:sudo\s+)?(?:pwsh|powershell|bash|sh|zsh|cmd)(?:\.exe)?(?=\s)[^"\n;&|]*?\s(?:-Command|-c|\/c)\s+"(\d+)"/gi;
  for (const match of outer.matchAll(bodies)) {
    if (kills(quoted[Number(match[1])] ?? '')) return true;
  }
  return false;
}

/** Команда — только поиск по порту: каждая её часть что-то ищет. */
function onlyLookups(command: string): boolean {
  return command
    .split(/;|&&|\|\||\n/)
    .filter((clause) => clause.trim())
    .every((clause) => PORT_LOOKUP.test(clause));
}

/**
 * Порты из тех частей команды, что ищут процесс, — не из всей строки:
 * `lsof -ti:3000 | xargs kill; curl localhost:9123` гасит 3000, а 9123 лишь
 * спрашивает. Части делятся по `;`, `&&`, `||` и строкам; труба остаётся одной
 * частью — поиск и kill в ней связаны.
 */
function lookupPorts(command: string): Set<string> {
  const ports = new Set<string>();
  for (const clause of command.split(/;|&&|\|\||\n/)) {
    if (PORT_LOOKUP.test(clause)) for (const port of portsOf(clause)) ports.add(port);
  }
  return ports;
}

/** Что гасит вызов и чем доказано, что на порту был процесс. */
interface KilledPorts {
  ports: Set<string>;
  /** Процесс найден прошлым поиском: kill идёт по напечатанному им PID. */
  found: boolean;
  /** Отказ погашения не доходит до кода выхода — успех ничего не доказывает. */
  masked: boolean;
}

/**
 * Отказ погашения заглушён: `kill … || true`, цикл по найденным PID (ноль
 * оборотов — тоже успех), `xargs -r`, `-ErrorAction SilentlyContinue`, хвост
 * `; true` / `& exit 0`. Когда на порту никого нет, такой вызов всё равно
 * отвечает успехом (ревью разделения 29.09).
 */
const MASKED_FAILURE =
  /\|\||\bfor\b[^;\n]*\bin\b|\bwhile\s+read\b|\bxargs\s+(?:-\w*r\w*|--no-run-if-empty)\b|-(?:ErrorAction|ea)\s+(?:SilentlyContinue|Ignore|0)\b|[;&]\s*(?:true|:|exit\s+(?:\/b\s+)?0)\s*$/i;

/**
 * След найденного процесса в ответе: PID строкой, `SUCCESS` и «has been
 * terminated» у taskkill, `9123/tcp: 4567` у fuser, «Process on port 9123
 * killed» у kill-port.
 */
const FOUND_PROCESS =
  /^\s*\d{2,7}\s*$|\bSUCCESS\b|has been terminated|\/tcp:\s*\d{2,7}|on port \d{2,5} killed/im;

/**
 * Порты, которые команда гасит; пусто — никого по порту не гасит. Поиск и kill в
 * одной команде — порты поиска; kill без поиска — по PID, которые напечатал
 * поиск прошлым вызовом (`netstat`, затем `taskkill /PID 4567`).
 */
function killedPorts(command: string, pidPorts: ReadonlyMap<string, string>): KilledPorts {
  const masked = MASKED_FAILURE.test(command);
  if (!kills(command)) return { ports: new Set(), found: false, masked };
  if (PORT_LOOKUP.test(command)) return { ports: lookupPorts(command), found: false, masked };
  const ports = new Set<string>();
  for (const match of command.matchAll(/\b(\d{2,7})\b/g)) {
    const port = pidPorts.get(match[1] ?? '');
    if (port) ports.add(port);
  }
  return { ports, found: ports.size > 0, masked };
}

/**
 * Подставляет переменные, заданные в самой команде: `P=9123 && kill $(lsof
 * -ti:$P)`, `export PORT=9123; …`, `set P=9123 & … %P%`, PowerShell `$p = 9123;
 * …`. Порт через переменную — обычный вид у агента (ревью разделения 29.09), а
 * без подстановки ни поиск, ни погашение его порта не видели. Незаданные
 * переменные (`$p` цикла, `$5` awk) остаются как есть.
 */
function expandVars(command: string): string {
  const shell = new Map<string, string>();
  // Имена PowerShell регистр не различают, оболочки — различают: `$p` цикла
  // не станет портом из `P=9123`.
  const powershell = new Map<string, string>();
  const unquote = (raw: string): string => raw.replace(/^(["'])(.*)\1$/, '$2');
  const shellAssign =
    /(?:^|[;&|\n(]|\b(?:export|set|local|declare|readonly)\s)\s*([A-Za-z_]\w*)=("[^"\n]*"|'[^'\n]*'|[^\s;&|)]*)/g;
  for (const [, name = '', raw = ''] of command.matchAll(shellAssign))
    shell.set(name, unquote(raw));
  const psAssign = /\$([A-Za-z_]\w*)\s*=\s*("[^"\n]*"|'[^'\n]*'|\d+)/g;
  for (const [, name = '', raw = ''] of command.matchAll(psAssign)) {
    powershell.set(name.toLowerCase(), unquote(raw));
  }
  if (shell.size === 0 && powershell.size === 0) return command;
  return command.replace(
    /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)|%([A-Za-z_]\w*)%/g,
    (whole: string, braced?: string, bare?: string, cmd?: string) => {
      const name = braced ?? bare ?? cmd ?? '';
      return shell.get(name) ?? powershell.get(name.toLowerCase()) ?? whole;
    },
  );
}

/**
 * PID из ответа поиска: строка `netstat -ano` (`TCP 0.0.0.0:9123 … LISTENING
 * 4567`) — порт из самой строки; голый PID (`lsof -ti:9123`) — порт поиска, если
 * он один и вызов ничего, кроме поиска, не печатал: `curl -w "%{http_code}"`
 * рядом дал бы «PID 200» (ревью r2, R2).
 */
function pidsOf(text: string, ports: ReadonlySet<string>, bare: boolean): [string, string][] {
  const pairs: [string, string][] = [];
  const only = bare && ports.size === 1 ? [...ports][0] : undefined;
  for (const line of text.split(/\r?\n/)) {
    const row = /:(\d{2,5})\b.*?\s(\d{2,7})\s*$/.exec(line);
    if (row?.[1] && row[2] && ports.has(row[1])) pairs.push([row[2], row[1]]);
    else if (only && /^\s*\d{2,7}\s*$/.test(line)) pairs.push([line.trim(), only]);
  }
  return pairs;
}

/**
 * Порты в команде: `--port 9123`, `--port=9123`, `:9123`, `PORT=9123`,
 * `-ti:9123`, `9123/tcp` (fuser), `-LocalPort 9123`, `kill-port 9123`.
 */
function portsOf(text: string): Set<string> {
  const ports = new Set<string>();
  // Адрес — обращение к серверу, а не сам сервер: `wait-on
  // http://localhost:9123` вместе с ним не гаснет (N5).
  const command = text.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, '');
  const forms =
    /(?:--port[=\s]|PORT=|:|-LocalPort\s+|kill-port\s+)(\d{2,5})\b|\b(\d{2,5})\/tcp\b/gi;
  for (const match of command.matchAll(forms)) {
    const port = match[1] ?? match[2];
    if (port) ports.add(port);
  }
  return ports;
}

function shellStatus(status: string | undefined): ProgressShell['status'] {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  // CLI гасит задачу так по TaskStop/KillShell — это решение, а не обрыв.
  if (status === 'killed') return 'killed';
  return 'stopped';
}

/** Чем вызван инструмент — одной строкой: команда, путь, шаблон или описание. */
function toolSummary(input: Record<string, unknown>): string {
  for (const key of ['description', 'command', 'file_path', 'pattern', 'path', 'url', 'prompt']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return firstLine(value);
  }
  return '';
}

function applyToolUse(
  block: TranscriptBlock,
  agents: Map<string, ProgressAgent>,
  setTasks: (tasks: ProgressTask[]) => void,
): void {
  if (block.name === 'TodoWrite') {
    const todos = (block.input as { todos?: unknown })?.todos;
    if (Array.isArray(todos)) setTasks(todos.map(toTask).filter(isTask));
    return;
  }

  // Субагент. Имя инструмента в разных сборках CLI отличается (`Task`, `Agent`),
  // а признак один и тот же — тип субагента во входе; по нему и опознаём.
  const input = (block.input ?? {}) as {
    subagent_type?: unknown;
    description?: unknown;
    prompt?: unknown;
  };
  const isSubagent = block.name === 'Task' || block.name === 'Agent';
  if (!isSubagent || !block.id) return;

  agents.set(block.id, {
    id: block.id,
    kind: typeof input.subagent_type === 'string' ? input.subagent_type : 'agent',
    description: firstLine(
      typeof input.description === 'string'
        ? input.description
        : typeof input.prompt === 'string'
          ? input.prompt
          : '',
    ),
    status: 'running',
  });
}

/**
 * Результат вызова закрывает ветку дерева: субагент отработал или упал.
 *
 * Кроме одного случая: фоновый субагент отвечает сразу, но отвечает не работой,
 * а распиской «принято, работаю» со служебным идентификатором внутри. Пометить
 * такую ветку готовой значило бы соврать — она остаётся работающей, а расписка
 * в панель не попадает.
 */
function applyToolResult(block: TranscriptBlock, agents: Map<string, ProgressAgent>): void {
  const id = block.tool_use_id;
  if (!id) return;
  const agent = agents.get(id);
  if (!agent) return;

  const text = resultText(block);
  if (isLaunchAcknowledgement(text)) return;

  agents.set(id, {
    ...agent,
    status: block.is_error ? 'failed' : 'done',
    result: publicResult(text) || undefined,
  });
}

const TASK_NOTICE = /<task-notification>([\s\S]*?)<\/task-notification>/g;

/**
 * Итог фонового субагента. Вызов `Agent` отвечает распиской, а сам итог CLI
 * пишет позже репликой `<task-notification>`, где `<tool-use-id>` — id вызова
 * (claude 2.1.282, замер 28.09). Без этого субагент оставался «работающим»
 * навсегда. Уведомлений в реплике бывает несколько — закрываем каждое своё.
 */
function applyAgentNotices(text: string, agents: Map<string, ProgressAgent>): void {
  if (!text.includes('<task-notification>')) return;
  for (const [, body = ''] of text.matchAll(TASK_NOTICE)) {
    const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(body)?.[1]?.trim();
    const agent = id ? agents.get(id) : undefined;
    if (!id || !agent || agent.status !== 'running') continue;
    const status = /<status>([^<]+)<\/status>/.exec(body)?.[1]?.trim();
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1]?.trim();
    agents.set(id, {
      ...agent,
      status: status === 'completed' ? 'done' : 'failed',
      ...(agent.result || !summary ? {} : { result: summary }),
    });
  }
}

/** Расписка о запуске фонового субагента — не результат работы. */
function isLaunchAcknowledgement(text: string): boolean {
  return /^Async agent launched/i.test(text);
}

/**
 * Что из ответа субагента можно показать. Строки со служебными идентификаторами
 * выбрасываем: они предназначены агенту, а не человеку, и в панели читаются как
 * мусор.
 */
function publicResult(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/agentId:/i.test(line))
    .join('\n')
    .trim()
    .slice(0, RESULT_LIMIT);
}

/** Текст результата: CLI отдаёт его то строкой, то списком блоков. */
function resultText(block: TranscriptBlock): string {
  if (typeof block.content === 'string') return block.content.trim();
  if (Array.isArray(block.content)) {
    return block.content
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('\n')
      .trim();
  }
  return typeof block.text === 'string' ? block.text.trim() : '';
}

function toTask(raw: unknown): ProgressTask | undefined {
  const todo = (raw ?? {}) as { content?: unknown; status?: unknown };
  const text = typeof todo.content === 'string' ? todo.content.trim() : '';
  if (!text) return undefined;

  const status =
    todo.status === 'completed' || todo.status === 'in_progress' ? todo.status : 'pending';
  return { text, status };
}

function isTask(task: ProgressTask | undefined): task is ProgressTask {
  return task !== undefined;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim().slice(0, 200) ?? '';
}
