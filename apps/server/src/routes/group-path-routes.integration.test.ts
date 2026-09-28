import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Automation, Group } from '@agentdeck/contracts';
import { blockLang } from '@agentdeck/contracts/brand';
import type { PathStep } from '@agentdeck/contracts/group-path';
import { AppStore } from '../lib/app-store.ts';
import { hookContentId } from '../lib/hook-id.ts';
import type { ServerContext } from '../context.ts';
import type { GroupAsk, GroupModelMessage, GroupModelTier } from '../domains/groups/model.ts';
import { registerGroupPathRoutes } from './group-path-routes.ts';

/**
 * «Путь» группы со стороны маршрутов: временный каталог конфигурации и
 * подменённая модель — всё остальное (писатели скиллов, кэш сводок, перенос
 * сценария при старте) идёт по-настоящему.
 */

const block = (kind: string, body: unknown): string =>
  `\n\`\`\`${blockLang(kind)}\n${JSON.stringify(body)}\n\`\`\`\n`;

const step = (patch: Partial<PathStep> & { id: string }): PathStep => ({
  anchor: 'work',
  order: 0,
  kind: 'prompt',
  title: { ru: patch.id, en: patch.id },
  prompt: { ru: `сделать ${patch.id}`, en: `do ${patch.id}` },
  source: 'ru',
  createdAt: '2026-09-26T00:00:00.000Z',
  ...patch,
});

describe('маршруты «Пути» группы', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let calls: { messages: GroupModelMessage[]; tier: GroupModelTier }[];
  let answer: () => string;

  const skillsDir = (): string => join(root, 'skills');
  const writeSkill = (id: string, body: string): void => {
    mkdirSync(join(skillsDir(), id), { recursive: true });
    writeFileSync(
      join(skillsDir(), id, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${id} skill\n---\n\n${body}\n`,
      'utf8',
    );
  };

  const saveGroup = (patch: Partial<Group> = {}): Group =>
    store.saveGroup({
      id: 'g1',
      name: 'Delivery',
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

  const boot = async (): Promise<void> => {
    const ctx = {
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: skillsDir(),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          appData: join(root, 'agentdeck'),
        },
      },
      store,
      backupDir: join(root, 'agentdeck', 'backups'),
    } as unknown as ServerContext;
    const ask: GroupAsk = async (messages, tier) => {
      calls.push({ messages, tier });
      return answer();
    };
    app = Fastify();
    registerGroupPathRoutes(app, ctx, () => ask);
    await app.ready();
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-path-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(skillsDir(), { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    store = new AppStore(join(root, 'agentdeck'));
    calls = [];
    answer = () => 'no block';
  });

  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  // Решение владельца 27.09 (F-99): редактора автоматизаций больше нет, а сервер
  // продолжал собирать их в settings.json — хуки, которых не видно как свои.
  // При старте они разово становятся обычными хуками-участниками и шагами «Хук».
  it('старт переносит автоматизации в хуки-участники и шаги «Хук» один раз', async () => {
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: 'echo lint # agentdeck:automation:a1', timeout: 30 },
              ],
            },
          ],
          Stop: [{ hooks: [{ type: 'command', command: 'echo manual' }] }],
        },
      }),
      'utf8',
    );
    const automation = (patch: Partial<Automation> & { id: string }): Automation => ({
      name: patch.id,
      description: '',
      trigger: { event: 'PostToolUse', matcher: 'Bash' },
      action: { command: `echo ${patch.id}` },
      isEnabled: true,
      groupIds: ['g1'],
      ...patch,
    });
    store.saveAutomation(
      automation({
        id: 'a1',
        name: 'Линт',
        description: 'Прогнать линтер',
        action: { command: 'echo lint', timeout: 30 },
      }),
    );
    store.saveAutomation(automation({ id: 'a2', isEnabled: false, trigger: { event: 'Stop' } }));
    saveGroup({ path: { steps: [step({ id: 's1' })] } });
    saveGroup({
      id: 'g2',
      scope: { kind: 'project', path: root, provider: 'claude' },
      path: { steps: [] },
    });
    store.saveAutomation({ ...store.getAutomations()[1]!, groupIds: ['g1', 'g2'] });
    await boot();

    const lint = hookContentId('PostToolUse', 'Bash', 'echo lint');
    const off = hookContentId('Stop', undefined, 'echo a2');
    const file = readFileSync(join(root, 'settings.json'), 'utf8');
    expect(file).not.toContain('agentdeck:automation');
    expect(file).toContain('"echo lint"');
    expect(JSON.parse(file).hooks.PostToolUse[0].hooks[0]).toEqual({
      type: 'command',
      command: 'echo lint',
      timeout: 30,
    });
    expect(file).toContain('echo manual');
    // Выключенная автоматизация — выключенный хук: в файле его нет, снимок у панели.
    expect(file).not.toContain('echo a2');
    expect(store.isDisabled('hook', off)).toBe(true);
    expect(store.getDisabledHooks().map((hook) => hook.command)).toContain('echo a2');
    expect(store.getAutomations()).toEqual([]);

    const g1 = store.getGroups().find((group) => group.id === 'g1')!;
    expect(g1.members).toEqual([
      { kind: 'hook', id: lint },
      { kind: 'hook', id: off },
    ]);
    const steps = g1.path!.steps;
    expect(steps.map((item) => item.id)).toEqual(['s1', 'automation-a1', 'automation-a2']);
    expect(steps[1]).toMatchObject({
      kind: 'resource',
      anchor: 'work',
      order: 1,
      resource: { type: 'hook', id: lint },
      title: { ru: 'Линт', en: 'Линт' },
      prompt: { ru: 'Прогнать линтер', en: 'Прогнать линтер' },
      needsTranslation: true,
    });
    // Хук глобальный, группа проектная: участник помечен общей областью, иначе
    // искался бы в .claude проекта.
    const g2 = store.getGroups().find((group) => group.id === 'g2')!;
    expect(g2.members).toEqual([{ kind: 'hook', id: off, scope: { kind: 'global' } }]);

    // Повторный старт ничего не пишет.
    await app.close();
    await boot();
    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe(file);
    expect(store.getGroups().find((group) => group.id === 'g1')!.path!.steps).toHaveLength(3);
  });

  it('путь: шаги скилла-участника и свой шаг встают после стадии работы', async () => {
    writeSkill('ladder', '## 1. Read the ticket\n\n## 2. Open a branch');
    saveGroup({
      members: [{ kind: 'skill', id: 'ladder' }],
      path: { steps: [step({ id: 's1' })] },
    });
    await boot();
    const res = await app.inject({ method: 'GET', url: '/api/groups/g1/path' });
    expect(res.statusCode).toBe(200);
    const entries = res.json().entries as { kind: string; stage?: string; title?: string }[];
    const work = entries.findIndex((entry) => entry.kind === 'builtin' && entry.stage === 'work');
    expect(entries.slice(work + 1, work + 4).map((entry) => entry.kind)).toEqual([
      'skill-step',
      'skill-step',
      'custom',
    ]);
    expect(entries[work + 1]!.title).toBe('Read the ticket');
  });

  it('скилл, чей текст есть, но не читается, назван в unreadable, а не пропадает молча; пропавший — нет', async () => {
    writeSkill('ladder', '## 1. Read the ticket\n\n## 2. Open a branch');
    // SKILL.md — каталог: чтение падает на настоящей файловой системе (EISDIR).
    mkdirSync(join(skillsDir(), 'locked', 'SKILL.md'), { recursive: true });
    saveGroup({
      members: [
        { kind: 'skill', id: 'ladder' },
        { kind: 'skill', id: 'locked' },
        { kind: 'skill', id: 'gone' },
      ],
    });
    await boot();
    const view = (await app.inject({ method: 'GET', url: '/api/groups/g1/path' })).json();
    expect(view.unreadable).toEqual(['locked']);
    const skills = (view.entries as { kind: string; skillId?: string }[]).filter(
      (entry) => entry.kind === 'skill-step',
    );
    expect(skills.map((entry) => entry.skillId)).toEqual(['ladder', 'ladder']);
  });

  it('скилл-участник, поставленный шагом-ссылкой, идёт там, где шаг, а не вторым блоком', async () => {
    writeSkill('ladder', '## 1. Read the ticket\n\n## 2. Open a branch');
    saveGroup({
      members: [{ kind: 'skill', id: 'ladder' }],
      path: {
        steps: [
          step({
            id: 'use',
            anchor: 'review',
            kind: 'resource',
            resource: { type: 'skill', id: 'ladder' },
          }),
        ],
      },
    });
    await boot();
    const entries = (await app.inject({ method: 'GET', url: '/api/groups/g1/path' })).json()
      .entries as { kind: string; stage?: string; step?: { id: string } }[];
    expect(entries.filter((entry) => entry.kind === 'skill-step')).toEqual([]);
    const review = entries.findIndex(
      (entry) => entry.kind === 'builtin' && entry.stage === 'review',
    );
    expect(entries[review + 1]).toMatchObject({ kind: 'custom', step: { id: 'use' } });
  });

  it('правка шагов нумерует порядок внутри стадии заново', async () => {
    saveGroup();
    await boot();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/groups/g1/path/steps',
      payload: { steps: [step({ id: 'a', order: 7 }), step({ id: 'b', order: 3 })] },
    });
    expect(res.statusCode).toBe(200);
    const saved = store.getGroups().find((group) => group.id === 'g1')!;
    expect(saved.path!.steps.map((item) => [item.id, item.order])).toEqual([
      ['a', 1],
      ['b', 0],
    ]);
  });

  it('два шага с одним id отклоняются 400 group-path-steps-invalid', async () => {
    saveGroup();
    await boot();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/groups/g1/path/steps',
      payload: { steps: [step({ id: 'a' }), step({ id: 'a', order: 1 })] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().messageCode).toBe('group-path-steps-invalid');
  });

  it('«сделать глобальным»: скилл записан, вошёл в группу, шаг стал ссылкой', async () => {
    saveGroup({ path: { steps: [step({ id: 's1' })] } });
    await boot();
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups/g1/path/promote',
      payload: {
        stepId: 's1',
        type: 'skill',
        draft: '---\nname: check-links\ndescription: checks links\n---\n\nCheck every link.',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(readFileSync(join(skillsDir(), 'check-links', 'SKILL.md'), 'utf8')).toContain(
      'Check every link.',
    );
    const saved = store.getGroups().find((group) => group.id === 'g1')!;
    expect(saved.members).toContainEqual({ kind: 'skill', id: 'check-links' });
    expect(saved.path!.steps[0]).toMatchObject({
      kind: 'resource',
      resource: { type: 'skill', id: 'check-links' },
    });
  });

  it('проектная группа пишет ресурсы шага в .claude своего проекта, общие не трогает', async () => {
    const project = join(root, 'proj');
    const scope = { kind: 'project' as const, path: project, provider: 'claude' };
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ env: { KEEP: '1' } }),
      'utf8',
    );
    // Общий тёзка будущего скилла: выключенная проектная группа не должна его погасить.
    writeSkill('check-links', 'global one');
    saveGroup({
      scope,
      isEnabled: false,
      path: { steps: [step({ id: 's1' }), step({ id: 's2' }), step({ id: 's3' })] },
    });
    await boot();
    const promote = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/groups/g1/path/promote', payload });

    const skill = await promote({
      stepId: 's1',
      type: 'skill',
      draft: '---\nname: check-links\ndescription: checks links\n---\n\nCheck every link.',
    });
    const hook = await promote({
      stepId: 's2',
      type: 'hook',
      draft: JSON.stringify({ event: 'PostToolUse', matcher: 'Edit', command: 'pnpm lint' }),
    });
    const rule = await promote({ stepId: 's3', type: 'rule', draft: 'Links stay relative.' });
    expect([skill.statusCode, hook.statusCode, rule.statusCode]).toEqual([200, 200, 200]);

    expect(
      readFileSync(join(project, '.claude', 'skills', 'check-links', 'SKILL.md'), 'utf8'),
    ).toContain('Check every link.');
    expect(readFileSync(join(skillsDir(), 'check-links', 'SKILL.md'), 'utf8')).toContain(
      'global one',
    );
    const projectSettings = JSON.parse(
      readFileSync(join(project, '.claude', 'settings.json'), 'utf8'),
    ) as { env: object; hooks: Record<string, unknown[]> };
    expect(projectSettings.env).toEqual({ KEEP: '1' });
    expect(projectSettings.hooks.PostToolUse).toHaveLength(1);
    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe('{}');
    expect(readFileSync(join(project, '.claude', 'rules', 's3.md'), 'utf8')).toBe(
      '# s3\n\nLinks stay relative.\n',
    );
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);

    const saved = store.getGroups().find((group) => group.id === 'g1')!;
    expect(saved.members).toContainEqual({ kind: 'skill', id: 'check-links', scope });
    expect(saved.members.every((member) => member.scope?.kind === 'project')).toBe(true);
    expect(store.isDisabled('skill', 'check-links')).toBe(false);
  });

  it('ассистент шага продолжает тот же разговор по conversationId', async () => {
    saveGroup();
    await boot();
    answer = () =>
      block('path-step', {
        questions: ['Which branch?'],
        title: { ru: 'Проверка', en: 'Check' },
        prompt: { ru: 'проверить', en: 'check' },
      });
    const first = await app.inject({
      method: 'POST',
      url: '/api/groups/g1/path/draft',
      payload: { text: 'проверить ссылки', anchor: 'work' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().proposal.questions).toEqual(['Which branch?']);
    const second = await app.inject({
      method: 'POST',
      url: '/api/groups/g1/path/draft',
      payload: { text: 'main', anchor: 'work', conversationId: first.json().conversationId },
    });
    expect(second.json().conversationId).toBe(first.json().conversationId);
    expect(calls[1]!.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(calls[1]!.messages[2]!.content).toBe('main');
  });

  it('перевод берёт шаг из окна и не продолжает разговор автора', async () => {
    saveGroup({ path: { steps: [step({ id: 's1' })] } } as Partial<Group>);
    await boot();
    answer = () =>
      block('path-step', {
        questions: [],
        title: { ru: 'Проверка', en: 'Check' },
        prompt: { ru: 'проверить', en: 'check' },
      });
    const first = await app.inject({
      method: 'POST',
      url: '/api/groups/g1/path/draft',
      payload: { text: 'проверить', anchor: 'work', stepId: 's1' },
    });
    const conversationId = first.json().conversationId;
    const current = {
      title: { ru: 'Новое имя', en: 'Old name' },
      prompt: { ru: 'новый текст', en: 'old text' },
      gate: { ru: 'новое условие', en: 'old gate' },
    };
    const translated = await app.inject({
      method: 'POST',
      url: '/api/groups/g1/path/draft',
      payload: {
        mode: 'translate',
        text: 'новый текст',
        lang: 'ru',
        anchor: 'work',
        stepId: 's1',
        conversationId,
        current,
      },
    });
    expect(translated.statusCode).toBe(200);
    expect(translated.json().conversationId).toBe(conversationId);
    // Свежий запрос с промптом и шагом из окна, а не «продолжение» с одним текстом.
    const sent = calls[1]!.messages;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toContain('Mode: translate');
    expect(sent[0]!.content).toContain(`Step now: ${JSON.stringify(current)}`);
    expect(sent[0]!.content).not.toContain('do s1');
    expect(calls[1]!.tier).toBe('cheap');
    // Следующий круг автора продолжает разговор без перевода внутри.
    await app.inject({
      method: 'POST',
      url: '/api/groups/g1/path/draft',
      payload: { text: 'ещё', anchor: 'work', stepId: 's1', conversationId },
    });
    expect(calls[2]!.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('сценарию ассистент не называет стадий', async () => {
    saveGroup({ flow: 'scenario', path: { steps: [step({ id: 'a' })] } } as Partial<Group>);
    await boot();
    answer = () =>
      block('path-step', { title: { ru: 'x', en: 'x' }, prompt: { ru: 'x', en: 'x' } });
    await app.inject({
      method: 'POST',
      url: '/api/groups/g1/path/draft',
      payload: { text: 'шаг', anchor: 'work' },
    });
    const sent = calls[0]!.messages[0]!.content;
    expect(sent).toContain('Flow: scenario');
    expect(sent).toContain('Scenario steps so far, in order:\n- a');
    expect(sent).not.toContain('After stage:');
  });

  it('сводка ресурса: повтор из кэша, правка файла — новый вызов дешёвой ступенью', async () => {
    writeSkill('ladder', 'v1');
    await boot();
    answer = () => block('resource-summary', { ru: 'делает X', en: 'does X' });
    const url = '/api/resources/summary?type=skill&id=ladder';
    const first = await app.inject({ method: 'GET', url });
    expect(first.json()).toMatchObject({ ru: 'делает X', en: 'does X' });
    await app.inject({ method: 'GET', url });
    expect(calls.length).toBe(1);
    expect(calls[0]!.tier).toBe('cheap');

    writeSkill('ladder', 'v2');
    await app.inject({ method: 'GET', url });
    expect(calls.length).toBe(2);
  });

  it('сводка неизвестного вида отклоняется 400', async () => {
    await boot();
    const res = await app.inject({ method: 'GET', url: '/api/resources/summary?type=mcp&id=x' });
    expect(res.statusCode).toBe(400);
    expect(calls.length).toBe(0);
  });

  it('при старте шаги старого сценария переезжают в путь', async () => {
    saveGroup({
      scenario: {
        when: '',
        trigger: '',
        steps: [{ title: 'Забрать тикет', body: 'assign', gate: '' }],
      },
    } as Partial<Group>);
    await boot();
    const saved = store.getGroups().find((group) => group.id === 'g1')!;
    expect(saved.path?.steps.map((item) => item.title.ru)).toEqual(['Забрать тикет']);
    expect(existsSync(join(skillsDir(), 'g1'))).toBe(false);
  });
});
