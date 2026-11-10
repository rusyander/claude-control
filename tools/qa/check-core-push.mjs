/**
 * Push только о том, что ждёт человека (этап 12, P175): НАСТОЯЩЕЕ ядро стенда с вопросами,
 * НАСТОЯЩИЙ сервер панели и его пересылка, поддельный сервис Expo на loopback
 * (`AGENTDECK_EXPO_PUSH_URL`) — подменён только адрес сервиса push.
 *
 * Что проверяется:
 * 1. Три блокирующих вопроса ядра (запуск — пункт 10, бюджет — 7, потерян вход — 4) → ровно по
 *    одному push на вопрос, с номером задачи и вопроса.
 * 2. Неблокирующий вопрос (шаг сценария, пункт 8, `blocking:false` → действие по умолчанию) — ни
 *    одного push: задача идёт сама. Канала для него нет (Telegram выключен) — он ждёт в `pending`
 *    файла пересылки с `waits:false`.
 * 3. Жёсткий перезапуск панели — второго push ни о каком вопросе нет.
 *
 * Карточка права ядра в чате + та же строка пересылки (один push на оба отправителя) и отсутствие
 * push о «готово»/«упало» — `apps/server/src/domains/notify/push-once.test.ts` (настоящие
 * уведомитель, пересылка и отправка по сети в поддельный Expo): чат с вопросом права ядра на
 * стенде требует живой модели.
 *
 * Вопросы — кодом ядра до его старта (режим `--seed` этого же файла, отдельным процессом: аренда
 * журнала снимается его выходом). Устройство — `POST /remote/devices` панели. Сеть не нужна.
 * Запуск: `node tools/qa/check-core-push.mjs`. Код выхода: 0 / 1 провал / 2 стенд.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '..', '..');

/** Вопросы проверки: источник ядра, его пункт и блокирует ли. */
const ASKS = [
  { name: 'launch', source: 'launch', point: 10, blocking: true, launch: true },
  { name: 'budget', source: 'budget', point: 7, blocking: true },
  { name: 'login', source: 'login', point: 4, blocking: true },
  { name: 'scenario', source: 'scenario-step', point: 8, blocking: false },
];

if (process.argv[2] === '--seed') {
  await seed(process.argv[3]);
  process.exit(0);
}

/**
 * Режим посева: по задаче на вопрос, журнал — кодом ядра (`raiseHumanPoint`), как
 * `core-ask-seed.mjs`. Печатает `{ name: { taskId, askId } }` одной строкой JSON.
 */
async function seed(home) {
  if (!home) throw new Error('usage: check-core-push.mjs --seed <core home>');
  const core = (rel) => import(pathToFileURL(join(ROOT, 'apps/core/src', rel)).href);
  const { createTaskRegistry } = await core('conductor/tasks.ts');
  const { raiseHumanPoint } = await core('conductor/human/raise.ts');
  const { layoutOf } = await core('platform/core-home.ts');
  const { ensureDir } = await core('platform/safe-io/files.ts');
  const { newId } = await core('lib/ids/uuidv7.ts');
  const { CREATED, deps, fakeClock } = await core('journal/__fixtures__/journal-harness.ts');
  const layout = layoutOf(resolve(home));
  ensureDir(layout.tasks);
  const registry = createTaskRegistry(layout.tasks, deps({ clock: fakeClock(Date.now()) }));
  const out = {};
  for (const ask of ASKS) {
    const task = await registry.create({ ...CREATED, title: `Push: ${ask.name}` });
    const raised = raiseHumanPoint(task, {
      source: ask.source,
      stepId: null,
      sessionId: null,
      action: ask.launch ? { kind: 'launch', target: newId() } : null,
      point: ask.point,
      dedupe: null,
      question: `Question ${ask.name}?`,
      options: ['go', 'stop'],
      recommendation: 'go',
      blocking: ask.blocking,
    });
    if (raised.kind !== 'asked') throw new Error(`seed ${ask.name}: ${raised.kind}`);
    out[ask.name] = { taskId: task.taskId, askId: raised.askId, blocking: raised.blocking };
  }
  registry.closeAll();
  console.log(JSON.stringify(out));
}

const { REPO, runOnStand, wait } = await import('./throwaway-stand.mjs');

// ---- поддельный сервис Expo ---------------------------------------------------------------------
const received = [];
const expo = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk.toString('utf8')));
  req.on('end', () => {
    let messages = [];
    try {
      messages = JSON.parse(raw);
    } catch {
      // Кривое тело — пусть проверка увидит, что push не дошёл.
    }
    received.push(...messages);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: messages.map(() => ({ status: 'ok' })) }));
  });
});
await new Promise((done) => expo.listen(0, '127.0.0.1', done));
const expoPort = expo.address().port;

async function until(probe, ms = 30_000, step = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value || Date.now() > deadline) return value;
    await wait(step);
  }
}

const pushesFor = (askId) => received.filter((message) => message.data?.askId === askId);

let seeded;
try {
  await runOnStand(
    {
      label: 'core-push',
      core: true,
      web: false,
      env: {
        AGENTDECK_CORE_SUPERVISE: '0',
        AGENTDECK_EXPO_PUSH_URL: `http://127.0.0.1:${expoPort}/--/api/v2/push/send`,
      },
      settings: {
        // Telegram выключен: видно только push; уведомления на телефон — включены (умолчание).
        integrations: { telegram: { enabled: false, chatId: '', events: ['question'] } },
      },
      seed: ({ coreHome }) => {
        const run = spawnSync(
          process.execPath,
          ['--experimental-strip-types', '--no-warnings', SELF, '--seed', coreHome],
          { encoding: 'utf8', cwd: REPO },
        );
        if (run.status !== 0) throw new Error(`seed failed: ${run.stderr}`);
        seeded = JSON.parse(run.stdout.trim().split('\n').at(-1));
      },
    },
    async (stand, check) => {
      const statePath = join(stand.home, '.agentdeck', 'core-relay.json');
      const readState = () =>
        existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;

      check(
        'посев: три блокирующих вопроса и один неблокирующий',
        ['launch', 'budget', 'login'].every((name) => seeded[name]?.blocking === true) &&
          seeded.scenario?.blocking === false,
        JSON.stringify(seeded),
      );
      const device = await stand.api('/remote/devices', {
        method: 'POST',
        body: { token: 'ExponentPushToken[qa-core-push]', platform: 'android', label: 'QA' },
      });
      check('телефон зарегистрирован в панели', device.status === 200, device.text.slice(0, 300));

      const blocking = ['launch', 'budget', 'login'].map((name) => seeded[name].askId);
      const all = await until(() => blocking.every((askId) => pushesFor(askId).length > 0));
      check(
        'по push на каждый блокирующий вопрос (запуск, бюджет, вход)',
        Boolean(all),
        JSON.stringify(received.map((m) => m.data)),
      );
      const first = pushesFor(seeded.launch.askId)[0];
      check(
        'push ведёт на задачу и вопрос, наружу — только заголовок задачи',
        first?.data?.kind === 'core-ask' &&
          first?.data?.taskId === seeded.launch.taskId &&
          first?.title === 'Ядро ждёт ответа' &&
          first?.body === 'Push: launch',
        JSON.stringify(first),
      );

      const scenarioAsk = seeded.scenario.askId;
      const parked = await until(() =>
        readState()?.pending?.find((item) => item.askId === scenarioAsk),
      );
      check(
        'неблокирующий вопрос — без push, ждёт в pending с waits:false',
        pushesFor(scenarioAsk).length === 0 && parked?.waits === false,
        JSON.stringify({ pending: readState()?.pending, pushes: pushesFor(scenarioAsk).length }),
      );

      await stand.restartHard();
      // Несколько кругов пересылки после перезапуска: поток перечитан, pending перепробован.
      await wait(10_000);
      check(
        'после жёсткого перезапуска — по-прежнему ровно один push на блокирующий вопрос',
        blocking.every((askId) => pushesFor(askId).length === 1),
        JSON.stringify(blocking.map((askId) => pushesFor(askId).length)),
      );
      check(
        'неблокирующий вопрос и после перезапуска без push',
        pushesFor(scenarioAsk).length === 0,
        `push о нём: ${pushesFor(scenarioAsk).length}`,
      );
      check(
        'других push не было (ни «готово», ни «упало»)',
        received.every((m) => m.data?.kind === 'core-ask'),
        JSON.stringify(received.map((m) => m.data?.kind)),
      );
    },
  );
} finally {
  expo.close();
}
