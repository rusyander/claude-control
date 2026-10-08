/**
 * Шаги «Пути» группы у звена Qwen Code — настоящим qwen через настоящую панель.
 *
 * У Claude свой шаг группы после стадии идёт отдельным ходом той же сессии, и
 * только потом конвейер заводит ревью. Каскад чужого CLI шагов не знал: звено
 * Qwen с такой группой уходило на ревью без них. Сценарии:
 *   1. контроль — звено без выбранной группы: после работы сразу ревью, хода
 *      шага нет;
 *   2. звено с группой, у которой после работы стоит шаг: второй запрос к
 *      модели — задание шага в ТОМ ЖЕ разговоре, в ленте строка о шаге, ревью
 *      заводится только после ответа на шаг.
 *
 * Связь звена, группа и выбор группы пишутся тем же `AppStore`, что у панели,
 * до её старта (разделение, которое пишет их в жизни, требует разбора моделью).
 * Подменена только модель (сетевая граница): панель, служба чата, планировщик
 * каскада и CLI — настоящие. CLI — из `STEER_CLI_DIR`, иначе из PATH; нет его —
 * «не проверено», код 2.
 *
 * Запуск: node tools/qa/check-qwen-path-steps.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NotChecked, REPO, reporter, startStand, wait } from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const NOW = '2026-10-07T10:00:00.000Z';

function findCli() {
  const names = IS_WIN ? ['qwen.cmd', 'qwen.exe', 'qwen'] : ['qwen'];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/** Заглушка OpenAI chat: каждый запрос запоминается целиком, ответ — «DONE». */
async function startModel() {
  const bodies = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) return void res.writeHead(404).end();
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const head = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'stub-model' };
      const send = (choice, usage) =>
        res.write(
          `data: ${JSON.stringify({ ...head, choices: [choice], ...(usage ? { usage } : {}) })}\n\n`,
        );
      send({ index: 0, delta: { role: 'assistant', content: 'DONE' } });
      send(
        { index: 0, delta: {}, finish_reason: 'stop' },
        { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      );
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { base: `http://127.0.0.1:${server.address().port}`, bodies, close: () => server.close() };
}

/** Звенья работы, группа с шагом после работы и выбор группы — хранилищем панели. */
function seedState(root, appData, projects) {
  const url = (path) => JSON.stringify(pathToFileURL(join(REPO, path)).href);
  const chat = (id, workdir) => `
createChat(${JSON.stringify(appData)}, 'qwen', { id: '${id}', title: 'Переименование', workdir: ${JSON.stringify(workdir)},
  cascade: { stage: 'work', group: 'Переименование', branch: 'split/rename', kind: 'mechanical', lowered: true, workModel: 'stub-model' } });
store.setChatLink('qwen:${id}', { parentChatId: 'qwen:parent', title: 'Переименование', branch: 'split/rename', createdAt: '${NOW}', conversation: 'qwen:${id}' });`;
  const script = join(root, 'seed-state.ts');
  writeFileSync(
    script,
    `import { AppStore } from ${url('apps/server/src/lib/app-store/app-store.ts')};
import { createChat } from ${url('apps/server/src/domains/provider-chat/store/store.ts')};
const store = new AppStore(${JSON.stringify(appData)});
store.saveGroup({ id: 'g', name: 'Путь с шагом', description: '', color: 'accent', icon: 'folder', members: [], env: {},
  projectPaths: [], isEnabled: false, order: 0, path: { steps: [{ id: 's1', anchor: 'work', order: 0, kind: 'prompt',
  title: { ru: 'Сверка', en: 'Cross-check' }, prompt: { ru: 'Сверь PATH_STEP_7731', en: 'Cross-check PATH_STEP_7731' },
  source: 'en', createdAt: '${NOW}' }] } });
${chat('bare', projects.bare)}
${chat('pathed', projects.pathed)}
store.setChatGroupSettings('qwen:pathed', { groupChoice: 'global:g' });
`,
  );
  const done = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', script],
    {
      encoding: 'utf8',
    },
  );
  if (done.status !== 0) throw new Error(`состояние не записано: ${done.stderr}`);
}

const { check, finish } = reporter();
const cliDir = findCli();
if (!cliDir) {
  console.log('Не проверено: qwen нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}

const model = await startModel();
const root = mkdtempSync(join(tmpdir(), 'cc-qwen-path-'));
const qwenHome = join(root, 'qwen-home');
// Имена каталогов уникальны: qwen называет рабочий каталог в каждом запросе,
// и по ним запросы делятся между звеньями — ревью контроля идёт и во время второго.
const projects = { bare: join(root, 'proj-bare-9101'), pathed: join(root, 'proj-pathed-9202') };
for (const dir of [qwenHome, ...Object.values(projects)]) mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  QWEN_HOME: qwenHome,
  OPENAI_BASE_URL: `${model.base}/v1`,
  OPENAI_API_KEY: 'x',
  OPENAI_MODEL: 'stub-model',
  QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
});

let stand;
try {
  stand = await startStand({
    label: 'qwen-path',
    settings: { provider: 'qwen' },
    web: false,
    extraPath: [cliDir],
    seed: ({ cfg }) => seedState(root, join(cfg, 'agentdeck'), projects),
  });
  console.log(`Одноразовая панель ${stand.apiUrl}\n`);

  const list = async () => (await stand.api('/provider-chat/chats')).body ?? [];
  const reviewFor = async (dir) =>
    (await list()).find((chat) => chat.workdir === dir && /ревью/.test(chat.title ?? ''));
  /** Отправить вопрос звену и ждать, пока у его копии не появится ревью. */
  const run = async (id, dir) => {
    const from = model.bodies.length;
    const sent = await stand.api(`/provider-chat/chats/${id}/send`, {
      method: 'POST',
      body: { text: 'Переименуй foo в bar' },
    });
    check(`вопрос звену «${id}» принят`, sent.status === 200, sent.text);
    // Конец сценария — запрос РЕВЬЮ этого звена у модели (каталог называет qwen).
    const tag = basename(dir);
    const reviewed = () =>
      model.bodies
        .slice(from)
        .some((body) => body.includes(tag) && body.includes('agentdeck:review'));
    for (let i = 0; i < 600 && !reviewed(); i += 1) await wait(250);
    await wait(500);
    return model.bodies.slice(from);
  };
  const notices = async (id) =>
    ((await stand.api(`/provider-chat/chats/${id}`)).body?.messages ?? [])
      .filter((message) => message.role === 'notice')
      .map((message) => message.content);

  console.log('1. Контроль: звено Qwen без группы');
  const bare = await run('bare', projects.bare);
  check('ревью заведено', Boolean(await reviewFor(projects.bare)));
  check('задания шага у модели не было', !bare.some((body) => body.includes('PATH_STEP_7731')));
  check('строки о шаге в ленте нет', !(await notices('bare')).some((n) => n.includes('Сверка')));

  console.log('\n2. Звено Qwen с группой, у которой после работы стоит шаг');
  const pathed = await run('pathed', projects.pathed);
  // Свои запросы звена: работа (первая), шаг, ревью — по рабочему каталогу.
  const own = pathed.filter((body) => body.includes('proj-pathed-9202'));
  const stepAt = own.findIndex((body) => body.includes('PATH_STEP_7731'));
  const reviewAt = own.findIndex((body) => body.includes('agentdeck:review'));
  check('задание шага дошло до модели', stepAt >= 0, `запросов звена: ${own.length}`);
  check('шаг — после работы', stepAt > 0, `индекс ${stepAt}`);
  check('ревью — после шага', stepAt >= 0 && reviewAt > stepAt, `шаг ${stepAt}, ревью ${reviewAt}`);
  const stepBody = stepAt >= 0 ? own[stepAt] : '';
  check(
    'шаг шёл в том же разговоре (в запросе есть ответ работы)',
    stepBody.includes('Переименуй foo в bar'),
  );
  check(
    'в ленте звена строка о шаге',
    (await notices('pathed')).includes('Шаг пути группы «Сверка» идёт в этом чате.'),
    JSON.stringify(await notices('pathed')),
  );
  const review = await reviewFor(projects.pathed);
  check('ревью заведено после шага', Boolean(review));
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`Не проверено: ${error.message}`);
    process.exitCode = 2;
  } else {
    check('сценарий дошёл до конца', false, error instanceof Error ? error.stack : String(error));
  }
} finally {
  await stand?.stop();
  // Корень прогона (проект, домашний каталог CLI) — иначе он копился в temp.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // Держит ещё не вышедший CLI — на вердикт проверки это не влияет.
  }
  model.close();
}
if (process.exitCode !== 2) finish();
