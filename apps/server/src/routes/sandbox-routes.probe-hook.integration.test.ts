import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { sandboxPaths } from '../domains/sandbox/SandboxConfig.ts';
import { registerSandboxRoutes } from './sandbox-routes.ts';

/**
 * Прогон хука обязан оставаться внутри песочницы.
 *
 * Два способа выйти наружу были рядом. Имя скрипта из тела запроса склеивалось
 * с каталогом без проверки — `../../…` уводил к любому файлу на диске, и он
 * исполнялся. А если копии в песочнице не оказывалось (сборка не успела,
 * скрипта не было на месте), маршрут молча брал НАСТОЯЩИЙ файл из ~/.claude/hooks:
 * панель обещает «что хук напишет — останется в песочнице», а писалось это
 * в реальную конфигурацию.
 *
 * Скрипты здесь свои, в tmp: настоящие пользовательские хуки тест не запускает.
 * Факт запуска проверяется по файлу-метке, который скрипт пишет рядом с собой.
 */
describe('sandbox-routes: probe-hook не выходит за пределы песочницы', () => {
  let root: string;
  let app: FastifyInstance;
  let marks: string;
  const id = `qa-probe-${process.pid}`;

  const sandbox = (): { workDir: string; hooksDir: string } => {
    const paths = sandboxPaths(id);
    return { workDir: paths.workDir, hooksDir: join(paths.configDir, 'hooks') };
  };

  /** Скрипт, который при запуске оставляет метку с заданным именем. */
  const writeScript = (path: string, mark: string): void => {
    writeFileSync(
      path,
      `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(join(marks, mark))}, 'ран');\n`,
    );
  };

  const probe = (body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/sandbox/probe-hook',
      payload: { id, fixtureIds: ['bash-safe'], ...body },
    });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-probe-routes-'));
    marks = join(root, 'marks');
    mkdirSync(marks, { recursive: true });
    mkdirSync(join(root, 'claude-control'), { recursive: true });
    mkdirSync(join(root, 'hooks'), { recursive: true });

    // Настоящий скрипт хука — тот, что не должен запускаться из песочницы.
    writeScript(join(root, 'hooks', 'guard.mjs'), 'real.txt');
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: `node "${join(root, 'hooks', 'guard.mjs')}"` }],
            },
          ],
        },
      }),
    );

    const ctx = {
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          hooks: join(root, 'hooks'),
          appData: join(root, 'claude-control'),
        },
      },
      store: new AppStore(join(root, 'claude-control')),
    } as unknown as ServerContext;

    // Песочница «собрана»: рабочий каталог и hooks/ есть, копии скрипта нет.
    mkdirSync(sandbox().workDir, { recursive: true });
    mkdirSync(sandbox().hooksDir, { recursive: true });

    app = Fastify();
    registerSandboxRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(sandboxPaths(id).root, { recursive: true, force: true });
  });

  const hookId = async (): Promise<string> => {
    const { readHooks } = await import('../domains/hooks.ts');
    const store = new AppStore(join(root, 'claude-control'));
    return readHooks(join(root, 'settings.json'), store)[0]?.id ?? '';
  };

  it('имя скрипта с выходом из каталога отклоняется, файл не запускается', async () => {
    const outside = relative(sandbox().hooksDir, join(root, 'hooks', 'guard.mjs'))
      .split(sep)
      .join('/');

    const response = await probe({ scriptName: outside });

    expect(response.json<{ error?: string }>().error).toContain('Недопустимое имя скрипта');
    expect(response.json<{ results: unknown[] }>().results).toEqual([]);
    expect(existsSync(join(marks, 'real.txt'))).toBe(false);
  });

  it('без копии в песочнице скрипт не подменяется настоящим — прогон отменяется', async () => {
    const response = await probe({ scriptName: 'guard.mjs' });

    expect(response.json<{ error?: string }>().error).toContain('не попал в песочницу');
    expect(existsSync(join(marks, 'real.txt'))).toBe(false);
  });

  it('у хука без копии скрипта запускать нечего — оригинал не трогаем', async () => {
    const response = await probe({ hookId: await hookId() });

    expect(response.json<{ error?: string }>().error).toContain('не попал в песочницу');
    expect(existsSync(join(marks, 'real.txt'))).toBe(false);
  });

  it('несобранная песочница: прогон не начинается', async () => {
    rmSync(sandboxPaths(id).root, { recursive: true, force: true });

    const response = await probe({ scriptName: 'guard.mjs' });

    expect(response.json<{ error?: string }>().error).toContain('ещё не собрана');
    expect(existsSync(join(marks, 'real.txt'))).toBe(false);
  });

  it('копия на месте — запускается именно она', async () => {
    writeScript(join(sandbox().hooksDir, 'guard.mjs'), 'copy.txt');

    const response = await probe({ scriptName: 'guard.mjs' });
    const body = response.json<{ error?: string; command?: string; results: unknown[] }>();

    expect(body.error).toBeUndefined();
    expect(body.command).toContain(sandbox().hooksDir);
    expect(body.results).toHaveLength(1);
    expect(existsSync(join(marks, 'copy.txt'))).toBe(true);
    expect(existsSync(join(marks, 'real.txt'))).toBe(false);
  });
});
