import type { DiscoveredLaunch } from '@agentdeck/contracts';

/**
 * Как запущен MCP-сервер — и откуда он берёт переменные.
 *
 * Запись в конфигурации бывает любой: `docker run … образ`, `npx -y пакет`,
 * `uvx пакет`, адрес сервера, а часто ещё и обёртка перед ними (у владельца —
 * `node with-secrets.mjs docker run …`, подставляющая ключи из
 * `.mcp-secrets.env`). Поэтому запускатель ищется по всей строке запуска, а не
 * только в `command`.
 */

export interface RawServer {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  url?: unknown;
  env?: unknown;
  headers?: unknown;
}

export interface Launched {
  launch: DiscoveredLaunch;
  /** Образ, пакет или хост адреса — по нему узнаётся система. */
  package: string;
  /** Всё, что описывает запуск, строчными — для узнавания по имени. */
  haystack: string;
  /** Адрес сетевого сервера. */
  url: string;
  /** Заголовки сетевого сервера, ссылки `${VAR}` раскрыты. */
  headers: Record<string, string>;
  /** Переменная, которую сервер ЯВНО получает: своим `env`, `-e`, флагом, списком секретов. */
  explicit: (name: string) => string | undefined;
}

/** Откуда приходят значения, не записанные в самом сервере. */
export type VarLookup = (name: string) => string | undefined;

const LAUNCHERS: Record<string, DiscoveredLaunch> = {
  docker: 'docker',
  podman: 'docker',
  npx: 'npx',
  bunx: 'npx',
  uvx: 'uvx',
};

/** Опции `docker run`, за которыми идёт значение: иначе значение сочли бы образом. */
const DOCKER_VALUED = new Set([
  '-e',
  '--env',
  '--env-file',
  '-v',
  '--volume',
  '--name',
  '--network',
  '-p',
  '--publish',
  '-w',
  '--workdir',
  '--entrypoint',
  '-u',
  '--user',
  '-l',
  '--label',
  '--mount',
  '--platform',
  '--add-host',
  '-h',
  '--hostname',
]);

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function record(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** Имя программы без пути и расширения Windows: `C:\…\npx.cmd` → `npx`. */
function programName(value: string): string {
  return (value.split(/[\\/]/).pop() ?? value).replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/** `${VAR}` и `${VAR:-запасное}` — как раскрывает их сам Claude Code. */
function expandRefs(text: string, lookup: VarLookup): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name, fallback) => {
    return lookup(name as string) ?? (fallback as string | undefined) ?? '';
  });
}

/** `--jira-url x` / `--jira-url=x` → `JIRA_URL`: так mcp-atlassian и другие берут флаги. */
function flagVars(args: readonly string[]): Map<string, string> {
  const vars = new Map<string, string>();
  for (let at = 0; at < args.length; at += 1) {
    const match = args[at]!.match(/^--([a-z][a-z0-9-]*)(?:=(.*))?$/i);
    if (!match) continue;
    const name = match[1]!.replace(/-/g, '_').toUpperCase();
    if (match[2] !== undefined) vars.set(name, match[2]);
    else if (at + 1 < args.length && !args[at + 1]!.startsWith('-')) vars.set(name, args[at + 1]!);
  }
  return vars;
}

interface Tail {
  launch: DiscoveredLaunch;
  package: string;
  /** Аргументы после образа или пакета — флаги самого сервера. */
  rest: string[];
  /** `-e NAME=значение` — значение прямо в строке запуска. */
  inline: Map<string, string>;
  /** `-e NAME` — переменная пробрасывается из окружения запускающего. */
  passed: Set<string>;
}

function dockerTail(args: readonly string[]): Tail {
  const inline = new Map<string, string>();
  const passed = new Set<string>();
  let at = args.indexOf('run');
  at = at < 0 ? 0 : at + 1;
  for (; at < args.length; at += 1) {
    const arg = args[at]!;
    const env =
      arg === '-e' || arg === '--env' ? args[(at += 1)] : arg.match(/^(?:-e|--env=)(.+)$/)?.[1];
    if (env !== undefined) {
      const eq = env.indexOf('=');
      if (eq > 0) inline.set(env.slice(0, eq), env.slice(eq + 1));
      else passed.add(env);
      continue;
    }
    if (DOCKER_VALUED.has(arg)) {
      at += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return { launch: 'docker', package: arg, rest: args.slice(at + 1), inline, passed };
  }
  return { launch: 'docker', package: '', rest: [], inline, passed };
}

function packageTail(launch: DiscoveredLaunch, args: readonly string[]): Tail {
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    // `uvx --from пакет команда`, `npx -p пакет команда`: пакет — значение опции.
    if (arg === '--from' || arg === '-p' || arg === '--package') {
      return {
        launch,
        package: args[at + 1] ?? '',
        rest: args.slice(at + 2),
        inline: new Map(),
        passed: new Set(),
      };
    }
    if (arg.startsWith('-')) continue;
    return { launch, package: arg, rest: args.slice(at + 1), inline: new Map(), passed: new Set() };
  }
  return { launch, package: '', rest: [], inline: new Map(), passed: new Set() };
}

/** Найти запускатель в строке запуска, пропустив обёртки перед ним. */
function tailOf(argv: readonly string[]): Tail {
  for (let at = 0; at < argv.length; at += 1) {
    const name = programName(argv[at]!);
    // `pnpm dlx пакет` и `yarn dlx пакет` — тот же npx.
    if ((name === 'pnpm' || name === 'yarn') && argv[at + 1] === 'dlx') {
      return packageTail('npx', argv.slice(at + 2));
    }
    const launch = LAUNCHERS[name];
    if (launch === 'docker') return dockerTail(argv.slice(at + 1));
    if (launch) return packageTail(launch, argv.slice(at + 1));
  }
  const script = argv.slice(1).find((arg) => !arg.startsWith('-')) ?? argv[0] ?? '';
  return {
    launch: 'command',
    package: programName(script),
    rest: argv.slice(1),
    inline: new Map(),
    passed: new Set(),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Разобрать запись сервера. `inherited` — переменные, которые сервер получает
 * от запускающего: `env` настроек Claude Code и файл секретов панели, затем
 * окружение процесса.
 */
export function readLaunch(raw: RawServer, inherited: VarLookup): Launched {
  const env = record(raw.env);
  // Список секретов обёртки (`MCP_SECRET_KEYS=A,B`): эти имена приходят из
  // файла секретов, и сервер получает их так же явно, как записанные в `env`.
  const secretNames = new Set(
    (env.MCP_SECRET_KEYS ?? '')
      .split(/[,\s]+/)
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const url = typeof raw.url === 'string' ? expandRefs(raw.url, inherited) : '';

  if (url) {
    const headers = Object.fromEntries(
      Object.entries(record(raw.headers)).map(([key, value]) => [
        key,
        expandRefs(value, inherited),
      ]),
    );
    return {
      launch: 'url',
      package: hostOf(url),
      haystack: url.toLowerCase(),
      url,
      headers,
      explicit: (name) => (env[name] !== undefined ? expandRefs(env[name], inherited) : undefined),
    };
  }

  const argv = [typeof raw.command === 'string' ? raw.command : '', ...strings(raw.args)].filter(
    Boolean,
  );
  const tail = tailOf(argv);
  const flags = flagVars(tail.rest);
  const explicit = (name: string): string | undefined => {
    const inline = tail.inline.get(name);
    if (inline !== undefined) return expandRefs(inline, inherited);
    if (env[name] !== undefined) return expandRefs(env[name], inherited);
    const flag = flags.get(name);
    if (flag !== undefined) return expandRefs(flag, inherited);
    if (secretNames.has(name) || tail.passed.has(name)) return inherited(name);
    return undefined;
  };
  return {
    launch: tail.launch,
    package: tail.package,
    haystack: argv.join(' ').toLowerCase(),
    url: '',
    headers: {},
    explicit,
  };
}
