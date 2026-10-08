import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import { blockLang } from '@agentdeck/contracts/brand';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { GroupAsk, GroupModelMessage } from '../../domains/groups/model.ts';
import { resetDiscoveryRuns } from '../../domains/group-discovery/run.ts';
import { registerGroupSourcesRoutes } from './group-sources-routes.ts';

/**
 * Группы по областям со стороны маршрутов: временный каталог конфигурации,
 * временный проект и подменённая модель (единственная граница, которую тест
 * не проходит по-настоящему — процесс CLI и сеть).
 */

const block = (kind: string, body: unknown): string =>
  `\n\`\`\`${blockLang(kind)}\n${typeof body === 'string' ? body : JSON.stringify(body)}\n\`\`\`\n`;

/** Все файлы каталога байтами — «проект байт в байт как был». */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        out[`${relative(dir, full)}/`] = '';
        walk(full);
      } else out[relative(dir, full)] = readFileSync(full, 'latin1');
    }
  };
  walk(dir);
  return out;
}

describe('маршруты групп по областям', () => {
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let store: AppStore;
  let calls: GroupModelMessage[][];
  let answer: (messages: GroupModelMessage[]) => string;

  const skill = (dir: string, id: string, body: string): void => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(
      join(dir, id, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${id} skill\n---\n\n${body}\n`,
      'utf8',
    );
  };

  const projectGroup = (patch: Partial<Group> = {}): Group =>
    store.saveGroup({
      id: 'proj-1',
      name: 'Ticket flow',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'skill', id: 'ladder' }],
      env: {},
      projectPaths: [],
      scope: { kind: 'project', path: project, provider: 'claude' },
      isEnabled: true,
      order: 0,
      ...patch,
    });

  const globalGroup = (patch: Partial<Group> = {}): Group =>
    store.saveGroup({
      id: 'glob-1',
      name: 'Ticket flow (global)',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'skill', id: 'global-ladder' }],
      env: {},
      projectPaths: [],
      isEnabled: true,
      order: 1,
      ...patch,
    });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-sources-'));
    project = mkdtempSync(join(tmpdir(), 'cc-group-sources-proj-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    skill(join(project, '.claude', 'skills'), 'ladder', '## 1. Read\n\n## 2. Write');
    mkdirSync(join(project, '.git', 'info'), { recursive: true });
    writeFileSync(join(project, '.git', 'info', 'exclude'), '# git ls-files --others\n', 'utf8');

    store = new AppStore(join(root, 'agentdeck'));
    calls = [];
    answer = () => 'no block';
    resetDiscoveryRuns();

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

    const ask: GroupAsk = async (messages) => {
      calls.push(messages);
      return answer(messages);
    };
    app = Fastify();
    registerGroupSourcesRoutes(app, ctx, () => ask);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    resetDiscoveryRuns();
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('выбор группы проекта пишется и читается обратно', async () => {
    projectGroup();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/projects/group-choice',
      payload: { path: project, groupKey: 'project:proj-1' },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({
      method: 'GET',
      url: `/api/projects/group-choice?path=${encodeURIComponent(project)}`,
    });
    expect(get.json()).toEqual({
      groupKey: 'project:proj-1',
      choices: { 'proj-1': 'project:proj-1' },
    });
  });

  // F-113: выбор у каждой пары свой — копия второй группы и её сторона не
  // возвращают первую пару к проектной.
  it('копия второй проектной группы не снимает выбор первой пары', async () => {
    projectGroup();
    projectGroup({ id: 'proj-2', name: 'Review flow', members: [], order: 2 });
    answer = () => block('group-advice', { advice: [] });
    const copy = async (id: string): Promise<string> => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/groups/${id}/copy-to-global`,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { group: Group }).group.id;
    };
    const first = await copy('proj-1');
    const second = await copy('proj-2');
    const choice = async (group: string): Promise<unknown> =>
      (
        await app.inject({
          method: 'GET',
          url: `/api/projects/group-choice?path=${encodeURIComponent(project)}&group=${group}`,
        })
      ).json();
    expect(await choice('proj-1')).toEqual({
      groupKey: `global:${first}`,
      choices: { 'proj-1': `global:${first}`, 'proj-2': `global:${second}` },
    });
    // Сторона второй пары — назад к проектной; первая остаётся глобальной.
    const put = await app.inject({
      method: 'PUT',
      url: '/api/projects/group-choice',
      payload: { path: project, groupKey: 'project:proj-2' },
    });
    expect(put.statusCode).toBe(200);
    expect(await choice(`global:${first}`)).toMatchObject({ groupKey: `global:${first}` });
    expect(await choice('proj-2')).toMatchObject({ groupKey: 'project:proj-2' });
  });

  it('ключ группы, которая не сторона пары проекта, — 409 group-not-paired', async () => {
    projectGroup();
    globalGroup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/group-choice',
      payload: { path: project, groupKey: 'global:glob-1' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().messageCode).toBe('group-not-paired');
  });

  it('выбор, при котором действуют обе группы пары, отклоняется 409', async () => {
    projectGroup();
    globalGroup({
      projectPaths: [project],
      origin: {
        groupId: 'proj-1',
        scope: { kind: 'project', path: project, provider: 'claude' },
        hashes: {},
        hash: '',
        copiedAt: '2026-09-26T00:00:00.000Z',
      },
    } as Partial<Group>);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/group-choice',
      payload: { path: project, groupKey: 'project:proj-1' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('group_pair_both_active');
  });

  it('переопределение: ВКЛ кладёт текст модели и запрет скилла, ВЫКЛ возвращает проект байт в байт', async () => {
    projectGroup();
    globalGroup();
    const before = snapshot(project);
    answer = () => block('group-override', '# Follow the global group\n\nUse global-ladder.');

    const on = await app.inject({
      method: 'PUT',
      url: '/api/groups/glob-1/override',
      payload: { path: project, enabled: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().deny).toEqual(['Skill(ladder)']);
    const rule = readFileSync(
      join(project, '.claude', 'rules', 'agentdeck-group.local.md'),
      'utf8',
    );
    expect(rule).toContain('Use global-ladder.');
    const local = JSON.parse(
      readFileSync(join(project, '.claude', 'settings.local.json'), 'utf8'),
    ) as { permissions: { deny: string[] } };
    expect(local.permissions.deny).toContain('Skill(ladder)');
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '/.claude/rules/agentdeck-group.local.md',
    );

    const off = await app.inject({
      method: 'PUT',
      url: '/api/groups/glob-1/override',
      payload: { path: project, enabled: false },
    });
    expect(off.json().enabled).toBe(false);
    expect(snapshot(project)).toEqual(before);
  });

  it('переопределение без ответа модели кладёт запасной текст', async () => {
    projectGroup();
    globalGroup();
    answer = () => {
      throw new Error('cli down');
    };
    const on = await app.inject({
      method: 'PUT',
      url: '/api/groups/glob-1/override',
      payload: { path: project, enabled: true },
    });
    expect(on.statusCode).toBe(200);
    const rule = readFileSync(
      join(project, '.claude', 'rules', 'agentdeck-group.local.md'),
      'utf8',
    );
    expect(rule).toContain('# Follow the global group "Ticket flow (global)" in this project');
  });

  it('переопределение у проектной группы отклоняется 409 group_not_global', async () => {
    projectGroup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/groups/proj-1/override',
      payload: { path: project, enabled: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'group_not_global',
      messageCode: 'group-not-global',
    });
  });

  it('копия в общие: занятое имя переименовано, советы приходят по id копии', async () => {
    projectGroup();
    skill(join(root, 'skills'), 'ladder', 'another global ladder');
    answer = (messages) => {
      const ids = [...messages[0]!.content.matchAll(/^### skill (\S+)$/gm)].map((m) => m[1]);
      return block('group-advice', {
        advice: ids.map((id) => ({ kind: 'skill', id, verdict: 'keep', reason: 'fine' })),
      });
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups/proj-1/copy-to-global',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      group: Group;
      advice: { id: string }[];
      warnings: { kind: string; to?: string }[];
    };
    const renamed = body.warnings.find((warning) => warning.kind === 'renamed');
    expect(renamed?.to).toBeTruthy();
    expect(renamed?.to).not.toBe('ladder');
    expect(body.group.scope ?? { kind: 'global' }).toEqual({ kind: 'global' });
    expect(readFileSync(join(root, 'skills', renamed!.to!, 'SKILL.md'), 'utf8')).toContain(
      '## 1. Read',
    );
    expect(body.advice.map((item) => item.id)).toEqual([renamed!.to]);
  });

  it('копия в неизвестный провайдер отклоняется 400', async () => {
    projectGroup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups/proj-1/copy-to-global',
      payload: { provider: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().messageCode).toBe('group-copy-target-unknown');
  });

  it('переопределение копией для другой CLI — отказ 409, проект не тронут (F-40)', async () => {
    projectGroup();
    globalGroup({
      scope: { kind: 'global', provider: 'qwen' },
      origin: {
        scope: { kind: 'project', path: project, provider: 'claude' },
        groupId: 'proj-1',
        hash: 'h',
        copiedAt: '2026-09-28T00:00:00.000Z',
      },
    });
    answer = () => block('group-override', { text: 'Use the qwen copy.' });
    const before = snapshot(project);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/groups/glob-1/override',
      payload: { path: project, enabled: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().messageCode).toBe('group-override-claude-only');
    expect(calls).toHaveLength(0);
    expect(snapshot(project)).toEqual(before);
  });

  it('первый заход на обнаружение сам запускает прогон, находку можно импортировать', async () => {
    skill(join(project, '.claude', 'skills'), 'review', '## 1. Look\n\n## 2. Say');
    store.addProject({ id: 'p1', name: 'proj', path: project });
    answer = (messages) =>
      messages[0]!.content.includes(`Source: ${project.replaceAll('\\', '/')}`)
        ? block('group-discover', {
            groups: [
              {
                name: 'Review loop',
                why: 'skills used together',
                members: [
                  { kind: 'skill', id: 'ladder' },
                  { kind: 'skill', id: 'review' },
                ],
              },
            ],
          })
        : block('group-discover', { groups: [] });

    await app.inject({ method: 'GET', url: '/api/groups/discovery' });
    let view = (await app.inject({ method: 'GET', url: '/api/groups/discovery' })).json();
    for (let i = 0; i < 100 && view.running; i += 1) {
      await new Promise((done) => setTimeout(done, 20));
      view = (await app.inject({ method: 'GET', url: '/api/groups/discovery' })).json();
    }
    const found = (view.groups as { key: string; name: string; status: string }[]).find(
      (group) => group.name === 'Review loop',
    );
    expect(found?.status).toBe('new');

    const imported = await app.inject({
      method: 'POST',
      url: `/api/groups/discovery/${encodeURIComponent(found!.key)}/import`,
    });
    expect(imported.statusCode).toBe(200);
    expect((imported.json() as Group).scope).toMatchObject({ kind: 'project' });
    expect((imported.json() as Group).members.map((member) => member.id).sort()).toEqual([
      'ladder',
      'review',
    ]);
    // Импорт не включает группу и не кладёт английское «почему» в описание.
    expect(imported.json()).toMatchObject({ isEnabled: false, description: '' });
    expect(store.getGroups().find((group) => group.name === 'Review loop')?.isEnabled).toBe(false);
  });

  it('импорт из русского интерфейса берёт русские имя и «Когда» находки', async () => {
    skill(join(project, '.claude', 'skills'), 'review', '## 1. Look\n\n## 2. Say');
    store.addProject({ id: 'p1', name: 'proj', path: project });
    answer = (messages) =>
      messages[0]!.content.includes(`Source: ${project.replaceAll('\\', '/')}`)
        ? block('group-discover', {
            groups: [
              {
                name: { ru: 'Цикл ревью', en: 'Review loop' },
                when: { ru: 'Когда нужно ревью', en: 'When a review is due' },
                why: { ru: 'скиллы идут вместе', en: 'skills used together' },
                members: [
                  { kind: 'skill', id: 'ladder' },
                  { kind: 'skill', id: 'review' },
                ],
              },
            ],
          })
        : block('group-discover', { groups: [] });

    await app.inject({ method: 'GET', url: '/api/groups/discovery' });
    let view = (await app.inject({ method: 'GET', url: '/api/groups/discovery' })).json();
    for (let i = 0; i < 100 && view.running; i += 1) {
      await new Promise((done) => setTimeout(done, 20));
      view = (await app.inject({ method: 'GET', url: '/api/groups/discovery' })).json();
    }
    const found = (view.groups as { key: string; name: string }[]).find(
      (group) => group.name === 'Review loop',
    );
    expect(found).toMatchObject({
      localized: { name: { ru: 'Цикл ревью', en: 'Review loop' } },
    });

    const imported = await app.inject({
      method: 'POST',
      url: `/api/groups/discovery/${encodeURIComponent(found!.key)}/import`,
      payload: { lang: 'ru' },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ name: 'Цикл ревью', when: 'Когда нужно ревью' });

    const wrong = await app.inject({
      method: 'POST',
      url: `/api/groups/discovery/${encodeURIComponent(found!.key)}/import`,
      payload: { lang: 'de' },
    });
    expect(wrong.statusCode).toBe(400);
  });

  /** Копия в общие с советом «улучшить» по участнику копии. */
  const copyWithImprove = async (text: string): Promise<Group> => {
    projectGroup();
    answer = (messages) => {
      const id = /^### skill (\S+)$/m.exec(messages[0]!.content)?.[1];
      return block('group-advice', {
        advice: [{ kind: 'skill', id, verdict: 'improve', reason: 'tighter', replacement: text }],
      });
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups/proj-1/copy-to-global',
      payload: {},
    });
    return res.json().group as Group;
  };

  it('применённый совет «улучшить» правит только копию, повтор — 409 advice_empty', async () => {
    const projectSkill = join(project, '.claude', 'skills', 'ladder', 'SKILL.md');
    const projectBefore = readFileSync(projectSkill, 'utf8');
    const copy = await copyWithImprove('---\nname: ladder\ndescription: d\n---\n\nIMPROVED\n');

    const apply = await app.inject({
      method: 'POST',
      url: `/api/groups/${copy.id}/advice/apply`,
      payload: { items: [{ kind: 'skill', id: 'ladder' }] },
    });
    expect(apply.statusCode).toBe(200);
    expect(readFileSync(join(root, 'skills', 'ladder', 'SKILL.md'), 'utf8')).toContain('IMPROVED');
    expect(readFileSync(projectSkill, 'utf8')).toBe(projectBefore);

    const again = await app.inject({
      method: 'POST',
      url: `/api/groups/${copy.id}/advice/apply`,
      payload: { items: [{ kind: 'skill', id: 'ladder' }] },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('advice_empty');
  });

  it('слияние с оригиналом: после применения оригинал больше не числится изменившимся', async () => {
    const copy = await copyWithImprove('unused');
    writeFileSync(
      join(project, '.claude', 'skills', 'ladder', 'SKILL.md'),
      '---\nname: ladder\ndescription: d\n---\n\n## 1. Read\n\n## 2. Write\n\n## 3. Test\n',
      'utf8',
    );
    answer = () =>
      block('group-merge', {
        advice: [
          {
            kind: 'skill',
            id: 'ladder',
            verdict: 'improve',
            reason: 'merged',
            replacement: 'MERGED',
          },
        ],
      });
    const merge = await app.inject({ method: 'POST', url: `/api/groups/${copy.id}/merge-origin` });
    expect(merge.statusCode).toBe(200);
    expect(merge.json().advice).toHaveLength(1);

    await app.inject({
      method: 'POST',
      url: `/api/groups/${copy.id}/advice/apply`,
      payload: { items: [{ kind: 'skill', id: 'ladder' }] },
    });
    expect(readFileSync(join(root, 'skills', 'ladder', 'SKILL.md'), 'utf8')).toContain('MERGED');

    const asked = calls.length;
    const second = await app.inject({ method: 'POST', url: `/api/groups/${copy.id}/merge-origin` });
    expect(second.json().advice).toEqual([]);
    expect(calls.length).toBe(asked);
  });
});
