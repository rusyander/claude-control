import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import { blockLang } from '@agentdeck/contracts/brand';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { GroupAsk } from '../../domains/groups/model.ts';
import { resetDiscoveryRuns } from '../../domains/group-discovery/run.ts';
import { registerGroupSourcesRoutes } from './group-sources-routes.ts';

/**
 * Переопределение группы в проекте — ревью 28.09. F-15: путь брался любой, и
 * `$HOME` превращал `$HOME/.claude` (общий конфиг) в «проект». F-255: выключение
 * через ЧУЖУЮ группу снимало переопределение, включённое другой. F-254: запреты
 * скиллов писались только при первом включении. Всё во временных каталогах;
 * модель — подмена (граница процесса CLI).
 */

const block = (kind: string, body: string): string =>
  `\n\`\`\`${blockLang(kind)}\n${body}\n\`\`\`\n`;

describe('переопределение: чей проект и чья запись', () => {
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let store: AppStore;

  const group = (patch: Partial<Group> & { id: string }): Group =>
    store.saveGroup({
      name: patch.id,
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [],
      env: {},
      projectPaths: [],
      isEnabled: true,
      order: 0,
      ...patch,
    });

  const skill = (id: string): void => {
    mkdirSync(join(project, '.claude', 'skills', id), { recursive: true });
    writeFileSync(join(project, '.claude', 'skills', id, 'SKILL.md'), `# ${id}\n`, 'utf8');
  };

  const put = (id: string, path: string, enabled: boolean) =>
    app.inject({ method: 'PUT', url: `/api/groups/${id}/override`, payload: { path, enabled } });

  const rule = (): string => join(project, '.claude', 'rules', 'agentdeck-group.local.md');
  const deny = (): string[] =>
    (
      JSON.parse(readFileSync(join(project, '.claude', 'settings.local.json'), 'utf8')) as {
        permissions: { deny: string[] };
      }
    ).permissions.deny;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-override-scope-'));
    project = join(root, 'proj');
    mkdirSync(join(root, '.claude', 'agentdeck'), { recursive: true });
    mkdirSync(join(project, '.git', 'info'), { recursive: true });
    store = new AppStore(join(root, '.claude', 'agentdeck'));
    resetDiscoveryRuns();
    const ctx = {
      location: {
        paths: {
          root: join(root, '.claude'),
          settings: join(root, '.claude', 'settings.json'),
          settingsLocal: join(root, '.claude', 'settings.local.json'),
          claudeMd: join(root, '.claude', 'CLAUDE.md'),
          skills: join(root, '.claude', 'skills'),
          hooks: join(root, '.claude', 'hooks'),
          mcpConfig: join(root, '.claude', '.claude.json'),
          secretsEnv: join(root, '.claude', '.mcp-secrets.env'),
          appData: join(root, '.claude', 'agentdeck'),
        },
      },
      store,
      backupDir: join(root, '.claude', 'agentdeck', 'backups'),
    } as unknown as ServerContext;
    const ask: GroupAsk = async () => block('group-override', '# Follow the global group');
    app = Fastify();
    registerGroupSourcesRoutes(app, ctx, () => ask);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    resetDiscoveryRuns();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('F-15: каталог конфигурации как «проект» — отказ, общий конфиг не тронут', async () => {
    // Даже при группе «проекта» в домашнем каталоге: его `.claude` — общий конфиг.
    group({ id: 'proj-home', scope: { kind: 'project', path: root, provider: 'claude' } });
    group({ id: 'glob-1' });
    const res = await put('glob-1', root, true);
    expect(res.statusCode).toBe(400);
    expect(existsSync(join(root, '.claude', 'rules'))).toBe(false);
    expect(existsSync(join(root, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('F-15: каталог, где нет ни одной группы проекта, — отказ', async () => {
    group({ id: 'glob-1' });
    const res = await put('glob-1', project, true);
    expect(res.statusCode).toBe(400);
    expect(existsSync(rule())).toBe(false);
  });

  it('F-255: выключение через другую группу не снимает чужое переопределение', async () => {
    skill('ladder');
    group({
      id: 'proj-1',
      scope: { kind: 'project', path: project, provider: 'claude' },
      members: [{ kind: 'skill', id: 'ladder' }],
    });
    group({ id: 'glob-a' });
    group({ id: 'glob-b' });
    expect((await put('glob-a', project, true)).statusCode).toBe(200);

    const off = await put('glob-b', project, false);
    expect(off.json().enabled).toBe(false);
    expect(existsSync(rule())).toBe(true);
    expect(deny()).toEqual(['Skill(ladder)']);
  });

  it('F-254: повторное включение после нового скилла проекта дописывает его запрет', async () => {
    skill('ladder');
    const proj = group({
      id: 'proj-1',
      scope: { kind: 'project', path: project, provider: 'claude' },
      members: [{ kind: 'skill', id: 'ladder' }],
    });
    group({ id: 'glob-a' });
    expect((await put('glob-a', project, true)).json().deny).toEqual(['Skill(ladder)']);

    skill('review');
    store.saveGroup({ ...proj, members: [...proj.members, { kind: 'skill', id: 'review' }] });
    const again = await put('glob-a', project, true);
    expect(again.json().deny).toEqual(['Skill(ladder)', 'Skill(review)']);
    expect(deny()).toEqual(['Skill(ladder)', 'Skill(review)']);

    // Выключение по-прежнему возвращает проект как был: файла прав до панели не было.
    await put('glob-a', project, false);
    expect(existsSync(join(project, '.claude', 'settings.local.json'))).toBe(false);
  });
});
