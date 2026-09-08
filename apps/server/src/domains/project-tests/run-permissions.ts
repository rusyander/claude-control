import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ProjectTestCase, ProjectTestRunMode } from '@agentdeck/contracts';
import { TESTS_DIR } from './files.ts';

/**
 * Права прогона: что агенту РАЗРЕШЕНО трогать, пока он гоняет тесты.
 *
 * Раньше прогон шёл с `bypassPermissions` — то есть без единой проверки, а
 * границы держало только задание словами. Слова агент соблюдает почти всегда;
 * «почти» здесь означает чужой рабочий код, поправленный посреди ночного
 * регресса, и человека, который утром находит дифф вместо отчёта.
 *
 * Проверка живёт НЕ в CLI: параметром её туда не передать (`--settings` панель
 * не подставляет), зато у CLI есть штатный канал — брокер прав
 * (`--permission-prompt-tool`, см. `domains/chat/permission-prompt-server.mjs`).
 * Прогон поднимает СВОЙ крошечный приёмник этого брокера на локальной петле и
 * отвечает на каждый вызов инструмента сам, по правилам ниже. Человека при этом
 * не спрашивают ни о чём: прогон идёт без него, и вопрос означал бы зависший
 * агент.
 *
 * Правила по режимам:
 * - `generate` — запись только внутрь `.agent/tests/drafts/`: генерация пишет
 *   ЧЕРНОВИК, а файлы групп меняет панель, применяя его. Так галочка «принимать
 *   сразу» решает лишь, кто нажимает «применить», и никогда — кто пишет в
 *   библиотеку;
 * - `run`, `explore` — запись внутрь `.agent/tests/`;
 * - `automate` — плюс файлы автотестов, НАЗВАННЫЕ кейсами (`automation.file`),
 *   потому что именно их этот режим и пишет;
 * - чтение, поиск и запуск команд разрешены: без них тест не пройти. У команд
 *   свой запрет — то, что меняет репозиторий (коммит, пуш, переключение ветки).
 *
 * Что гейт НЕ ловит: запись через оболочку (`echo > файл`). Это осознанный
 * размен: запретить `Bash` целиком значит запретить поднять стенд и прогнать
 * автотесты, то есть отменить сам прогон. Инструменты записи закрыты жёстко,
 * а про границу сказано и в задании — модель держит то, о чём знает.
 */

/** Куда прогону можно писать. */
export interface RunScope {
  root: string;
  mode: ProjectTestRunMode;
  /**
   * Каталог от корня проекта, внутрь которого разрешена запись.
   *
   * У генерации он сужен до папки черновиков: библиотеку меняет панель, а не
   * прогон, и это должно держаться правом, а не обещанием в задании.
   */
  writeDir: string;
  /** Пути от корня проекта, которые режим `automate` дописывает к тестовым. */
  testFiles: string[];
}

/** Решение по одному вызову инструмента. */
export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedInput?: unknown;
}

/** Инструменты, которые ничего не меняют: разрешаем не глядя. */
const READ_ONLY = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Task',
  'BashOutput',
  'KillShell',
  'ExitPlanMode',
]);

/** Инструменты записи в файл: у них и проверяется путь. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Update']);

/**
 * Команды, меняющие репозиторий. Ровно то, что запрещено и словами в задании:
 * прогон описывает состояние приложения, а не двигает историю.
 */
const FORBIDDEN_COMMANDS =
  /\bgit\s+(commit|push|reset|checkout|switch|clean|rebase|merge|cherry-pick|tag|stash|worktree)\b/;

/** Файлы автотестов, названные самими кейсами: их и пишет режим `automate`. */
export function automationFiles(cases: ProjectTestCase[]): string[] {
  const files = cases
    .map((item) => item.automation?.file?.trim())
    .filter((file): file is string => Boolean(file));
  return [...new Set(files)];
}

/** Папка черновиков — единственное, куда пишет генерация. */
export const DRAFTS_WRITE_DIR = `${TESTS_DIR}/drafts`;

/** Границы прогона по режиму. */
export function runScope(
  root: string,
  mode: ProjectTestRunMode,
  cases: ProjectTestCase[] = [],
): RunScope {
  return {
    root,
    mode,
    writeDir: mode === 'generate' ? DRAFTS_WRITE_DIR : TESTS_DIR,
    testFiles: mode === 'automate' ? automationFiles(cases) : [],
  };
}

/** Лежит ли путь внутри каталога (сам каталог считается своим). */
function inside(root: string, target: string, folder: string): boolean {
  const base = resolve(root, folder);
  const step = relative(base, target);
  return step === '' || (!step.startsWith('..') && !isAbsolute(step));
}

/** Путь из входа инструмента: разные инструменты называют его по-разному. */
function pathOf(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const value =
    record.file_path ?? record.filePath ?? record.notebook_path ?? record.path ?? record.target;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Команда из входа `Bash`. */
function commandOf(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const value = (input as Record<string, unknown>).command;
  return typeof value === 'string' ? value : '';
}

/**
 * Разрешено ли писать в этот путь. Каталог тестов — всегда; в режиме
 * `automate` ещё и файлы автотестов, которые назвали сами кейсы (и папки, в
 * которых те лежат: тесту нужен сосед-фикстура).
 */
export function isWritable(scope: RunScope, target: string): boolean {
  const path = isAbsolute(target) ? resolve(target) : resolve(scope.root, target);
  if (inside(scope.root, path, scope.writeDir || TESTS_DIR)) return true;
  if (scope.mode !== 'automate') return false;
  return scope.testFiles.some((file) => {
    const named = resolve(scope.root, file);
    if (path === named) return true;
    // Папка названного теста: рядом с ним живут фикстуры и вспомогательные файлы.
    const folder = named.slice(0, named.lastIndexOf(sep) + 1);
    return folder.length > 1 && path.startsWith(folder);
  });
}

/** Границы словами — тот же текст уходит и в задание, и в отказ. */
export function describeScope(scope: RunScope): string {
  const base = `писать разрешено только внутрь ${scope.writeDir || TESTS_DIR}/`;
  if (scope.mode === 'generate') {
    return `${base} — библиотеку меняет панель, применяя черновик`;
  }
  if (scope.mode !== 'automate') return base;
  const named = scope.testFiles.length
    ? `, а также в файлы автотестов, названные кейсами (${scope.testFiles.slice(0, 5).join(', ')}${
        scope.testFiles.length > 5 ? ', …' : ''
      })`
    : ', а также в файлы автотестов рядом с уже существующими тестами проекта';
  return `${base}${named}`;
}

/** Решение по вызову инструмента. Разрешаем работать, запрещаем выходить за границы. */
export function decidePermission(
  scope: RunScope,
  toolName: string,
  input: unknown,
): PermissionDecision {
  // Вопрос человеку в прогоне задавать некому: агент повиснет на нём навсегда.
  // Тот же отказ, что и в чате, но причина здесь другая — тут человека нет.
  if (toolName === 'AskUserQuestion') {
    return {
      behavior: 'deny',
      message: 'В прогоне спрашивать некого: реши сам и запиши сомнение в note кейса.',
    };
  }

  if (READ_ONLY.has(toolName) || toolName.startsWith('mcp__')) {
    return { behavior: 'allow', updatedInput: input };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const target = pathOf(input);
    if (!target) return { behavior: 'allow', updatedInput: input };
    if (isWritable(scope, target)) return { behavior: 'allow', updatedInput: input };
    return {
      behavior: 'deny',
      message: `Правка ${target} прогону запрещена: ${describeScope(scope)}. Нашёл проблему в коде — это результат теста (status: "failed" и что не так в note), а не повод чинить.`,
    };
  }

  if (toolName === 'Bash') {
    const command = commandOf(input);
    if (FORBIDDEN_COMMANDS.test(command)) {
      return {
        behavior: 'deny',
        message: 'Команды, меняющие репозиторий, прогону запрещены: ничего не коммить и не пушить.',
      };
    }
    return { behavior: 'allow', updatedInput: input };
  }

  // Незнакомый инструмент разрешаем: прогон и раньше шёл с полным доступом, и
  // молчаливый отказ на каждый новый инструмент CLI выглядел бы как «агент не
  // умеет работать», а не как правило панели.
  return { behavior: 'allow', updatedInput: input };
}

/** Приёмник решений: то, чем прогон заменяет человека у кнопки «Разрешить». */
export interface RunPermissionGate {
  /** Адрес, который получает брокер прав (`PERM_BASE_URL`). */
  baseUrl: string;
  /** Ключ прогона: чужой запрос на этот порт не пройдёт. */
  runId: string;
  close(): void;
}

/** Что делать с отказом — прогон пишет его в свой лог, чтобы он не пропал. */
export type DenyReporter = (toolName: string, message: string) => void;

/** Тело запроса брокера прав. */
interface BrokerRequest {
  runId?: string;
  toolName?: string;
  input?: unknown;
}

/**
 * Поднять приёмник на локальной петле. Порт выбирает система, адрес уходит
 * только в дочерний процесс прогона, а ключом служит одноразовый `runId` —
 * запрос без него получает отказ.
 */
export function startPermissionGate(
  scope: RunScope,
  onDeny?: DenyReporter,
): Promise<RunPermissionGate> {
  const runId = randomUUID();
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: BrokerRequest;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as BrokerRequest;
      } catch {
        body = {};
      }
      const decision =
        body.runId === runId
          ? decidePermission(scope, String(body.toolName ?? ''), body.input)
          : { behavior: 'deny' as const, message: 'Запрос не от этого прогона.' };
      if (decision.behavior === 'deny')
        onDeny?.(String(body.toolName ?? ''), decision.message ?? '');
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(decision));
    });
  });

  // Приёмник не должен удерживать процесс: забытый гейт не имеет права мешать
  // панели завершиться.
  server.unref();

  return new Promise((done, fail) => {
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        fail(new Error('Приёмник прав не получил порт.'));
        return;
      }
      done({
        baseUrl: `http://127.0.0.1:${address.port}`,
        runId,
        close: () => server.close(),
      });
    });
  });
}
