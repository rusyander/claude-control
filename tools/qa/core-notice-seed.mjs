/**
 * Задачи ядра для живой проверки уведомлений Telegram (этап 12, P191–P193): законченная с открытым
 * MR наружу, законченная с MR на loopback, упавшая с причиной шага. Журнал пишется кодом самого
 * ядра (`createTaskRegistry`, строки `unit.created` / `publish.mr` / `task.ended`) в
 * `<дом ядра>/tasks` ДО старта процесса ядра стенда — ядро поднимает их при загрузке.
 *
 * Второй аргумент — каталог данных панели: файл уведомлений получает `lastPumpAt = сейчас`, иначе
 * первый проход счёл бы эти концы «вчерашними» (без потока старого после долгого простоя) и
 * промолчал бы — это поведение проверяется юнитом, а здесь нужен сам конец.
 *
 * Запуск: `node --experimental-strip-types --no-warnings tools/qa/core-notice-seed.mjs <дом ядра>
 * <каталог данных панели>` → строка JSON `{done, loopback, failed}` (id задач).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = (rel) => import(pathToFileURL(join(ROOT, 'apps/core/src', rel)).href);

const [home, appData] = process.argv.slice(2);
if (!home || !appData) {
  console.error('usage: core-notice-seed.mjs <core home> <panel app data>');
  process.exit(2);
}

const { createTaskRegistry } = await core('conductor/tasks.ts');
const { layoutOf } = await core('platform/core-home.ts');
const { ensureDir } = await core('platform/safe-io/files.ts');
const { newId } = await core('lib/ids/uuidv7.ts');
const { CREATED, SOLO_UNIT, deps, fakeClock } = await core(
  'journal/__fixtures__/journal-harness.ts',
);

const layout = layoutOf(resolve(home));
ensureDir(layout.tasks);
const registry = createTaskRegistry(layout.tasks, deps({ clock: fakeClock(Date.now()) }));

// Настоящий репозиторий задачи с `origin`: доработка конченной задачи (задача-носитель, P162)
// читает удалённые репозитории — путь-заглушка из образца журнала дал бы отказ по существу.
const repo = join(dirname(resolve(home)), 'notice-repo');
const bare = join(dirname(resolve(home)), 'notice-origin.git');
const git = (cwd, ...args) => {
  const out = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
};
mkdirSync(repo, { recursive: true });
mkdirSync(bare, { recursive: true });
git(bare, 'init', '-q', '--bare', '-b', 'main');
git(repo, 'init', '-q', '-b', 'main');
writeFileSync(join(repo, 'README.md'), '# notice repo\n', 'utf8');
git(repo, 'add', '.');
git(repo, '-c', 'user.name=qa', '-c', 'user.email=qa@example.com', 'commit', '-q', '-m', 'init');
git(repo, 'remote', 'add', 'origin', bare);
git(repo, 'push', '-q', 'origin', 'main');
const repos = [{ repoKey: 'r1', path: repo, baseRef: 'main' }];

async function ended(title, outcome, mrUrl) {
  const task = await registry.create({ ...CREATED, title, repos });
  if (mrUrl) {
    const unitId = newId();
    // Ветка MR единицы — в `origin`: носитель доработки стартует от неё.
    git(repo, 'push', '-q', 'origin', `main:refs/heads/agentdeck/${unitId.slice(0, 8)}`);
    git(repo, 'fetch', '-q', 'origin');
    task.append({
      kind: 'unit.created',
      actor: 'core',
      unitId,
      data: {
        unitId,
        repoKey: 'r1',
        branch: `agentdeck/${unitId.slice(0, 8)}`,
        ownedPaths: [],
        ...SOLO_UNIT,
      },
    });
    task.append({
      kind: 'publish.mr',
      actor: 'core',
      unitId,
      data: {
        unitId,
        forge: 'gitlab',
        mrId: '1',
        mrIid: 4,
        url: mrUrl,
        sourceBranch: `agentdeck/${unitId.slice(0, 8)}`,
        actionId: newId(),
      },
    });
  }
  task.append({ kind: 'task.ended', actor: 'core', data: { outcome } });
  return task.taskId;
}

const out = {
  done: await ended(
    'Уведомление: готова с MR',
    'done',
    'https://tracker.example.com/group/app/-/merge_requests/4',
  ),
  loopback: await ended(
    'Уведомление: MR на стенде',
    'done',
    'https://127.0.0.1:8929/group/app/-/merge_requests/5',
  ),
  failed: await ended('Уведомление: упала', 'failed'),
};
registry.closeAll();

mkdirSync(resolve(appData), { recursive: true });
writeFileSync(
  join(resolve(appData), 'telegram-notices.json'),
  `${JSON.stringify({ version: 1, lastPumpAt: Date.now() })}\n`,
  'utf8',
);
console.log(JSON.stringify(out));
process.exit(0);
