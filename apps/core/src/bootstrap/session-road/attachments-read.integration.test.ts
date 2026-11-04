import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { splitAttachments } from '@agentdeck/contracts/uploads';
import { afterAll, describe, expect, it } from 'vitest';
import { estimateTask } from '../../conductor/estimate/estimate.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { estimateBody, gitRepo, testEnv } from '../../conductor/split/__fixtures__/split-stand.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { deps as journalDeps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { decidePermit } from '../../policy/permit/permit.ts';
import { sessionPermitDeny } from '../../adapters/deny-overlay.ts';
import { claudeDenyRules } from '../../adapters/claude/permission.ts';
import { claudeAbsolutePattern } from '../../adapters/claude/path-pattern.ts';
import { isInside } from '../../platform/paths.ts';
import { createSessionRoad } from './road.ts';
import type { RoadStart } from './road.types.ts';

/**
 * Вложение чата до сеанса и обратно (этап 10, s10 G11) настоящей дорогой: оценка чата с байтами
 * вложения кладёт копию в каталог задачи и называет её путь в запросе; `contextFor` дороги сессии
 * открывает сеансу этот каталог — судья права пускает `Read` копии, а запрет CLI на дом ядра её не
 * ловит: дом здесь с длинным именем (`core-home`, как у стенда), его шаблон терпим к 8.3. Файл
 * в доме панели (`~/.agentdeck/chats/<id>/`) и чужая задача остаются закрыты. Подменено только
 * хранилище адаптеров (дорога здесь не запускает CLI).
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const root = tempDir('core-attach-read-');
// Длинное имя дома — как у стенда: его запрет CLI терпим к 8.3 (`*c*o*r*e*-*h*`) и ловил бы
// соседа `core-home-attachments` (живой отказ «directory that is denied»).
const layout = layoutOf(join(root, 'core-home'));
const registry = createTaskRegistry(layout.tasks, journalDeps());
const env = testEnv(layout.scenarios);
afterAll(() => registry.closeAll());

const read = (target: string) => ({
  action: 'read' as const,
  target,
  tool: 'Read',
  display: `Read ${target}`,
});

async function chatWith(repo: string, attachments: Array<{ name: string; base64: string }>) {
  const out = await estimateTask(
    {
      ...estimateBody([repo], {
        scenario: { preset: 'chat' },
        request: 'Что на картинке?',
        placement: { kind: 'in-place', grant: { project: repo, ops: ['edit'] } },
      }),
      attachments,
    },
    registry,
    env,
  );
  if (out.status === 422) throw new Error(out.problems.join('; '));
  return registry.live(out.reply.taskId)!;
}

function contextOf(task: ReturnType<typeof registry.live> & object, repo: string) {
  const seeded = seedSession(task, { stepKind: 'chat' });
  const road = createSessionRoad({ layout, adapters: { get: () => undefined } } as never);
  const start = {
    task,
    stepId: seeded.stepId,
    sessionId: seeded.sessionId,
    adapterId: 'claude',
    cwd: repo,
    dir: join(layout.root, 'sessions', seeded.sessionId),
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    layer: { hooks: 'on', skills: 'on' },
    model: null,
    pin: {},
  } as unknown as RoadStart;
  return road.contextFor(start);
}

describe('chat attachment: core copy, named in the request, readable by the task session only', () => {
  it('estimate stores the copy under the task, request.md names it; the session reads it, not the panel file', async () => {
    const repo = gitRepo(root, 'chat-repo');
    // Файл, как его кладёт панель: дом панели, вне проекта.
    const panelFile = join(root, 'panel-home', 'chats', 'c1', 'shot.png');
    mkdirSync(join(root, 'panel-home', 'chats', 'c1'), { recursive: true });
    writeFileSync(panelFile, PNG);

    const task = await chatWith(repo, [{ name: 'shot.png', base64: PNG.toString('base64') }]);
    const request = readFileSync(join(task.dir, 'request.md'), 'utf8');
    const named = splitAttachments(request);
    expect(named.text).toBe('Что на картинке?');
    expect(named.files).toHaveLength(1);
    const copy = named.files[0]!;
    expect(isInside(join(layout.attachments, task.taskId), copy)).toBe(true);
    expect(readFileSync(copy).equals(PNG)).toBe(true);
    // Оверлей CLI сеанса запрещает дом ядра целиком (`Read(<дом>/**)`, запрет CLI старше любого
    // разрешения): копия обязана лежать вне каждого пути этого запрета, иначе CLI её не прочтёт.
    const overlay = sessionPermitDeny(
      { coreHome: layout.root, tokenFiles: [layout.token] },
      { paths: [], commands: [], mcpTools: [], tools: [] },
      repo,
    );
    expect(overlay.deny.paths.filter((p) => isInside(p, copy))).toEqual([]);
    // Те самые правила, что уходят CLI: ни одно `Read(…)` не ловит путь копии, как его пишет модель.
    const { rules } = claudeDenyRules(overlay.deny, [], repo);
    const spelling = claudeAbsolutePattern(copy);
    const catching = rules
      .filter((rule) => rule.startsWith('Read('))
      .filter((rule) => posix.matchesGlob(spelling, rule.slice('Read('.length, -1)));
    expect(catching).toEqual([]);
    // Сам дом правила ловят — проверка не пуста.
    expect(
      rules.some(
        (rule) =>
          rule.startsWith('Read(') &&
          posix.matchesGlob(claudeAbsolutePattern(layout.token), rule.slice('Read('.length, -1)),
      ),
    ).toBe(true);

    const ctx = contextOf(task, repo);
    expect(decidePermit(read(copy), ctx)).toMatchObject({ allow: true });
    expect(decidePermit(read(panelFile), ctx)).toMatchObject({
      allow: false,
      code: 'outside-copy',
    });
    expect(decidePermit(read(join(task.dir, 'journal.jsonl')), ctx)).toMatchObject({
      allow: false,
      code: 'platform-path',
    });

    // Копия другой задачи — рядом, в том же корне вложений, но не в области этого сеанса.
    const other = await chatWith(gitRepo(root, 'chat-repo-2'), [
      { name: 'other.png', base64: PNG.toString('base64') },
    ]);
    const otherCopy = splitAttachments(readFileSync(join(other.dir, 'request.md'), 'utf8'))
      .files[0]!;
    expect(decidePermit(read(otherCopy), ctx)).toMatchObject({
      allow: false,
      code: 'outside-copy',
    });
  });

  it('an attachment whose bytes are not the image its name says is refused before any task exists', async () => {
    const repo = gitRepo(root, 'chat-repo-bad');
    const before = registry.list().length;
    const out = await estimateTask(
      {
        ...estimateBody([repo], {
          scenario: { preset: 'chat' },
          placement: { kind: 'in-place', grant: { project: repo, ops: ['edit'] } },
        }),
        attachments: [{ name: 'fake.png', base64: Buffer.from('not a png').toString('base64') }],
      },
      registry,
      env,
    );
    expect(out.status).toBe(422);
    expect(out.status === 422 && out.problems.join(' ')).toMatch(/fake\.png/);
    expect(registry.list().length).toBe(before);
  });

  it('a non-chat scenario takes no attachments', async () => {
    const repo = gitRepo(root, 'feature-repo');
    const out = await estimateTask(
      {
        ...estimateBody([repo]),
        attachments: [{ name: 'shot.png', base64: PNG.toString('base64') }],
      },
      registry,
      env,
    );
    expect(out.status).toBe(422);
    expect(out.status === 422 && out.problems.join(' ')).toMatch(/only a chat task/);
  });
});
