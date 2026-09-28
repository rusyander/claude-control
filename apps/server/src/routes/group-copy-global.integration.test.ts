import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group, GroupMember } from '@agentdeck/contracts';
import type { GroupMembersView } from '@agentdeck/contracts/group-describe';
import type { GroupPathView } from '@agentdeck/contracts/group-path';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { describeIdle } from '../domains/groups/describe.ts';
import { readHooksFromFiles } from '../domains/hooks.ts';
import type { GroupAsk } from '../domains/groups/model.ts';
import { blockLang } from '@agentdeck/contracts/brand';
import { registerGroupPathRoutes } from './group-path-routes.ts';
import { registerGroupSourcesRoutes } from './group-sources-routes.ts';

/**
 * «Скопировать в общие» на группе формы доставки тикета (28.09, баг 9а): проектный скилл
 * из 14 шагов, второй проектный скилл, хуки проекта (обычный, с путём проекта,
 * локальный) и сервер MCP. Копия обязана показать те же 14 шагов и ни одного
 * участника без файла — ровно то, что рисует карточка (`/path` и `/members`).
 * Модель подменена (советы и описания), всё остальное — настоящие файлы.
 */

const STEPS = Array.from({ length: 14 }, (_, i) => `## ${i + 1}. Step ${i + 1}\nDo ${i + 1}.`);

describe('копия проектной группы формы доставки тикета в общие', () => {
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let store: AppStore;
  // Ответ модели — подменяемый по тесту; по умолчанию без блока советов.
  let reply: GroupAsk;

  const skill = (dir: string, id: string, body: string): void => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(
      join(dir, id, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${id} skill\n---\n\n${body}\n`,
      'utf8',
    );
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-copy-global-'));
    project = mkdtempSync(join(tmpdir(), 'cc-copy-global-proj-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    const claude = join(project, '.claude');
    skill(join(claude, 'skills'), 'ticket-delivery', `# Ticket\n\n${STEPS.join('\n\n')}`);
    skill(join(claude, 'skills'), 'incident-capture', 'Capture incidents.');
    writeFileSync(
      join(claude, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.mjs' }] },
            {
              matcher: 'Edit',
              hooks: [
                {
                  type: 'command',
                  command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/lint.mjs"',
                },
              ],
            },
          ],
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(claude, 'settings.local.json'),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node notify.mjs' }] }] },
      }),
      'utf8',
    );
    writeFileSync(
      join(project, '.mcp.json'),
      JSON.stringify({
        mcpServers: { tracker: { type: 'http', url: 'https://tracker.example.com/mcp' } },
      }),
      'utf8',
    );

    store = new AppStore(join(root, 'agentdeck'));
    const ctx = {
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          appData: join(root, 'agentdeck'),
        },
      },
      store,
      backupDir: join(root, 'agentdeck', 'backups'),
    } as unknown as ServerContext;
    reply = async () => 'no block';
    const ask: GroupAsk = (...args) => reply(...args);
    app = Fastify();
    registerGroupSourcesRoutes(app, ctx, () => ask);
    registerGroupPathRoutes(app, ctx, () => ask);
    await app.ready();
  });

  afterEach(async () => {
    await describeIdle();
    await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('копия видит все 14 шагов, у каждого перенесённого участника есть файл', async () => {
    const scope = { kind: 'project' as const, path: project, provider: 'claude' };
    const hooks = readHooksFromFiles(
      join(project, '.claude', 'settings.json'),
      join(project, '.claude', 'settings.local.json'),
      project,
    );
    expect(hooks).toHaveLength(3);
    const members: GroupMember[] = [
      { kind: 'skill', id: 'ticket-delivery', scope },
      { kind: 'skill', id: 'incident-capture', scope },
      ...hooks.map((hook) => ({ kind: 'hook' as const, id: hook.id, scope })),
      { kind: 'mcp', id: 'tracker', scope },
    ];
    const source: Group = store.saveGroup({
      id: 'ticket-delivery',
      name: 'Ticket delivery',
      description: '',
      color: 'accent',
      icon: 'folder',
      members,
      env: {},
      projectPaths: [],
      scope,
      isEnabled: true,
      order: 0,
    });

    const sourcePath = (
      await app.inject({ method: 'GET', url: `/api/groups/${source.id}/path` })
    ).json() as GroupPathView;
    expect(sourcePath.entries.filter((entry) => entry.kind === 'skill-step')).toHaveLength(14);

    const res = await app.inject({
      method: 'POST',
      url: `/api/groups/${source.id}/copy-to-global`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const { group: copy, warnings } = res.json() as {
      group: Group;
      warnings: { kind: string; member: string; detail: string }[];
    };
    // Хук с путём проекта в общих настройках срабатывал бы везде — пропущен и назван.
    expect(warnings.map((warning) => `${warning.kind}:${warning.detail}`)).toEqual([
      'skipped:project-relative',
    ]);
    expect(existsSync(join(root, 'skills', 'ticket-delivery', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(root, 'skills', 'incident-capture', 'SKILL.md'))).toBe(true);

    const path = (
      await app.inject({ method: 'GET', url: `/api/groups/${copy.id}/path` })
    ).json() as GroupPathView;
    const steps = path.entries.filter((entry) => entry.kind === 'skill-step');
    expect(steps.map((entry) => entry.title)).toEqual(
      Array.from({ length: 14 }, (_, i) => `Step ${i + 1}`),
    );
    expect(path.unreadable).toBeUndefined();

    const view = (
      await app.inject({ method: 'GET', url: `/api/groups/${copy.id}/members` })
    ).json() as GroupMembersView;
    expect(view.members.filter((member) => member.missing).map((member) => member.id)).toEqual([]);
    expect(view.members.map((member) => member.kind).sort()).toEqual(
      ['hook', 'hook', 'mcp', 'skill', 'skill'].sort(),
    );
  });
  // Ревью 28.09 (F-211): сбой модели и «модель посмотрела — советовать нечего»
  // приходили одинаковым пустым списком, и окно говорило «копия готова как есть»
  // про копию, которую никто не смотрел.
  describe('советы после копии: сбой модели назван', () => {
    const copyOne = async () => {
      const scope = { kind: 'project' as const, path: project, provider: 'claude' };
      const source = store.saveGroup({
        id: 'one',
        name: 'One',
        description: '',
        color: 'accent',
        icon: 'folder',
        members: [{ kind: 'skill', id: 'incident-capture', scope }],
        env: {},
        projectPaths: [],
        scope,
        isEnabled: true,
        order: 0,
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/groups/${source.id}/copy-to-global`,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      return res.json() as { advice: unknown[]; adviceFailed?: boolean };
    };

    it('модель упала — adviceFailed', async () => {
      reply = async () => {
        throw new Error('model down');
      };
      expect(await copyOne()).toMatchObject({ advice: [], adviceFailed: true });
    });

    it('ответ без блока советов — adviceFailed', async () => {
      expect(await copyOne()).toMatchObject({ advice: [], adviceFailed: true });
    });

    it('модель ответила пустым списком — советов нет, сбоя нет', async () => {
      reply = async () => `\`\`\`${blockLang('group-advice')}\n{"advice":[]}\n\`\`\``;
      const result = await copyOne();
      expect(result.advice).toEqual([]);
      expect(result.adviceFailed).toBeUndefined();
    });
  });

  it('общая группа, привязанная к проекту: скилл из .claude проекта назван «только в проекте», а не «нет файла»', async () => {
    const group: Group = store.saveGroup({
      id: 'legacy',
      name: 'Project skills',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [
        { kind: 'skill', id: 'incident-capture' },
        { kind: 'skill', id: 'nowhere' },
      ],
      env: {},
      projectPaths: [project],
      isEnabled: true,
      order: 0,
    });
    const view = (
      await app.inject({ method: 'GET', url: `/api/groups/${group.id}/members` })
    ).json() as GroupMembersView;
    expect(view.members).toEqual([
      { kind: 'skill', id: 'incident-capture', missing: true, foundIn: project },
      { kind: 'skill', id: 'nowhere', missing: true },
    ]);
  });
});
