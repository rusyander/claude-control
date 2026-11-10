/**
 * Задачи ядра для сквозного обхода волны 2 этапа 12 (`check-core-w2-cross-zone-live.mjs`). Журнал и
 * доска пишутся кодом самого ядра ДО старта процесса ядра стенда — ядро поднимает их при загрузке:
 *   - `sweep` — законченная задача с MR на заглушке форжа (`publish.mr`, без `mrState`): карточка в
 *     колонке «MR»; слитый на форже MR обход ядра переводит в «Влит»;
 *   - `comment` — задача, рождённая записью доски из трекера (источник `jira`, тикет `PROJ-7`), с
 *     открытым MR и вопросом пункта 9 «записать в тикет?» — поднят тем же `raiseTrackerWriteAsk`,
 *     которым его поднимает публикатор при открытии MR.
 *
 * Запуск: `node --experimental-strip-types --no-warnings tools/qa/core-w2-walk-seed.mjs <дом ядра>
 * <репозиторий> <адрес форжа> <iid MR обхода>` → строка JSON `{sweep, sweepUnit, comment, commentAsk,
 * entryId}`.
 */
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = (rel) => import(pathToFileURL(join(ROOT, 'apps/core/src', rel)).href);

const [home, repo, forgeUrl, sweepIid] = process.argv.slice(2);
if (!home || !repo || !forgeUrl || !sweepIid) {
  console.error('usage: core-w2-walk-seed.mjs <core home> <repo> <forge url> <sweep mr iid>');
  process.exit(2);
}

const { createTaskRegistry } = await core('conductor/tasks.ts');
const { createBoardStore } = await core('conductor/board/store.ts');
const { raiseTrackerWriteAsk } = await core('conductor/human/tracker-write-ask.ts');
const { layoutOf } = await core('platform/core-home.ts');
const { ensureDir } = await core('platform/safe-io/files.ts');
const { newId } = await core('lib/ids/uuidv7.ts');
const { CREATED, SOLO_UNIT, deps, fakeClock } = await core(
  'journal/__fixtures__/journal-harness.ts',
);

const layout = layoutOf(resolve(home));
ensureDir(layout.tasks);
// Часы настоящие: возраст вопросов и концов задач судится по стенным часам.
const registry = createTaskRegistry(layout.tasks, deps({ clock: fakeClock(Date.now()) }));
const repos = [{ repoKey: 'r1', path: resolve(repo), baseRef: 'main' }];

// ── законченная задача с MR на форже ───────────────────────────────────────────────────────
const sweep = await registry.create({ ...CREATED, title: 'Обход: MR на форже', repos, lang: 'ru' });
const sweepUnit = newId();
const sweepBranch = `agentdeck/${sweepUnit.slice(0, 8)}`;
sweep.append({
  kind: 'unit.created',
  actor: 'core',
  unitId: sweepUnit,
  data: { unitId: sweepUnit, repoKey: 'r1', branch: sweepBranch, ownedPaths: [], ...SOLO_UNIT },
});
sweep.append({
  kind: 'publish.mr',
  actor: 'core',
  unitId: sweepUnit,
  data: {
    unitId: sweepUnit,
    forge: 'gitlab',
    mrId: String(1000 + Number(sweepIid)),
    mrIid: Number(sweepIid),
    url: `${forgeUrl}/acme/app/-/merge_requests/${sweepIid}`,
    sourceBranch: sweepBranch,
    actionId: newId(),
  },
});
sweep.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });

// ── задача из трекера с вопросом пункта 9 ─────────────────────────────────────────────────
const entryId = newId();
createBoardStore({ root: layout.root }).update(newId(), Date.now(), (file) => {
  file.entries.push({
    entryId,
    state: 'started',
    rank: 0,
    stop: 'mr',
    preset: 'bug-fix',
    source: { kind: 'tracker', system: 'jira', key: 'PROJ-7', title: 'Ответ в тикет' },
    launch: { kind: 'fields', fields: { title: 'Ответ в тикет', request: 'Исправить' } },
    createdAt: Date.now(),
  });
  return { ok: true };
});
const comment = await registry.create({
  ...CREATED,
  title: 'Обход: ответ в тикет',
  repos,
  lang: 'ru',
  boardEntry: { entryId, stop: 'mr', source: 'tracker', proof: { kind: 'human', cmdId: newId() } },
});
const unitId = newId();
comment.append({
  kind: 'unit.created',
  actor: 'core',
  unitId,
  data: { unitId, repoKey: 'r1', branch: 'agentdeck/cb', ownedPaths: [], ...SOLO_UNIT },
});
const mr = {
  unitId,
  forge: 'gitlab',
  mrId: '7070',
  mrIid: 70,
  url: 'https://tracker.example.com/acme/app/-/merge_requests/70',
  sourceBranch: 'agentdeck/cb',
  actionId: newId(),
};
comment.append({ kind: 'publish.mr', actor: 'core', unitId, data: mr });
const raised = raiseTrackerWriteAsk(comment, { system: 'jira', key: 'PROJ-7' }, mr);
if (raised.kind !== 'asked') {
  console.error(`seed: point 9 ask not raised (${raised.kind})`);
  process.exit(1);
}
registry.closeAll();
console.log(
  JSON.stringify({
    sweep: sweep.taskId,
    sweepUnit,
    comment: comment.taskId,
    commentAsk: raised.askId,
    entryId,
  }),
);
process.exit(0);
