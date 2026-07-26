import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ClaudeLocation } from '@claude-control/contracts';
import { AppStore } from '../../lib/app-store.ts';
import { createSandbox, removeSandbox, sandboxPaths, stopSandboxSweeper } from './SandboxConfig.ts';

/**
 * Тесты изоляции песочницы. Суть песочницы — временный каталог настроек, куда
 * попадает только проверяемое. Здесь закрепляем главное: границы соблюдаются,
 * учётные данные переносятся (без них Claude Code не работает), а файл с
 * токенами не копируется никогда.
 *
 * Песочница пишет в ~/.claude-control/sandboxes — тест использует уникальный
 * id и убирает его за собой.
 */
describe('SandboxConfig', () => {
  let root: string;
  let location: ClaudeLocation;
  let store: AppStore;
  const sandboxId = `qa-test-${process.pid}`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-sandbox-'));
    mkdirSync(join(root, 'skills'), { recursive: true });
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), '');
    writeFileSync(join(root, '.credentials.json'), '{"token":"secret"}');
    writeFileSync(join(root, '.mcp-secrets.env'), 'GITLAB_TOKEN=real-secret');

    location = {
      source: 'manual',
      paths: {
        root,
        settings: join(root, 'settings.json'),
        settingsLocal: join(root, 'settings.local.json'),
        claudeMd: join(root, 'CLAUDE.md'),
        secretsEnv: join(root, '.mcp-secrets.env'),
        skills: join(root, 'skills'),
        hooks: join(root, 'hooks'),
        mcpConfig: join(root, '.claude.json'),
        appData: join(root, 'claude-control'),
      },
      isValid: true,
      missing: [],
    } as ClaudeLocation;

    store = new AppStore(join(root, 'claude-control'));
  });

  afterEach(() => {
    // Сборка песочницы взводит фоновое подметание — тест не оставляет его тикать.
    stopSandboxSweeper();
    removeSandbox(sandboxId);
    rmSync(root, { recursive: true, force: true });
  });

  it('создаёт каталог конфигурации и рабочую папку', () => {
    const sandbox = createSandbox(sandboxId, {}, location, store);
    expect(existsSync(sandbox.configDir)).toBe(true);
    expect(existsSync(sandbox.workDir)).toBe(true);
  });

  it('переносит учётные данные — без них Claude Code не запустится', () => {
    const sandbox = createSandbox(sandboxId, {}, location, store);
    expect(existsSync(join(sandbox.configDir, '.credentials.json'))).toBe(true);
  });

  it('НЕ копирует файл с токенами MCP', () => {
    const sandbox = createSandbox(sandboxId, {}, location, store);
    expect(existsSync(join(sandbox.configDir, '.mcp-secrets.env'))).toBe(false);
  });

  it('настройки песочницы закрывают настоящий каталог на запись', () => {
    const sandbox = createSandbox(sandboxId, {}, location, store);
    const settings = JSON.parse(readFileSync(join(sandbox.configDir, 'settings.json'), 'utf8'));
    const deny: string[] = settings.permissions?.deny ?? [];

    const realPath = root.replace(/\\/g, '/');
    expect(deny.some((rule) => rule.includes(`Write(${realPath}`))).toBe(true);
    expect(deny.some((rule) => rule.includes('.credentials.json'))).toBe(true);
    expect(deny.some((rule) => rule.includes('.mcp-secrets.env'))).toBe(true);
  });

  it('пустой набор — пустое описание состава', () => {
    const sandbox = createSandbox(sandboxId, {}, location, store);
    expect(sandbox.description.rules).toEqual([]);
    expect(sandbox.description.skills).toEqual([]);
  });

  it('sandboxPaths кладёт песочницы вне настоящего каталога .claude', () => {
    const { root: sandboxRoot } = sandboxPaths(sandboxId);
    expect(sandboxRoot).toContain('.claude-control');
  });

  it('id из запрещённых символов не схлопывается в корень всех песочниц', () => {
    // Регрессия: чистка `[^a-zA-Z0-9-]` превращает такие id в пустую строку, и
    // тогда root совпадал с корнем sandboxes — а по нему createSandbox/
    // removeSandbox делают rmSync(recursive), то есть снесли бы ВСЕ песочницы
    // разом (в каждой — копия .credentials.json). Теперь это ошибка.
    for (const bad of ['', '..', '///', '!!!']) {
      expect(() => sandboxPaths(bad)).toThrow(/идентификатор/i);
    }
  });

  it('обход каталога через id не выводит за пределы корня песочниц', () => {
    const { root } = sandboxPaths('../../etc');
    // Точки и слэши вычищены — остаётся безобидное имя внутри корня.
    expect(root).toMatch(/[\\/]sandboxes[\\/]etc$/);
  });

  it('черновик правила попадает в CLAUDE.md и в состав', () => {
    const sandbox = createSandbox(
      sandboxId,
      { draftRule: { title: 'Тестовое', text: 'Текст правила' } },
      location,
      store,
    );

    const claudeMd = readFileSync(join(sandbox.configDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('Тестовое');
    expect(claudeMd).toContain('Текст правила');
    expect(sandbox.description.rules.some((name) => name.includes('черновик'))).toBe(true);
  });

  it('выбранный скрипт копируется в песочницу, а не берётся из оригинала', () => {
    writeFileSync(join(root, 'hooks', 'guard.mjs'), 'process.exit(0)');

    const sandbox = createSandbox(sandboxId, { scriptNames: ['guard.mjs'] }, location, store);

    expect(existsSync(join(sandbox.configDir, 'hooks', 'guard.mjs'))).toBe(true);
    expect(sandbox.description.scripts).toContain('guard.mjs');
  });

  it('рабочая папка едет в sandbox.env, а не в глобальный process.env', () => {
    delete process.env.CLAUDE_CONTROL_SANDBOX_WORKDIR;

    // hookIds непуст — collectHooks идёт ровно по тому пути, который РАНЬШЕ писал
    // рабочую папку в process.env сервера (даже когда конкретный хук не найден).
    const sandbox = createSandbox(sandboxId, { hookIds: ['нет-такого-хука'] }, location, store);

    // Значение доступно запуску через окружение самой песочницы.
    expect(sandbox.env.CLAUDE_CONTROL_SANDBOX_WORKDIR).toBe(sandbox.workDir);
    // А глобальное окружение сервера не тронуто: раньше при параллельной сборке
    // двух песочниц значение протекало во все последующие дочерние процессы.
    expect(process.env.CLAUDE_CONTROL_SANDBOX_WORKDIR).toBeUndefined();
  });

  // ── Удаление песочницы: внутри копия доступа к аккаунту ──
  describe('removeSandbox', () => {
    it('сносит песочницу со скиллом, у которого русское имя папки', () => {
      // Регрессия: рекурсивный rmSync на таких путях под Windows рапортует об
      // успехе, ничего не удалив (см. safe-io.ts), — и копия .credentials.json
      // оставалась на диске, пока панель докладывала «песочница стёрта».
      mkdirSync(join(root, 'skills', 'мой-скилл'), { recursive: true });
      writeFileSync(join(root, 'skills', 'мой-скилл', 'SKILL.md'), '# скилл');

      const sandbox = createSandbox(sandboxId, { skillIds: ['мой-скилл'] }, location, store);
      expect(existsSync(join(sandbox.configDir, 'skills', 'мой-скилл', 'SKILL.md'))).toBe(true);

      removeSandbox(sandboxId);

      const { root: sandboxRoot } = sandboxPaths(sandboxId);
      expect(existsSync(sandboxRoot)).toBe(false);
      expect(existsSync(join(sandbox.configDir, '.credentials.json'))).toBe(false);
    });

    it('повторное удаление не считается ошибкой', () => {
      createSandbox(sandboxId, {}, location, store);
      removeSandbox(sandboxId);

      expect(() => removeSandbox(sandboxId)).not.toThrow();
    });

    it.runIf(process.platform === 'win32')(
      'папку не отдали — наружу ошибка с путём, а не молчаливое «удалено»',
      () => {
        // Ради чего всё затевалось: маршрут DELETE возвращает {ok:true}
        // последней строкой, поэтому неудача обязана прийти исключением, иначе
        // пользователю сообщат об удалении оставшейся на диске копии доступа.
        // Занятую папку воспроизводим текущим каталогом процесса — Windows не
        // даёт её удалить (на POSIX даёт, поэтому проверка только здесь).
        const sandbox = createSandbox(sandboxId, {}, location, store);
        const { root: sandboxRoot } = sandboxPaths(sandboxId);
        const cwd = process.cwd();
        process.chdir(sandboxRoot);

        try {
          expect(() => removeSandbox(sandboxId)).toThrow(/удалить/i);
          expect(existsSync(sandboxRoot)).toBe(true);
        } finally {
          process.chdir(cwd);
        }

        expect(sandbox.configDir).toContain(sandboxRoot);
      },
    );
  });

  it('MCP-сервер попадает в settings.json песочницы со своими полями', () => {
    writeFileSync(
      join(root, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          local: { type: 'stdio', command: 'npx', args: ['-y', 'demo'], env: { A: '1' } },
        },
      }),
    );

    const sandbox = createSandbox(sandboxId, { mcpIds: ['local'] }, location, store);
    const settings = JSON.parse(readFileSync(join(sandbox.configDir, 'settings.json'), 'utf8')) as {
      mcpServers?: Record<string, { command?: string; env?: Record<string, string> }>;
    };

    expect(settings.mcpServers?.local?.command).toBe('npx');
    expect(settings.mcpServers?.local?.env).toEqual({ A: '1' });
    expect(sandbox.description.mcpServers).toContain('local');
  });
});
