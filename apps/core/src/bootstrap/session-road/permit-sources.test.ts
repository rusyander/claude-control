import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import { answerHookCall } from '../../api/session-hook.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { CREATED, openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { adoptCoreConfig } from '../../platform/core-config/write.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { createSessionRoad } from './road.ts';
import type { RoadStart } from './road.types.ts';

/**
 * P130 настоящей дорогой сессии: контекст права собирает `createSessionRoad().contextFor` — тот
 * же, что получает хук ядра и сервер права запущенной сессии. `grantRequired` — из конфига ядра по
 * исходному репозиторию, источники адреса — файлы окружения копии (удалённый адрес) и исходного
 * репозитория (любой адрес сервиса), гранты — из журнала задачи. Пустые списки на этой дороге
 * делали пункты 3 и 5 недостижимыми в настоящем прогоне.
 */

function write(root: string, rel: string, text: string): string {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function asks(task: LiveTask) {
  return readJournalLines(task.dir, task.taskId)
    .lines.filter((l) => l.kind === 'human.asked')
    .map((l) => l.data as { point: number; source: string });
}

async function stand() {
  const home = tempDir('core-home-');
  const layout = layoutOf(home);
  const source = tempDir('src-repo-');
  const copy = tempDir('copy-');
  writeFileSync(
    layout.config,
    JSON.stringify({
      grantRequired: [
        { project: source, globs: ['migrations/**'], ops: ['edit'] },
        { project: join(source, '..', 'other'), globs: ['src/**'], ops: ['edit'] },
      ],
    }),
  );
  const srcEnv = write(source, '.env', 'DATABASE_URL=postgres://localhost:5432/app\n');
  const srcNested = write(source, 'docker/.env.local', 'REDIS_URL=redis://cache.internal:6379\n');
  write(source, '.env.example', 'DATABASE_URL=postgres://db.example.com/app\n');
  write(source, 'node_modules/pkg/.env', 'DATABASE_URL=postgres://db.example.com/app\n');
  write(source, '.env.flags', 'FEATURE_X=1\n');
  // Каталог с именем файла окружения (venv `.env/`) — не файл и не источник.
  write(source, 'api/.env/pyvenv.cfg', 'DATABASE_URL=postgres://db.example.com/app\n');
  // Адрес, который ядро переписало на свой контейнер, — не источник; удалённый — источник.
  write(copy, '.env', 'DATABASE_URL=postgres://127.0.0.1:55432/app\n');
  const copyProd = write(copy, '.env.prod', 'API_DB_URL=postgres://db.prod.example.com:5432/app\n');

  const { task } = await openFresh();
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: { ...CREATED, repos: [{ repoKey: 'r1', path: source, baseRef: 'main' }] },
  });
  const seeded = seedSession(task, { stepKind: 'work' });
  const bound = bindingOf(task, seeded.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  const road = createSessionRoad({ layout, adapters: { get: () => undefined } } as never);
  const start = {
    task,
    stepId: seeded.stepId,
    sessionId: seeded.sessionId,
    adapterId: 'claude',
    cwd: copy,
    dir: join(home, 'sessions', seeded.sessionId),
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    layer: { hooks: 'on', skills: 'on' },
    model: null,
    pin: {},
  } as unknown as RoadStart;
  return { task, b: bound.binding, road, start, source, copy, srcEnv, srcNested, copyProd };
}

const edit = (file: string) => ({ tool: 'Edit', input: { file_path: file } });
const read = (file: string) => ({ tool: 'Read', input: { file_path: file } });

describe('P130 through the real session road', () => {
  it('P130 the road context carries grantRequired, endpoint sources and task grants, so the hook raises items 5 and 3', async () => {
    const s = await stand();
    const ctx = s.road.contextFor(s.start);
    expect(ctx.grantRequired).toEqual([{ globs: ['migrations/**'], ops: ['edit'] }]);
    expect([...ctx.endpointSources].sort()).toEqual([s.copyProd, s.srcEnv, s.srcNested].sort());
    expect(ctx.grants).toEqual([]);
    const deps = { mapPermission: mapClaudePermission, context: ctx };

    const blocked = answerHookCall(s.task, s.b, edit('migrations/1.sql'), deps);
    expect(blocked.allow).toBe(false);
    expect(asks(s.task)).toMatchObject([{ point: 5, source: 'permit' }]);
    expect(s.task.state.steps[s.b.stepId]?.state).toBe('waiting-human');

    expect(answerHookCall(s.task, s.b, read('.env.prod'), deps).allow).toBe(false);
    expect(answerHookCall(s.task, s.b, read(s.srcEnv), deps).allow).toBe(false);
    expect(asks(s.task).map((a) => a.point)).toEqual([5, 3, 3]);
    // Переписанный ядром файл копии и обычный файл читаются без вопроса.
    expect(answerHookCall(s.task, s.b, read('.env'), deps).allow).toBe(true);
    expect(answerHookCall(s.task, s.b, edit('src/app.ts'), deps).allow).toBe(true);
    expect(asks(s.task)).toHaveLength(3);

    // Грант задачи: контекст следующей сессии (или прикреплённой после перезапуска) несёт его.
    s.task.append({
      kind: 'grant.given',
      actor: 'core',
      data: { cmdId: newId(), project: 'r1', globs: ['migrations/**'], ops: ['edit'] },
    });
    const next = s.road.contextFor(s.start);
    expect(next.grants).toEqual([{ globs: ['migrations/**'], ops: ['edit'] }]);
    expect(
      answerHookCall(s.task, s.b, edit('migrations/2.sql'), { ...deps, context: next }).allow,
    ).toBe(true);
    s.task.close();
  });

  it('stage7-c G6 an edit of config.json outside the API never changes a permit decision: before and after the planted edit the masked edit is held', async () => {
    const s = await stand();
    const config = join(s.start.dir, '..', '..', 'config.json');
    // Загрузка этапа 7 принимает файл до этапа 7 один раз — дальше он последняя запись ядра.
    expect(adoptCoreConfig({ config }, 1)).toBeDefined();
    const decide = (file: string) => {
      const ctx = s.road.contextFor(s.start);
      return answerHookCall(s.task, s.b, edit(file), {
        mapPermission: mapClaudePermission,
        context: ctx,
      }).allow;
    };
    expect(decide('migrations/1.sql')).toBe(false);
    // Скрипт сессии (или рука в терминале — не различить) снимает маску мимо API.
    writeFileSync(config, JSON.stringify({ grantRequired: [] }));
    expect(s.road.contextFor(s.start).grantRequired).toEqual([
      { globs: ['migrations/**'], ops: ['edit'] },
    ]);
    expect(decide('migrations/2.sql')).toBe(false);
    expect(asks(s.task).map((a) => a.point)).toEqual([5, 5]);
    s.task.close();
  });

  it('a bad grantRequired row does not lift the good rows: they stay in force and the bad one is signalled', async () => {
    const s = await stand();
    writeFileSync(
      join(s.start.dir, '..', '..', 'config.json'),
      JSON.stringify({
        grantRequired: [
          { project: s.source, globs: [], ops: ['edit'] },
          { project: s.source, globs: ['migrations/**'], ops: ['edit'] },
        ],
      }),
    );
    const ctx = s.road.contextFor(s.start);
    expect(ctx.grantRequired).toEqual([{ globs: ['migrations/**'], ops: ['edit'] }]);
    const signals = readJournalLines(s.task.dir, s.task.taskId)
      .lines.filter((l) => l.kind === 'signal')
      .map((l) => l.data as { signal: string; detail: string });
    expect(signals).toContainEqual(
      expect.objectContaining({
        signal: 'permit-sources-unread',
        detail: expect.stringMatching(/^grantRequired: 0: globs/),
      }),
    );
    s.task.close();
  });

  it('an unreadable grantRequired entry is named by a signal, not skipped silently', async () => {
    const s = await stand();
    writeFileSync(
      join(s.start.dir, '..', '..', 'config.json'),
      JSON.stringify({ grantRequired: [{ project: s.source, globs: [], ops: ['edit'] }] }),
    );
    const ctx = s.road.contextFor(s.start);
    expect(ctx.grantRequired).toEqual([]);
    const signals = readJournalLines(s.task.dir, s.task.taskId)
      .lines.filter((l) => l.kind === 'signal')
      .map((l) => (l.data as { signal: string; detail: string }).signal);
    expect(signals).toContain('permit-sources-unread');
    s.task.close();
  });
});
