/**
 * Задача ядра с открытым вопросом человеку — для проверок каналов (зона D этапа 10): ответ с
 * телефона и пересылка вопроса в Telegram требуют НАСТОЯЩЕГО открытого вопроса в журнале, а
 * дорога к нему через модель (оценка, деление, сессия) — предмет других проверок.
 *
 * Пишет журнал кодом самого ядра (`createTaskRegistry` + `raiseHumanPoint`, пункт 10 «запустить
 * задачу?», источник ядра — политика не нужна) в `<дом ядра>/tasks` ДО старта процесса ядра
 * стенда; ядро поднимает задачу при загрузке, как после своего перезапуска. Отдельный процесс:
 * аренда журнала снимается его выходом, ядро стенда её не делит с проверкой.
 *
 * Запуск: `node --experimental-strip-types --no-warnings tools/qa/core-ask-seed.mjs <дом ядра>
 * [заголовок]` → строка JSON `{taskId, askId}`.
 */
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = (rel) => import(pathToFileURL(join(ROOT, 'apps/core/src', rel)).href);

const [home, title = 'Проверка каналов: вопрос человеку'] = process.argv.slice(2);
if (!home) {
  console.error('usage: core-ask-seed.mjs <core home> [title]');
  process.exit(2);
}

const { createTaskRegistry } = await core('conductor/tasks.ts');
const { raiseHumanPoint } = await core('conductor/human/raise.ts');
const { layoutOf } = await core('platform/core-home.ts');
const { ensureDir } = await core('platform/safe-io/files.ts');
const { newId } = await core('lib/ids/uuidv7.ts');
const { CREATED, deps, fakeClock } = await core('journal/__fixtures__/journal-harness.ts');

const layout = layoutOf(resolve(home));
ensureDir(layout.tasks);
// Часы — настоящие: уход за вопросами (`human/upkeep`) судит возраст вопроса по стенным часам.
const registry = createTaskRegistry(layout.tasks, deps({ clock: fakeClock(Date.now()) }));
const task = await registry.create({ ...CREATED, title });
const raised = raiseHumanPoint(task, {
  source: 'launch',
  stepId: null,
  sessionId: null,
  action: { kind: 'launch', target: newId() },
  point: 10,
  dedupe: null,
  question: 'Launch the task? Split: one unit (no split).',
  options: ['approve-split', 'edit-split', 'cancel'],
  recommendation: 'approve-split',
  blocking: true,
});
if (raised.kind !== 'asked') {
  console.error(`seed: ask not raised (${raised.kind})`);
  process.exit(1);
}
registry.closeAll();
console.log(JSON.stringify({ taskId: task.taskId, askId: raised.askId }));
process.exit(0);
