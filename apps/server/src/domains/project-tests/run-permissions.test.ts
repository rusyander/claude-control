import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestCase, ProjectTestRunMode } from '@agentdeck/contracts';
import {
  decidePermission,
  describeScope,
  isWritable,
  runScope,
  startPermissionGate,
  type RunPermissionGate,
} from './run-permissions.ts';

/**
 * Права прогона. Раньше агент шёл с `bypassPermissions`, и границы держало
 * только задание словами; здесь проверяется, что теперь их держит код — но
 * при этом прогон по-прежнему МОЖЕТ делать свою работу. Второе не менее важно
 * первого: права, запретившие писать статусы, отменяют сам прогон.
 */
function testCase(id: string, file?: string): ProjectTestCase {
  return {
    id,
    type: 'case',
    title: `Кейс ${id}`,
    steps: [],
    status: 'unknown',
    source: 'agent',
    automation: file ? { status: 'automated', file } : undefined,
  };
}

describe('project-tests run-permissions', () => {
  let root = '';
  const scopeOf = (mode: ProjectTestRunMode, cases: ProjectTestCase[] = []) =>
    runScope(root, mode, cases);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-perm-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe('генерация и прогон пишут только в свой каталог', () => {
    for (const mode of ['run', 'explore'] as const) {
      it(`${mode}: кейсы записать можно, чужой код — нет`, () => {
        const scope = scopeOf(mode);

        // То, ради чего прогон и запускают: свои файлы он пишет.
        expect(
          decidePermission(scope, 'Write', {
            file_path: join(root, '.agent', 'tests', 'gui.tests.json'),
          }).behavior,
        ).toBe('allow');
        expect(
          decidePermission(scope, 'Edit', { file_path: '.agent/tests/runs/2026-09-07.json' })
            .behavior,
        ).toBe('allow');

        // И то, ради чего заведены сами права: чужой рабочий код он не трогает.
        const denied = decidePermission(scope, 'Write', {
          file_path: join(root, 'apps', 'web', 'src', 'App.tsx'),
        });
        expect(denied.behavior).toBe('deny');
        expect(denied.message).toContain('.agent/tests/');
        // Отказ обязан объяснить, что делать с находкой, иначе агент начнёт
        // искать обход вместо того, чтобы записать результат.
        expect(denied.message).toContain('failed');
      });
    }

    /**
     * Главное право этой партии: генерация НЕ пишет в библиотеку. Не «не должна»
     * по заданию, а не может — иначе галочка «принимать сразу» превращалась бы в
     * разрешение прогону править файлы групп, а откатывать было бы нечем.
     */
    it('генерация пишет только черновик — файлы групп ей запрещены', () => {
      const scope = scopeOf('generate');

      expect(
        decidePermission(scope, 'Write', {
          file_path: join(root, '.agent', 'tests', 'drafts', 'run-1.draft.json'),
        }).behavior,
      ).toBe('allow');

      const denied = decidePermission(scope, 'Write', {
        file_path: join(root, '.agent', 'tests', 'gui.tests.json'),
      });
      expect(denied.behavior).toBe('deny');
      expect(denied.message).toContain('drafts');
      // Соседние файлы хозяйства — тоже не её дело: черновик и есть весь результат.
      expect(isWritable(scope, '.agent/tests/_shared.steps.json')).toBe(false);
      expect(isWritable(scope, '.agent/tests/environments.json')).toBe(false);
      expect(describeScope(scope)).toContain('черновик');
    });

    it('за корень проекта не выпускает даже абсолютным путём', () => {
      const scope = scopeOf('run');
      const outside = resolve(root, '..', 'чужой-проект', 'src', 'index.ts');

      expect(decidePermission(scope, 'Write', { file_path: outside }).behavior).toBe('deny');
      expect(isWritable(scope, outside)).toBe(false);
      // Путь вверх из тестового каталога — тот же выход наружу, только скрытый.
      expect(isWritable(scope, '.agent/tests/../../src/main.ts')).toBe(false);
    });

    it('режим `automate` пишет НАЗВАННЫЕ кейсами автотесты и соседей по папке', () => {
      const cases = [testCase('gui-001', 'tests/e2e/chat.spec.ts'), testCase('gui-002')];
      const scope = scopeOf('automate', cases);

      expect(scope.testFiles).toEqual(['tests/e2e/chat.spec.ts']);
      expect(isWritable(scope, 'tests/e2e/chat.spec.ts')).toBe(true);
      // Фикстура рядом с тестом — часть того же теста.
      expect(isWritable(scope, 'tests/e2e/fixtures/user.json')).toBe(true);
      // А исходники приложения — по-прежнему нет.
      expect(isWritable(scope, 'apps/web/src/App.tsx')).toBe(false);
      expect(describeScope(scope)).toContain('tests/e2e/chat.spec.ts');
    });

    it('в остальных режимах имя автотеста прав не даёт', () => {
      const cases = [testCase('gui-001', 'tests/e2e/chat.spec.ts')];

      expect(isWritable(scopeOf('run', cases), 'tests/e2e/chat.spec.ts')).toBe(false);
      expect(scopeOf('generate', cases).testFiles).toEqual([]);
    });
  });

  describe('остальные инструменты', () => {
    it('чтение и поиск разрешены — без них тест не пройти', () => {
      const scope = scopeOf('run');

      for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'TodoWrite']) {
        expect(decidePermission(scope, tool, { file_path: 'apps/web/src/App.tsx' }).behavior).toBe(
          'allow',
        );
      }
      // Инструмент MCP — тоже способ посмотреть: браузер, база, трекер.
      expect(decidePermission(scope, 'mcp__playwright__click', {}).behavior).toBe('allow');
    });

    it('команды разрешены, но двигать историю репозитория прогон не будет', () => {
      const scope = scopeOf('run');

      expect(decidePermission(scope, 'Bash', { command: 'pnpm test' }).behavior).toBe('allow');
      expect(decidePermission(scope, 'Bash', { command: 'git status --porcelain' }).behavior).toBe(
        'allow',
      );

      const denied = decidePermission(scope, 'Bash', { command: 'git commit -am "fix"' });
      expect(denied.behavior).toBe('deny');
      expect(decidePermission(scope, 'Bash', { command: 'git push origin main' }).behavior).toBe(
        'deny',
      );
      expect(denied.message).toContain('коммить');
    });

    it('вопрос человеку в прогоне отклоняется: спрашивать некого', () => {
      const decision = decidePermission(scopeOf('run'), 'AskUserQuestion', {});

      expect(decision.behavior).toBe('deny');
      expect(decision.message).toContain('note');
    });
  });

  describe('приёмник решений', () => {
    let gate: RunPermissionGate | undefined;

    afterEach(() => {
      gate?.close();
      gate = undefined;
    });

    /** Тот самый запрос, который шлёт брокер прав CLI. */
    const ask = async (
      target: RunPermissionGate,
      body: Record<string, unknown>,
    ): Promise<{ behavior: string; message?: string }> => {
      const response = await fetch(`${target.baseUrl}/api/chat/permission-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return (await response.json()) as { behavior: string; message?: string };
    };

    it('отвечает по тем же правилам живым HTTP — и записывает отказ', async () => {
      const denials: string[] = [];
      gate = await startPermissionGate(scopeOf('generate'), (tool, message) =>
        denials.push(`${tool}: ${message}`),
      );

      const allowed = await ask(gate, {
        runId: gate.runId,
        toolName: 'Write',
        input: { file_path: '.agent/tests/drafts/run-1.draft.json' },
      });
      const denied = await ask(gate, {
        runId: gate.runId,
        toolName: 'Write',
        input: { file_path: 'apps/server/src/index.ts' },
      });

      expect(gate.baseUrl.startsWith('http://127.0.0.1:')).toBe(true);
      expect(allowed.behavior).toBe('allow');
      expect(denied.behavior).toBe('deny');
      // Отказ виден человеку в логе прогона, иначе он останется догадкой.
      expect(denials).toHaveLength(1);
      expect(denials[0]).toContain('apps/server/src/index.ts');
    });

    it('чужой запрос на тот же порт не проходит', async () => {
      gate = await startPermissionGate(scopeOf('run'));

      const stranger = await ask(gate, {
        runId: 'не-этот-прогон',
        toolName: 'Read',
        input: { file_path: 'README.md' },
      });

      expect(stranger.behavior).toBe('deny');
    });

    it('мусор вместо тела не роняет приёмник', async () => {
      gate = await startPermissionGate(scopeOf('run'));

      const response = await fetch(`${gate.baseUrl}/api/chat/permission-request`, {
        method: 'POST',
        body: 'это не json',
      });

      expect(response.status).toBe(200);
      expect(((await response.json()) as { behavior: string }).behavior).toBe('deny');
    });
  });
});
