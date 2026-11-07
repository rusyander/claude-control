/**
 * Задача ядра с историей агентов — для чтений агентов панелью и агентом панели (этап 11, W3-19):
 * дерево (сеанс единицы, субагент, фоновая команда с кодом выхода) нужно НАСТОЯЩЕЕ, из журнала
 * ядра, а дорога к нему через модель (оценка, запуск, сессия CLI) — предмет других проверок.
 *
 * Пишет журнал кодом самого ядра: `createTaskRegistry`, сессия шага (`seedLiveSession`) и золотые
 * строки агентов переходника (`agentsGoldenRows` — те же, что сверяет `agents-api.integration`), в
 * `<дом ядра>/tasks` ДО старта процесса ядра стенда; ядро поднимает задачу при загрузке. Задача —
 * продолжение разговора `<conversationId>` (`resume.conversationId`): по нему её находит
 * `GET /v1/agents?conversationId=`. Отдельный процесс: аренда журнала снимается его выходом.
 *
 * Запуск: `node --experimental-strip-types --no-warnings tools/qa/core-agents-seed.mjs <дом ядра>
 * <conversationId> [заголовок] [id субагента]` → строка JSON `{taskId, sessionId, subagent, background}`.
 * Id субагента — вместо золотого `toolu_01SubAgent`: настоящий id вызова Claude (`toolu_01` + 24
 * знака) детектор секретов принимает за ключ, и проверка видит это только на такой форме.
 */
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = (rel) => import(pathToFileURL(join(ROOT, 'apps/core/src', rel)).href);

const [home, conversationId, title = 'Агенты задачи ядра', subagentId] = process.argv.slice(2);
if (!home || !conversationId) {
  console.error('usage: core-agents-seed.mjs <core home> <conversationId> [title]');
  process.exit(2);
}

const { createTaskRegistry } = await core('conductor/tasks.ts');
const { layoutOf } = await core('platform/core-home.ts');
const { ensureDir } = await core('platform/safe-io/files.ts');
const { identityOfPid } = await core('platform/process-identity.ts');
const { CREATED, deps, fakeClock } = await core('journal/__fixtures__/journal-harness.ts');
const { seedLiveSession } = await core('bootstrap/agents-wiring/__fixtures__/seed.ts');
const { agentsGoldenRows, BG_ITEM, SUB } = await core(
  'journal/reduce/__fixtures__/agents-golden.ts',
);

const layout = layoutOf(resolve(home));
ensureDir(layout.tasks);
const registry = createTaskRegistry(layout.tasks, deps({ clock: fakeClock(Date.now()) }));
const task = await registry.create({
  ...CREATED,
  title,
  resume: { adapter: 'claude', conversationId },
});
// Хост сессии — этот процесс: золотые строки кончают сессию (`exited`) и фон (`exit`, код 0),
// так что после его выхода ядру нечего закрывать как потерянное.
const me = await identityOfPid(process.pid);
if (!('value' in me)) {
  console.error('seed: own process identity unread');
  process.exit(1);
}
const ids = seedLiveSession(task, me.value);
const sub = subagentId ?? SUB;
for (const row of agentsGoldenRows(ids)) {
  task.append({
    kind: row.kind,
    actor: 'core',
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    data: sub === SUB ? row.data : JSON.parse(JSON.stringify(row.data).split(SUB).join(sub)),
  });
}
registry.closeAll();
console.log(
  JSON.stringify({
    taskId: ids.taskId,
    sessionId: ids.sessionId,
    subagent: sub,
    background: BG_ITEM,
  }),
);
process.exit(0);
