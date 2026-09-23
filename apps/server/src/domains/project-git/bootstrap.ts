import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { WorktreeBootstrapState } from '@agentdeck/contracts';
import { killChildTree } from '../../lib/process-tree.ts';

/**
 * Бутстрап копии: команда, которая идёт в новой копии ДО того, как в ней
 * стартует агент, — обычно установка зависимостей. Чекаут и зеркало локального
 * слоя дают файлы проекта, но не `node_modules`: без этого шага первый ход
 * агента уходит на «поставлю зависимости», а при отказе он изворачивается без
 * проверок проекта.
 *
 * Команду задаёт человек на проекте; пусто — панель определяет по lock-файлу в
 * корне копии (pnpm / npm / yarn), а нет его там — в каталогах первого уровня;
 * без lock-файла не делает ничего. Потолок
 * десять минут; провал копию не отменяет и группу разделения не останавливает —
 * агент получает хвост лога в задании и решает сам.
 *
 * Лог и запись о состоянии лежат в `<appData>/worktree-logs/<slug>.{log,json}`:
 * так карточка копии показывает результат и после перезапуска панели, а запись
 * «идёт», пережившая перезапуск, честно читается как провал — процесса уже нет.
 *
 * Команда запускается через оболочку системы (так её и пишет человек:
 * `pnpm install && pnpm build`), с `CI=1` — установщики в этом режиме не задают
 * вопросов и не рисуют прогресс, а вопрос без ответа висел бы до таймаута.
 */

export const BOOTSTRAP_TIMEOUT_MS = 10 * 60 * 1000;
/** Хвост лога, который уезжает в карточку и в задание агента. */
export const LOG_TAIL_CHARS = 2000;

/** Команда по lock-файлу ровно в этом каталоге. */
function lockfileCommand(dir: string): string | undefined {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) {
    return 'pnpm install --frozen-lockfile --prefer-offline';
  }
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm ci';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn install --immutable';
  return undefined;
}

/** Каталоги первого уровня, где lock-файл не ищем: служебные и чужие зависимости. */
const SKIP_NESTED = new Set(['node_modules', 'vendor', 'dist', 'build']);

/**
 * Команда по lock-файлу: в корне — она одна; в корне нет — по каталогам
 * первого уровня (Д13). Репозиторий «бэкенд + фронт рядом» держит lock-файл
 * в `frontend/` или `web/`, и без этого шага копия группы оставалась без
 * зависимостей. Несколько таких каталогов — по команде на каждый, по алфавиту,
 * через `cd` туда и обратно: так строка одинаково идёт в `cmd.exe` и в `sh`.
 */
export function detectBootstrapCommand(dir: string): string | undefined {
  const root = lockfileCommand(dir);
  if (root) return root;
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('.') && !SKIP_NESTED.has(name))
      .sort();
  } catch {
    return undefined;
  }
  const steps = entries.flatMap((name) => {
    const command = lockfileCommand(join(dir, name));
    return command ? [`cd "${name}" && ${command} && cd ..`] : [];
  });
  return steps.length > 0 ? steps.join(' && ') : undefined;
}

/** Настроенная человеком команда сильнее автоопределения; пустая строка — «определи сама». */
export function bootstrapCommandFor(dir: string, configured?: string): string | undefined {
  const own = configured?.trim();
  return own || detectBootstrapCommand(dir);
}

/** Последние символы лога, начиная с целой строки. */
export function logTail(text: string, max = LOG_TAIL_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < max / 2 ? cut.slice(nl + 1) : cut;
}

function normalizeDir(dir: string): string {
  const text = resolve(dir).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

export interface BootstrapOptions {
  timeoutMs?: number;
  /** Часы — в тесте фиксируются. */
  now?: () => Date;
  /**
   * Что сделать в копии после команды (удачной или нет): откат lock-файлов,
   * которые установка переписала. Возвращает, что откатилось, — в лог и в
   * состояние. Не задано — ничего.
   */
  afterRun?: (dir: string) => Promise<string[]>;
}

export class WorktreeBootstraps {
  private readonly running = new Map<string, Promise<WorktreeBootstrapState>>();
  private readonly states = new Map<string, WorktreeBootstrapState>();
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly logDir: string;
  private readonly afterRun?: (dir: string) => Promise<string[]>;

  constructor(logDir: string, options: BootstrapOptions = {}) {
    this.logDir = logDir;
    this.timeoutMs = options.timeoutMs ?? BOOTSTRAP_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.afterRun = options.afterRun;
  }

  /** Имя файлов лога: имя каталога плюс хвост хеша пути — две копии `feature-x` разных проектов не сойдутся. */
  slugFor(dir: string): string {
    const key = normalizeDir(dir);
    const tag = createHash('sha1').update(key).digest('hex').slice(0, 8);
    const name =
      basename(key)
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .slice(0, 40) || 'copy';
    return `${name}-${tag}`;
  }

  logPath(dir: string): string {
    return join(this.logDir, `${this.slugFor(dir)}.log`);
  }

  private recordPath(dir: string): string {
    return join(this.logDir, `${this.slugFor(dir)}.json`);
  }

  isRunning(dir: string): boolean {
    return this.running.has(normalizeDir(dir));
  }

  /**
   * Состояние копии: из памяти, иначе с диска. Запись «идёт» без процесса в
   * памяти — панель перезапустилась посреди установки: процесса больше нет, и
   * сказать «идёт» значило бы ждать вечно.
   */
  status(dir: string): WorktreeBootstrapState | undefined {
    const key = normalizeDir(dir);
    const live = this.states.get(key);
    if (live) return live;
    const stored = this.readRecord(dir);
    if (!stored) return undefined;
    if (stored.status === 'running') {
      const failed: WorktreeBootstrapState = {
        ...stored,
        status: 'failed',
        finishedAt: stored.finishedAt ?? this.now().toISOString(),
        logTail: `${stored.logTail}\n[панель перезапущена — установка прервана]`.trim(),
      };
      this.states.set(key, failed);
      this.writeRecord(dir, failed);
      return failed;
    }
    this.states.set(key, stored);
    return stored;
  }

  /** Полный лог последнего запуска; пусто, если запусков не было. */
  log(dir: string): string {
    try {
      return readFileSync(this.logPath(dir), 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Запустить команду в копии. Повторный вызов, пока идёт первый, возвращает
   * ТОТ ЖЕ результат, а не второй процесс поверх первого: два `pnpm install` в
   * одном каталоге ломают друг друга.
   *
   * Никогда не отклоняется: отказ оболочки, таймаут, ненулевой код — всё это
   * состояние `failed` с причиной в логе, а не исключение у вызывающего.
   */
  run(dir: string, command: string): Promise<WorktreeBootstrapState> {
    const key = normalizeDir(dir);
    const active = this.running.get(key);
    if (active) return active;

    const startedAt = this.now().toISOString();
    const state: WorktreeBootstrapState = { command, status: 'running', startedAt, logTail: '' };
    this.states.set(key, state);
    this.writeRecord(dir, state);

    const promise = this.execute(dir, command, state).finally(() => {
      this.running.delete(key);
    });
    this.running.set(key, promise);
    return promise;
  }

  private async execute(
    dir: string,
    command: string,
    state: WorktreeBootstrapState,
  ): Promise<WorktreeBootstrapState> {
    mkdirSync(this.logDir, { recursive: true });
    const chunks: string[] = [];
    let size = 0;
    const remember = (text: string): void => {
      chunks.push(text);
      size += text.length;
      // Хвост держим в памяти ограниченно: лог целиком лежит в файле.
      while (size > LOG_TAIL_CHARS * 4 && chunks.length > 1) {
        size -= (chunks.shift() as string).length;
      }
    };

    const finish = (patch: Partial<WorktreeBootstrapState>): WorktreeBootstrapState => {
      const done: WorktreeBootstrapState = {
        ...state,
        ...patch,
        finishedAt: this.now().toISOString(),
        logTail: logTail(chunks.join('')),
      };
      this.states.set(normalizeDir(dir), done);
      this.writeRecord(dir, done);
      return done;
    };

    let file: ReturnType<typeof createWriteStream> | undefined;
    try {
      file = createWriteStream(this.logPath(dir), { flags: 'w' });
      const header = `$ ${command}\n[${state.startedAt}] cwd: ${dir}\n\n`;
      file.write(header);
      remember(header);
    } catch (error) {
      const text = `Лог не открылся: ${error instanceof Error ? error.message : String(error)}\n`;
      remember(text);
    }

    const isWindows = process.platform === 'win32';
    const child = isWindows
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
          cwd: dir,
          windowsHide: true,
          windowsVerbatimArguments: true,
          env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn('/bin/sh', ['-c', command], {
          cwd: dir,
          detached: true,
          env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      remember(text);
      file?.write(text);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const note = `\n[потолок ${Math.round(this.timeoutMs / 60_000)} мин — процесс остановлен]\n`;
      remember(note);
      file?.write(note);
      killChildTree(child, { group: !isWindows });
    }, this.timeoutMs);

    const result = await new Promise<WorktreeBootstrapState>((resolveState) => {
      child.on('error', (error) => {
        clearTimeout(timer);
        const text = `\nКоманда не запустилась: ${error.message}\n`;
        remember(text);
        file?.write(text);
        resolveState(finish({ status: 'failed' }));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const footer = `\n[${this.now().toISOString()}] ${
          timedOut ? 'таймаут' : `код ${code ?? signal ?? '?'}`
        }\n`;
        remember(footer);
        file?.write(footer);
        const ok = !timedOut && code === 0;
        // Чистота дерева — после любой команды: и провальная установка успевает
        // переписать lock-файл. Отказ отката не портит итог установки.
        const cleanup = this.afterRun ? this.afterRun(dir).catch(() => []) : Promise.resolve([]);
        void cleanup.then((reverted) => {
          if (reverted.length > 0) {
            const note = `[lock-файлы откачены: ${reverted.join(', ')}]\n`;
            remember(note);
            file?.write(note);
          }
          resolveState(
            finish({
              status: ok ? 'ok' : 'failed',
              ...(typeof code === 'number' ? { exitCode: code } : {}),
              ...(timedOut ? { timedOut: true } : {}),
              ...(reverted.length > 0 ? { reverted } : {}),
            }),
          );
        });
      });
    });
    file?.end();
    return result;
  }

  private readRecord(dir: string): WorktreeBootstrapState | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.recordPath(dir), 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return undefined;
      const record = raw as Partial<WorktreeBootstrapState>;
      if (typeof record.command !== 'string' || typeof record.startedAt !== 'string') {
        return undefined;
      }
      return {
        command: record.command,
        status: record.status === 'ok' || record.status === 'running' ? record.status : 'failed',
        startedAt: record.startedAt,
        logTail: typeof record.logTail === 'string' ? record.logTail : '',
        ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
        ...(typeof record.exitCode === 'number' ? { exitCode: record.exitCode } : {}),
        ...(record.timedOut ? { timedOut: true } : {}),
        // Откат lock-файлов — единственное, что панель СДЕЛАЛА с рабочим
        // деревом копии; потерять его при перезапуске значит промолчать о
        // своей же правке.
        ...(Array.isArray(record.reverted) && record.reverted.length > 0
          ? { reverted: record.reverted.filter((name) => typeof name === 'string') }
          : {}),
      };
    } catch {
      return undefined;
    }
  }

  private writeRecord(dir: string, state: WorktreeBootstrapState): void {
    try {
      mkdirSync(this.logDir, { recursive: true });
      writeFileSync(this.recordPath(dir), JSON.stringify(state, null, 2));
    } catch {
      // Без записи на диске состояние живёт до перезапуска — этого хватает карточке.
    }
  }
}
