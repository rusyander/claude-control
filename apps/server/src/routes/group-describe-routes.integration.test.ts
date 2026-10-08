import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import { blockLang } from '@agentdeck/contracts/brand';
import type {
  DescribedPathStepProposal,
  GroupMembersView,
  ResourceCatalogView,
} from '@agentdeck/contracts/group-describe';
import { PATH_STEP_BLOCK_KIND, type GroupPathView } from '@agentdeck/contracts/group-path';
import { AppStore } from '../lib/app-store/app-store.ts';
import type { ServerContext } from '../context.ts';
import {
  DESCRIBE_BLOCK_KIND,
  DESCRIBE_VERSION,
  describeIdle,
} from '../domains/groups/describe/describe.ts';
import { resourceSource } from '../domains/groups/describe-sources.ts';
import { readHooks } from '../domains/hooks/hooks.ts';
import type { GroupAsk, GroupModelMessage, GroupModelTier } from '../domains/groups/model.ts';
import { registerGroupPathRoutes } from './group-path-routes/group-path-routes.ts';

/**
 * Описания на двух языках со стороны маршрутов: временный каталог конфигурации
 * и подменённая модель — чтение ресурсов, сбор текста (у хука — со скриптом),
 * маска секретов, очередь, кэш `describe.json` по хэшу и запись скрипта идут
 * по-настоящему. Модель отвечает по виду и id из первой строки данных.
 */

const describeBlock = (body: unknown): string =>
  `\n\`\`\`${blockLang(DESCRIBE_BLOCK_KIND)}\n${JSON.stringify(body)}\n\`\`\`\n`;

const line = (text: string) => ({ ru: `ру: ${text}`, en: `en: ${text}` });

/** Ответ «модели» на описание: имя и строка по id, шаги — по числу `## N.` в тексте. */
function describeAnswer(messages: GroupModelMessage[]): string {
  const content = messages[0]!.content;
  const head = /\n(skill|hook|rule|mcp|permission|group|script) (\S+):\n/.exec(content);
  if (!head) return 'no block';
  const steps = [...content.matchAll(/^## \d+\. (.+)$/gm)].map((match) => ({
    title: line(`step ${match[1]}`),
    summary: line(`does ${match[1]}`),
  }));
  return describeBlock({
    title: line(`${head[1]} ${head[2]}`),
    summary: line(`what ${head[2]} does`),
    ...(steps.length > 0 ? { steps } : {}),
  });
}

const TOKEN = `ghp_${'a1B2c3D4e5F6g7H8i9J0'.repeat(2)}`;

describe('маршруты описаний: участники, каталог, ассистент шага, скрипт', () => {
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let store: AppStore;
  let calls: { messages: GroupModelMessage[]; tier: GroupModelTier }[];
  let ask: GroupAsk;

  const hooksDir = (): string => join(root, 'hooks');
  const writeSkill = (dir: string, id: string, body: string): void => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(
      join(dir, id, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${id} skill\n---\n\n${body}\n`,
      'utf8',
    );
  };
  const writeScript = (name: string, text: string): string => {
    mkdirSync(hooksDir(), { recursive: true });
    const file = join(hooksDir(), name);
    writeFileSync(file, text, 'utf8');
    return file;
  };
  const writeHook = (command: string): void =>
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command }] }] },
      }),
      'utf8',
    );

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
          skills: join(root, 'skills'),
          hooks: hooksDir(),
          mcpConfig: join(root, '.claude.json'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          appData: join(root, 'agentdeck'),
        },
      },
      store,
      backupDir: join(root, 'agentdeck', 'backups'),
    } as unknown as ServerContext;
    app = Fastify();
    registerGroupPathRoutes(app, ctx, () => ask);
    await app.ready();
  };

  const members = async (): Promise<GroupMembersView> =>
    (await app.inject({ method: 'GET', url: '/api/groups/g1/members' })).json();

  /** id хука, как его читает панель: `Event:hash` из settings.json. */
  const hookId = (): string => readHooks(join(root, 'settings.json'), store)[0]!.id;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-describe-'));
    project = join(root, 'project');
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    store = new AppStore(join(root, 'agentdeck'));
    calls = [];
    ask = async (messages, tier) => {
      calls.push({ messages, tier });
      return describeAnswer(messages);
    };
  });

  afterEach(async () => {
    await describeIdle();
    await app?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('участники: сразу — строка из файла и pending, после очереди — имя, строка и шаги скилла на двух языках', async () => {
    writeSkill(join(root, 'skills'), 'ship', '## 1. Branch\nCut it.\n\n## 2. Review\nTwo agents.');
    const script = writeScript('docs-check.mjs', '// Checks that docs follow the code\n');
    writeHook(`node "${script}"`);
    saveGroup({
      members: [
        { kind: 'skill', id: 'ship' },
        { kind: 'hook', id: hookId() },
        { kind: 'permission', id: 'Bash(git status:*)' },
      ],
    });
    await boot();
    const first = await members();
    // Строка из файла — сразу, без модели; имени и сводки ещё нет.
    expect(first.members[0]).toEqual({ kind: 'skill', id: 'ship', description: 'ship skill' });
    expect(first.pending).toEqual([
      'skill:ship',
      'step:ship',
      `hook:${hookId()}`,
      'permission:Bash(git status:*)',
    ]);
    await describeIdle();
    const view = await members();
    expect(view.pending).toBeUndefined();
    expect(view.members[0]).toMatchObject({
      id: 'ship',
      description: 'ship skill',
      title: { ru: 'ру: skill ship', en: 'en: skill ship' },
      summary: { en: 'en: what ship does' },
    });
    expect(view.steps).toEqual([
      { skillId: 'ship', index: 0, title: line('step Branch'), summary: line('does Branch') },
      { skillId: 'ship', index: 1, title: line('step Review'), summary: line('does Review') },
    ]);
    expect(view.members[1]!.title?.en).toMatch(/^en: hook /);
    expect(calls.every((call) => call.tier === 'cheap')).toBe(true);
    expect(calls).toHaveLength(3);
    // Повторный показ — из кэша, модель не зовётся.
    await members();
    await describeIdle();
    expect(calls).toHaveLength(3);
  });

  it('длинный скилл: модели уходит КАЖДЫЙ шаг, хвост за лимитом текста не теряется', async () => {
    // Форма скилла доставки тикета: длинное вступление и 14 шагов, текст длиннее лимита
    // описания — прежняя обрезка по символам отрезала шаги 13–14 целиком.
    const filler = (word: string): string => `${word}: ${'lorem ipsum '.repeat(200)}`;
    const body = [
      `# Ticket\n\n${filler('intro')}`,
      ...Array.from({ length: 14 }, (_, i) => `## ${i + 1}. Step${i + 1}\n${filler(`s${i + 1}`)}`),
    ].join('\n\n');
    writeSkill(join(root, 'skills'), 'long', body);
    saveGroup({ members: [{ kind: 'skill', id: 'long' }] });
    await boot();
    await members();
    await describeIdle();
    const view = await members();
    expect(view.steps?.map((step) => step.title.en)).toEqual(
      Array.from({ length: 14 }, (_, i) => `en: step Step${i + 1}`),
    );
    const sent = calls[0]!.messages[0]!.content;
    expect(sent.length).toBeLessThan(26_000);
    expect(sent).toContain('## 14. Step14');
  });

  it('первый показ скилла с шагами называет и участника, и его шаги', async () => {
    writeSkill(join(root, 'skills'), 'ship', '## 1. Branch\nCut it.\n\n## 2. Review\nTwo agents.');
    saveGroup({ members: [{ kind: 'skill', id: 'ship' }] });
    await boot();
    expect((await members()).pending).toEqual(['skill:ship', 'step:ship']);
  });

  it('хук: модели уходят событие, фильтр, команда и текст скрипта с маской секрета; правка скрипта — новое описание', async () => {
    const script = writeScript(
      'notify.mjs',
      `const token = '${TOKEN}';\nfetch('https://chat.example.com');\n`,
    );
    writeHook(`node "${script}"`);
    const id = hookId();
    saveGroup({ members: [{ kind: 'hook', id }] });
    await boot();
    expect((await members()).pending).toEqual([`hook:${id}`]);
    await describeIdle();
    const sent = calls[0]!.messages[0]!.content;
    expect(sent).toContain('event: PreToolUse');
    expect(sent).toContain('matcher: Edit');
    expect(sent).toContain("fetch('https://chat.example.com')");
    expect(sent).not.toContain(TOKEN);
    expect((await members()).pending).toBeUndefined();

    writeScript('notify.mjs', "fetch('https://other.example.com');\n");
    expect((await members()).pending).toEqual([`hook:${id}`]);
    await describeIdle();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages[0]!.content).toContain('other.example.com');
    // Команда не менялась — id хука тот же: новое описание дала правка скрипта.
    expect(hookId()).toBe(id);
  });

  it('неудача: без описания и без pending, повтор не на каждом показе', async () => {
    writeSkill(join(root, 'skills'), 'ship', 'Ship it.');
    saveGroup({ members: [{ kind: 'skill', id: 'ship' }] });
    ask = async (messages, tier) => {
      calls.push({ messages, tier });
      return 'no block at all';
    };
    await boot();
    expect((await members()).pending).toEqual(['skill:ship']);
    await describeIdle();
    const view = await members();
    expect(view.pending).toBeUndefined();
    expect(view.members[0]).not.toHaveProperty('title');
    await describeIdle();
    expect(calls).toHaveLength(1);
  });

  // Как у живой группы доставки: в тексте 14 шагов, в кэше описаны 12 — модель
  // потеряла хвост, а хэш текста тот же, и запись считалась готовой навсегда.
  const FOURTEEN = Array.from({ length: 14 }, (_, i) => `## ${i + 1}. Stage ${i + 1}\nDo it.`).join(
    '\n\n',
  );

  const seedTwelve = (): void => {
    const source = resourceSource(
      { paths: { skills: join(root, 'skills') } as never, store },
      { kind: 'global' },
      { kind: 'skill', id: 'ship' },
    )!;
    expect(source.steps).toHaveLength(14);
    writeFileSync(
      join(root, 'agentdeck', 'describe.json'),
      JSON.stringify({
        [source.key]: {
          hash: source.hash,
          v: DESCRIBE_VERSION,
          title: line('old ship'),
          summary: line('old summary'),
          steps: Array.from({ length: 12 }, (_, i) => ({
            title: line(`old ${i + 1}`),
            summary: line(`old does ${i + 1}`),
          })),
        },
      }),
      'utf8',
    );
  };

  it('описаны не все шаги скилла: описание идёт заново, прежние шаги видны, недостающие — «готовятся»', async () => {
    writeSkill(join(root, 'skills'), 'ship', FOURTEEN);
    saveGroup({ members: [{ kind: 'skill', id: 'ship' }] });
    seedTwelve();
    await boot();
    const first = await members();
    expect(first.members[0]).toMatchObject({ title: line('old ship') });
    expect(first.steps).toHaveLength(12);
    expect(first.pending).toEqual(['step:ship']);
    await describeIdle();
    // Модели названы все шаги поимённо и их число.
    const sent = calls[0]!.messages[0]!.content;
    expect(sent).toContain('Numbered steps of this skill (14). Give exactly 14 entries');
    expect(sent).toContain('\n14. Stage 14');
    const view = await members();
    expect(view.pending).toBeUndefined();
    expect(view.steps.map((step) => step.title.en)).toEqual(
      Array.from({ length: 14 }, (_, i) => `en: step Stage ${i + 1}`),
    );
    await members();
    await describeIdle();
    expect(calls).toHaveLength(1);
  });

  it('модель снова назвала меньше шагов: прежнее не затёрто, повтор не на каждом показе', async () => {
    writeSkill(join(root, 'skills'), 'ship', FOURTEEN);
    saveGroup({ members: [{ kind: 'skill', id: 'ship' }] });
    seedTwelve();
    ask = async (messages, tier) => {
      calls.push({ messages, tier });
      return describeBlock({
        title: line('new ship'),
        summary: line('new summary'),
        steps: Array.from({ length: 10 }, (_, i) => ({
          title: line(`new ${i + 1}`),
          summary: line(`new does ${i + 1}`),
        })),
      });
    };
    await boot();
    await members();
    await describeIdle();
    const view = await members();
    // Окно повтора: без pending (страница не опрашивает вечно), двенадцать прежних шагов на месте.
    expect(view.pending).toBeUndefined();
    expect(view.steps).toHaveLength(12);
    expect(view.steps[0]!.title).toEqual(line('old 1'));
    await describeIdle();
    expect(calls).toHaveLength(1);
  });

  it('очередь: не больше двух вызовов модели одновременно', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e'])
      writeSkill(join(root, 'skills'), id, `Skill ${id}.`);
    saveGroup({ members: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ kind: 'skill' as const, id })) });
    let running = 0;
    let peak = 0;
    ask = async (messages, tier) => {
      calls.push({ messages, tier });
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((done) => setTimeout(done, 15));
      running -= 1;
      return describeAnswer(messages);
    };
    await boot();
    expect((await members()).pending).toHaveLength(5);
    await describeIdle();
    expect(calls).toHaveLength(5);
    expect(peak).toBe(2);
  });

  it('каталог «Выбрать готовый»: общие скиллы, правила, хуки, скрипты и ресурсы проекта', async () => {
    writeSkill(join(root, 'skills'), 'ship', 'Ship it.');
    writeFileSync(join(root, 'CLAUDE.md'), '## ПРАВИЛО: Answer short\n\nOutcome first.\n', 'utf8');
    const script = writeScript('docs-check.mjs', '// Checks that docs follow the code\n');
    writeScript('docs-check.test.mjs', '// test file\n');
    writeHook(`node "${script}"`);
    writeSkill(join(project, '.claude', 'skills'), 'local-ship', 'Ship locally.');
    await boot();
    const url = `/api/groups/resource-catalog?path=${encodeURIComponent(project)}`;
    const first = (await app.inject({ method: 'GET', url })).json<ResourceCatalogView>();
    const kinds = first.items.map((item) => `${item.scope}:${item.type}:${item.id}`);
    expect(kinds).toEqual([
      'global:skill:ship',
      expect.stringMatching(/^global:rule:/),
      expect.stringMatching(/^global:hook:/),
      'global:script:docs-check.mjs',
      'project:skill:local-ship',
    ]);
    expect(first.items.find((item) => item.type === 'script')?.description).toContain('Checks');
    expect(first.pending).toHaveLength(5);
    await describeIdle();
    const view = (await app.inject({ method: 'GET', url })).json<ResourceCatalogView>();
    expect(view.pending).toBeUndefined();
    expect(view.items.every((item) => item.title && item.summary)).toBe(true);
    expect(view.items.find((item) => item.id === 'local-ship')?.title?.en).toBe(
      'en: skill local-ship',
    );
  });

  it('ассистент шага: у совпадения — сводка из кэша описаний, у похожего — слова модели; скрипты в описи', async () => {
    writeSkill(join(root, 'skills'), 'ship', 'Ship it.');
    writeScript('docs-check.mjs', '// Checks that docs follow the code\n');
    saveGroup();
    await boot();
    // Каталог описывает скрипт — сводка совпадения берётся из того же кэша.
    await app.inject({ method: 'GET', url: '/api/groups/resource-catalog' });
    await describeIdle();
    const described = calls.length;
    ask = async (messages, tier) => {
      calls.push({ messages, tier });
      return `\n\`\`\`${blockLang(PATH_STEP_BLOCK_KIND)}\n${JSON.stringify({
        match: { type: 'script', id: 'docs-check.mjs', why: 'проверяет доки' },
        similar: [
          { type: 'skill', id: 'ghost', why: 'похож', summary: { ru: 'похожий', en: 'similar' } },
          { type: 'rule', id: 'nope', why: 'рядом' },
        ],
        title: { ru: 'Доки', en: 'Docs' },
        prompt: { ru: 'Проверь доки', en: 'Check docs' },
      })}\n\`\`\`\n`;
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups/g1/path/draft',
      payload: { text: 'проверить доки', anchor: 'review' },
    });
    expect(res.statusCode).toBe(200);
    const proposal = res.json<{ proposal: DescribedPathStepProposal }>().proposal;
    expect(proposal.match).toMatchObject({
      type: 'script',
      id: 'docs-check.mjs',
      summary: { ru: 'ру: what docs-check.mjs does', en: 'en: what docs-check.mjs does' },
    });
    expect(proposal.similar[0]!.summary).toEqual({ ru: 'похожий', en: 'similar' });
    expect(proposal.similar[1]!.summary).toEqual({ ru: 'рядом', en: 'рядом' });
    const sent = calls[described]!.messages[0]!.content;
    expect(sent).toContain(
      'Existing scripts:\n- script docs-check.mjs: Checks that docs follow the code',
    );
  });

  it('«сделать глобальным» скриптом: файл писателем скриптов, шаг — ссылка, участники те же; занятое имя — 409', async () => {
    const step = {
      id: 's1',
      anchor: 'review' as const,
      order: 0,
      kind: 'prompt' as const,
      title: { ru: 'Проверка доков', en: 'Docs check' },
      prompt: { ru: 'Проверь', en: 'Check' },
      source: 'en' as const,
      createdAt: '2026-09-26T00:00:00.000Z',
    };
    saveGroup({ path: { steps: [step] } });
    await boot();
    const promote = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/groups/g1/path/promote', payload });
    const res = await promote({
      stepId: 's1',
      type: 'script',
      draft: "console.log('ok');",
      name: 'check-docs',
    });
    expect(res.statusCode).toBe(200);
    const view = res.json<GroupPathView>();
    const entry = view.entries.find((item) => item.kind === 'custom');
    expect(entry).toMatchObject({
      step: { kind: 'resource', resource: { type: 'script', id: 'check-docs.mjs' } },
    });
    expect(readFileSync(join(hooksDir(), 'check-docs.mjs'), 'utf8')).toBe("console.log('ok');\n");
    expect(new AppStore(join(root, 'agentdeck')).getGroups()[0]!.members).toEqual([]);

    // Имя из заголовка шага, когда `name` нет; то же имя второй раз — 409, файл не тронут.
    saveGroup({ path: { steps: [step] } });
    const byTitle = await promote({ stepId: 's1', type: 'script', draft: 'one' });
    expect(byTitle.statusCode).toBe(200);
    expect(existsSync(join(hooksDir(), 'docs-check.mjs'))).toBe(true);
    saveGroup({ path: { steps: [step] } });
    const taken = await promote({ stepId: 's1', type: 'script', draft: 'two' });
    expect(taken.statusCode).toBe(409);
    expect(readFileSync(join(hooksDir(), 'docs-check.mjs'), 'utf8')).toBe('one\n');
  });
});
