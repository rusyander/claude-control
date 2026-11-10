import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID7 } from '../../core-ask/core-ask.ts';
import type { CoreCaller } from '../../core-ask/core-ask.ts';
import { createCoreChatPort } from './core-chat-port.ts';
import { CoreChatRun } from './core-run.ts';
import type { CoreChatBook, CoreChatEntry, CoreChatPort } from './core-run.types.ts';

/**
 * Запуск хода чата против НАСТОЯЩЕГО ядра одноразового стенда (свой дом ядра). Чат шлёт оценку с
 * `launchPolicy: 'confirm'`, затем `set-cli` и `launch`. Подозрение W3-D F2 — оценка копии отвечает в
 * `estimating` и `launch` следом получает `state-conflict`; на живом ядре оценка чата-копии отвечает
 * готовой задачей (`draft` → `running`), и запуск проходит. Тест держит это поведение для обеих
 * раскладок; ожидание выхода из оценки в `CoreChatRun` — страховка (unit — `core-run.launch.test.ts`).
 *
 * Порт — настоящий `createCoreChatPort` поверх прокладки панели `/api/core/*` (как у браузера:
 * число страницы, подпись, пересылка в `/v1`). Копию задаёт одна подмена поля в тесте: оценка уходит
 * без `placement` — состояние решает само ядро.
 */
const REPO = resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const STAND = pathToFileURL(join(REPO, 'tools/qa/throwaway-stand.mjs')).href;
// `claude` стенда — немой: предпроверка видит CLI, сеанс сразу выходит — ни модели, ни сети.
// Каждый запуск сеанса дописывает свою папку процесса в журнал: так тест видит, ГДЕ шёл CLI.
const CWD_LOG = join(mkdtempSync(join(tmpdir(), 'cc-core-chat-cwd-')), 'cwd.log');
const INERT_CLI = `if (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
process.getBuiltinModule('node:fs').appendFileSync(${JSON.stringify(CWD_LOG)}, process.cwd() + '\\n');
process.stderr.write('inert claude of the throwaway stand\\n');
process.exit(1);
`;
const cwdLog = (): string[] =>
  existsSync(CWD_LOG) ? readFileSync(CWD_LOG, 'utf8').split('\n').filter(Boolean) : [];

interface Stand {
  apiUrl: string;
  coreHome: string;
  stop(): Promise<void>;
}

interface Line {
  kind: string;
  data: Record<string, unknown>;
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) return [];
    return st.isDirectory() ? filesUnder(path) : [path];
  });
}

/** Вызовы ядра через прокладку панели: `/v1<путь>` → `/api/core<путь>`. */
function standCaller(apiUrl: string): CoreCaller {
  const call: CoreCaller['call'] = (forward) =>
    fetch(`${apiUrl}/api/core${forward.path.replace(/^\/v1/, '')}`, {
      method: forward.method,
      headers: forward.body !== undefined ? { 'content-type': 'application/json' } : {},
      ...(forward.body !== undefined ? { body: JSON.stringify(forward.body) } : {}),
      ...(forward.signal ? { signal: forward.signal } : {}),
    });
  return {
    call,
    async proof() {
      const page = randomUUID7();
      const res = await call({ method: 'GET', path: `/v1/nonce?page=${page}` });
      if (!res.ok) throw new Error(`nonce: HTTP ${res.status}`);
      return { nonce: ((await res.json()) as { nonce: string }).nonce, page };
    },
    cmdId: randomUUID7,
  };
}

function memoryBook(): CoreChatBook {
  const entries = new Map<string, CoreChatEntry>();
  return {
    get: (id) => entries.get(id),
    cliOf: (id) => entries.get(id)?.cli,
    set: (id, entry) => void entries.set(id, entry),
    forget: (id) => void entries.delete(id),
  };
}

describe('core chat launch against a live core: launch waits until the estimate leaves estimating', () => {
  let stand: Stand;
  let project = '';

  beforeAll(async () => {
    const { startStand } = (await import(STAND)) as {
      startStand(options: object): Promise<Stand>;
    };
    stand = await startStand({
      label: 'core-chat-launch',
      web: false,
      core: true,
      fakeCli: { claude: INERT_CLI },
    });
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-core-chat-launch-')));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: project, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(project, 'README.md'), 'chat\n');
    // Подпапка проекта — в истории: копия берёт дерево из git, пустой папки в ней не было бы.
    mkdirSync(join(project, 'app'));
    writeFileSync(join(project, 'app', 'README.md'), 'app\n');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'main');
  }, 240_000);

  afterAll(async () => {
    await stand?.stop();
    if (project) rmSync(project, { recursive: true, force: true, maxRetries: 10 });
    rmSync(dirname(CWD_LOG), { recursive: true, force: true, maxRetries: 10 });
  }, 60_000);

  function journalOf(taskId: string): Line[] {
    const file = filesUnder(stand.coreHome).find(
      (path) => path.includes(taskId) && path.endsWith('journal.jsonl'),
    );
    if (!file) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Line);
  }

  /**
   * Ход до запуска: прогон идёт, пока журнал задачи не покажет запуск (`→ running`), отказ команды
   * или пока прогон не кончится сам; затем стоп. Ответ — строки журнала и ошибка прогона.
   */
  async function launchOnce(
    port: CoreChatPort,
    cwd: string = project,
    /** Ждать ещё и этого (например, запуска сеанса), а не только перехода в `running`. */
    also: (lines: Line[]) => boolean = () => true,
  ): Promise<{ lines: Line[]; error: string }> {
    let taskId = '';
    const watched: CoreChatPort = {
      ...port,
      async estimate(fields, env, attachments) {
        const out = await port.estimate(fields, env, attachments);
        if (out.ok) taskId = out.taskId;
        return out;
      },
    };
    const run = new CoreChatRun({
      port: watched,
      book: memoryBook(),
      pollMs: 200,
      waitMs: 120_000,
    });
    let error = '';
    let settled = false;
    const started = run
      .start({ prompt: 'привет', cwd }, () => undefined)
      .catch((e: unknown) => void (error = e instanceof Error ? e.message : String(e)))
      .finally(() => (settled = true));
    const deadline = Date.now() + 150_000;
    const decided = (lines: Line[]) =>
      lines.some(
        (l) =>
          l.kind === 'command.rejected' ||
          (l.kind === 'task.transition' && l.data.to === 'running'),
      );
    const ready = () => {
      if (!taskId) return false;
      const lines = journalOf(taskId);
      return decided(lines) && also(lines);
    };
    while (!settled && Date.now() < deadline && !ready()) {
      await new Promise((done) => setTimeout(done, 250));
    }
    run.stop();
    await started;
    expect(taskId, `оценка не завела задачу: ${error}`).not.toBe('');
    return { lines: journalOf(taskId), error };
  }

  const launched = (lines: Line[]) =>
    lines.some(
      (l) => l.kind === 'task.transition' && l.data.event === 'launch' && l.data.to === 'running',
    );

  it('a copy chat (no placement) launches with no state-conflict', async () => {
    const port = createCoreChatPort(standCaller(stand.apiUrl));
    // Копия: та же оценка без `placement` (и без гранта на дерево).
    const copy: CoreChatPort = {
      ...port,
      estimate: (fields, env, attachments) => {
        const { placement: _inPlace, ...rest } = fields;
        return port.estimate(rest, env, attachments);
      },
    };
    const { lines, error } = await launchOnce(copy);
    const trail = lines.map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 160)}`).join('\n');
    // Задача правда копия (без `placement`): иначе тест не про копию.
    expect(lines.find((l) => l.kind === 'task.created')?.data.placement ?? null, trail).toBeNull();
    expect(
      lines.filter((l) => l.kind === 'command.rejected'),
      trail,
    ).toEqual([]);
    expect(error, trail).not.toMatch(/state-conflict|estimating/);
    expect(launched(lines), trail).toBe(true);
  }, 200_000);

  it('the in-place chat still starts at once: launch applied, no rejection', async () => {
    const { lines, error } = await launchOnce(createCoreChatPort(standCaller(stand.apiUrl)));
    const trail = lines.map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 160)}`).join('\n');
    expect(lines.find((l) => l.kind === 'task.created')?.data.placement, trail).toBe('in-place');
    expect(
      lines.filter((l) => l.kind === 'command.rejected'),
      trail,
    ).toEqual([]);
    expect(error, trail).not.toMatch(/state-conflict/);
    expect(launched(lines), trail).toBe(true);
  }, 200_000);

  /**
   * Проект в подпапке репозитория (`repo/app`): панель шлёт корень проекта и грант на него, ядро
   * закрепляет репозиторий по вершине. Чат обязан идти на месте В ПОДПАПКЕ (строка `chat-in-place`
   * с её путём), а не молча уйти в копию всего репозитория: грант назван на подпапку, и корень
   * единицы, сравниваемый с ним, — подпапка, а не вершина.
   */
  it('an in-place chat in a repo subfolder runs in place at that subfolder, not in a copy of the repo', async () => {
    const sub = join(project, 'app');
    mkdirSync(sub, { recursive: true });
    const { lines, error } = await launchOnce(createCoreChatPort(standCaller(stand.apiUrl)), sub);
    const trail = lines.map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 160)}`).join('\n');
    expect(lines.find((l) => l.kind === 'task.created')?.data.placement, trail).toBe('in-place');
    expect(error, trail).not.toMatch(/state-conflict/);
    const inPlace = lines.filter((l) => l.kind === 'signal' && l.data.signal === 'chat-in-place');
    expect(
      inPlace.map((l) => realpathSync.native(String(l.data.subject))),
      trail,
    ).toEqual([realpathSync.native(sub)]);
    expect(launched(lines), trail).toBe(true);
  }, 200_000);

  /**
   * Тот же проект в подпапке, но чат в копии (без `placement`): копия — всего репозитория, а CLI
   * обязан идти в подпапке копии (там его CLAUDE.md, MCP и транскрипт), а не в её вершине.
   * Папку процесса пишет сам фальшивый `claude` стенда.
   */
  it('a copy chat of a project in a repo subfolder runs its CLI in that subfolder of the copy', async () => {
    const sub = join(project, 'app');
    const port = createCoreChatPort(standCaller(stand.apiUrl));
    const copy: CoreChatPort = {
      ...port,
      estimate: (fields, env, attachments) => {
        const { placement: _inPlace, ...rest } = fields;
        return port.estimate(rest, env, attachments);
      },
    };
    // Копия ЭТОЙ задачи — из её журнала: сеансы прошлых тестов дописывают лог позже своего теста.
    const copyOf = (lines: Line[]): string | undefined => {
      const found = lines.find((l) => l.kind === 'resource.created' && l.data.kind === 'copy');
      if (!found) return undefined;
      const worktree = (JSON.parse(String(found.data.ref)) as { worktree: string }).worktree;
      // Строка ресурса и папка копии на диске — не одно мгновение: под нагрузкой ожидание видело
      // строку раньше папки, и realpath падал ENOENT посреди опроса. Папки нет — копия ещё не готова.
      return existsSync(worktree) ? realpathSync.native(worktree) : undefined;
    };
    const inCopy = (lines: Line[]): string[] => {
      const top = copyOf(lines);
      if (!top) return [];
      return (
        cwdLog()
          // Папка давно снятой копии прошлого теста уже не существует — её путь остаётся как есть.
          .map((dir) => (existsSync(dir) ? realpathSync.native(dir) : dir))
          .filter((dir) => dir === top || dir.startsWith(top + sep))
      );
    };
    const { lines, error } = await launchOnce(copy, sub, (l) => inCopy(l).length > 0);
    const trail = lines.map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 600)}`).join('\n');
    expect(lines.find((l) => l.kind === 'task.created')?.data.placement ?? null, trail).toBeNull();
    const top = copyOf(lines);
    expect(top, `копии нет: ${error}\n${trail}`).toBeDefined();
    const seen = inCopy(lines);
    expect(seen.length, `${error}\n${trail}`).toBeGreaterThan(0);
    // Подпапка КОПИИ, а не её вершина и не подпапка проекта человека.
    expect(new Set(seen), `папки сеанса: ${JSON.stringify(seen)}`).toEqual(
      new Set([join(top ?? '', 'app')]),
    );
  }, 200_000);
});
