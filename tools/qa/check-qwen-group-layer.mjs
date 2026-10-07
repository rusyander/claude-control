/**
 * Группа из файлов Claude в чате Qwen Code — настоящим qwen через настоящую панель.
 *
 * Qwen каталогов Claude не читает, поэтому «включить группу» для его разговора
 * ничего не давало. Теперь группа едет слоем на прогон: файл системных настроек
 * (`QWEN_CODE_SYSTEM_SETTINGS_PATH`) с её MCP-серверами и хуками и `QWEN.md`
 * с правилами и перечнем скиллов. Сценарии:
 *   1. контроль — разговор без группы: ни текста правила у модели, ни запуска
 *      MCP-сервера, ни срабатывания хука группы;
 *   2. разговор с выбранной группой: текст правила и перечень скиллов в запросе
 *      к модели, MCP-сервер группы запущен, хук SessionStart сработал, а сама
 *      группа в Claude осталась выключенной и `~/.qwen` не появился;
 *   3. выбранная группа плюс привязанная к папке проекта: правила обеих и
 *      «числа» скилла у модели, заметка в ленте называет обе группы и отказ по
 *      разрешению, тайм-аут хука группы соблюдён (хук начат, но до конца не
 *      дожил); второе сообщение заметку не повторяет;
 *   4. ребёнок разделения из разговора с группой: правило и «числа» родителя.
 *
 * Свидетели — тело запроса, дошедшего до заглушки модели, и файлы-метки,
 * которые пишут сами MCP-сервер и хук. Подменена только модель (сетевая
 * граница); панель, служба чата, сборка слоя и CLI — настоящие. CLI — из
 * `STEER_CLI_DIR` (каталоги через разделитель PATH), иначе из PATH; нет его —
 * «не проверено», код 2. Дом CLI и панели — временные каталоги.
 *
 * Запуск: node tools/qa/check-qwen-group-layer.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { NotChecked, reporter, startStand, wait } from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const RULE_MARK = 'GROUP_RULE_4417';
const BOUND_MARK = 'BOUND_RULE_5521';
const KNOB_LINE = 'ladder — Review rounds: 4 (skill default 2)';
// Запись перечня скиллов qwen в теле запроса (JSON — перевод строки экранирован).
const SKILL_ENTRY = '<name>\\nladder\\n</name>\\n<description>\\nReview in rounds';
const fwd = (path) => path.replace(/\\/g, '/');

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

const MCP_SRC = `
const fs=require('fs');fs.writeFileSync(process.argv[2],'started');
let buf='';process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;const m=JSON.parse(line);
const reply=r=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:r})+'\\n');
if(m.method==='initialize')reply({protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'grp',version:'1'}});
else if(m.method==='tools/list')reply({tools:[{name:'group_ping',description:'ping',inputSchema:{type:'object',properties:{}}}]});
else if(m.id!==undefined)reply({});}});
`;
const HOOK_SRC = `
const fs=require('fs');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>fs.writeFileSync(process.argv[2],s||'fired'));
`;

// Хук с тайм-аутом 2 с: метка начала сразу, метка конца — через 6 с. Конца
// быть не должно: CLI обязан погасить хук по тайм-ауту группы.
const SLOW_SRC = `
const fs=require('fs');fs.writeFileSync(process.argv[2]+'.start','1');process.stdin.resume();
setTimeout(()=>{fs.writeFileSync(process.argv[2],'late');process.exit(0);},6000);
`;
const SKILL_TEXT =
  '---\nname: ladder\ndescription: Review in rounds\n---\n\nRun 2 review rounds.\n';

/** Хэш каталога скилла — как у панели (`hashDir`): выписка «чисел» свежая, модель не зовётся. */
function skillHash(text) {
  const hash = createHash('sha256');
  hash.update('SKILL.md');
  hash.update('\0');
  hash.update(Buffer.from(text, 'utf8'));
  hash.update('\0');
  return hash.digest('hex').slice(0, 16);
}

const { check, finish } = reporter();
const cliDir = findCli();
if (!cliDir) {
  console.log('Не проверено: qwen нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}

const model = await startModel();
const root = mkdtempSync(join(tmpdir(), 'cc-qwen-group-'));
const marks = join(root, 'marks');
mkdirSync(marks, { recursive: true });
const qwenHome = join(root, 'qwen-home');
mkdirSync(qwenHome, { recursive: true });
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
    label: 'qwen-group',
    settings: { provider: 'qwen' },
    web: false,
    extraPath: [cliDir],
    seed: ({ cfg }) => {
      mkdirSync(join(cfg, 'skills', 'ladder'), { recursive: true });
      writeFileSync(join(cfg, 'skills', 'ladder', 'SKILL.md'), SKILL_TEXT);
      writeFileSync(
        join(cfg, 'CLAUDE.md'),
        `## ПРАВИЛО: Group rule\n\n${RULE_MARK}: answer in one word.\n\n` +
          `## ПРАВИЛО: Bound rule\n\n${BOUND_MARK}: mention the project.\n`,
      );
      // Выписка «чисел» скилла — готовая: иначе панель позвала бы модель.
      writeFileSync(
        join(cfg, 'agentdeck', 'skill-knobs.json'),
        JSON.stringify({
          'global|skill:ladder': {
            hash: skillHash(SKILL_TEXT),
            v: 3,
            knobs: [
              {
                key: 'review-rounds',
                skillId: 'ladder',
                label: { ru: 'Круги ревью', en: 'Review rounds' },
                default: 2,
                min: 1,
                max: 5,
                quote: 'Run 2 review rounds.',
              },
            ],
          },
        }),
      );
      writeFileSync(join(root, 'slow.cjs'), SLOW_SRC);
      writeFileSync(join(root, 'mcp.cjs'), MCP_SRC);
      writeFileSync(join(root, 'hook.cjs'), HOOK_SRC);
      writeFileSync(
        join(cfg, '.claude.json'),
        JSON.stringify({
          mcpServersDisabled: {
            grp: {
              command: process.execPath,
              args: [fwd(join(root, 'mcp.cjs')), fwd(join(marks, 'mcp.mark'))],
            },
          },
        }),
      );
      writeFileSync(
        join(cfg, 'settings.json'),
        JSON.stringify({
          permissions: { allow: ['Bash(git:*)'] },
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `"${fwd(process.execPath)}" "${fwd(join(root, 'hook.cjs'))}" "${fwd(join(marks, 'hook.mark'))}"`,
                  },
                ],
              },
              {
                hooks: [
                  {
                    type: 'command',
                    command: `"${fwd(process.execPath)}" "${fwd(join(root, 'slow.cjs'))}" "${fwd(join(marks, 'slow.mark'))}"`,
                    timeout: 2,
                  },
                ],
              },
            ],
          },
        }),
      );
    },
  });
  console.log(`Одноразовая панель ${stand.apiUrl}\n`);

  const list = async (path) => {
    const answer = await stand.api(path);
    const body = answer.body;
    return Array.isArray(body) ? body : (body?.items ?? body?.rules ?? body?.hooks ?? []);
  };
  const rule = (await list('/rules')).find((item) => item.title === 'Group rule');
  const boundRule = (await list('/rules')).find((item) => item.title === 'Bound rule');
  const hooks = await list('/hooks');
  const hook = hooks.find((item) => JSON.stringify(item).includes('hook.cjs'));
  const slowHook = hooks.find((item) => JSON.stringify(item).includes('slow.cjs'));
  check(
    'второе правило и медленный хук прочитаны панелью',
    Boolean(boundRule && slowHook),
    `${boundRule?.id} ${slowHook?.id}`,
  );
  check('правило и хук Claude прочитаны панелью', Boolean(rule && hook), `${rule?.id} ${hook?.id}`);

  const created = await stand.api('/groups', {
    method: 'POST',
    body: {
      name: 'Qwen layer probe',
      // Выключенная: её участники уходят из каталогов Claude в «спящие», и
      // старый путь (включить группу в Claude к прогону) их бы вернул.
      isEnabled: false,
      members: [
        { kind: 'skill', id: 'ladder' },
        { kind: 'rule', id: rule?.id },
        { kind: 'hook', id: hook?.id },
        { kind: 'mcp', id: 'grp' },
      ],
    },
  });
  const group = created.body;
  check('группа заведена', created.status === 200 && Boolean(group?.id), created.text);
  const knobs = await stand.api(`/groups/${group?.id}/knobs`, {
    method: 'PUT',
    body: { values: { 'ladder:review-rounds': 4 } },
  });
  check('«числа» скилла закреплены группе', knobs.status === 200, knobs.text);
  const claudeJson = () => readFileSync(join(stand.cfg, '.claude.json'), 'utf8');
  const sleeping = claudeJson();
  check(
    'MCP-сервер группы в Claude выключен (до прогона)',
    Boolean(JSON.parse(sleeping).mcpServersDisabled?.grp),
    sleeping,
  );

  const project = (name) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const ask = async (dir, groupChoice) => {
    const chat = await stand.api('/provider-chat/chats', {
      method: 'POST',
      body: { workdir: dir },
    });
    if (chat.status !== 200) throw new Error(`разговор не создан: ${chat.text}`);
    const id = chat.body.id;
    ask.lastId = id;
    if (groupChoice) {
      const set = await stand.api(`/chat/${encodeURIComponent(`qwen:${id}`)}/group-settings`, {
        method: 'PUT',
        body: { groupChoice },
      });
      check('выбор группы записан разговору', set.status === 200, set.text);
    }
    return sendTo(id);
  };
  const sendTo = async (id) => {
    const from = model.bodies.length;
    const sent = await stand.api(`/provider-chat/chats/${id}/send`, {
      method: 'POST',
      body: { text: 'Привет' },
    });
    check('вопрос принят', sent.status === 200, sent.text);
    for (let i = 0; i < 480; i += 1) {
      const status = (await stand.api(`/provider-chat/chats/${id}/status`)).body;
      if (status?.isRunning === false && model.bodies.length > from) break;
      await wait(250);
    }
    await wait(500);
    return model.bodies.slice(from).join('\n');
  };

  console.log('1. Контроль: разговор Qwen без группы');
  const bare = await ask(project('bare'));
  check('запрос дошёл до модели', bare.length > 0);
  check('текста правила группы у модели нет', !bare.includes(RULE_MARK));
  check('скилла группы в перечне qwen нет', !bare.includes(SKILL_ENTRY));
  check('MCP-сервер группы не запускался', !existsSync(join(marks, 'mcp.mark')));
  check('хук группы не срабатывал', !existsSync(join(marks, 'hook.mark')));

  console.log('\n2. Разговор Qwen с группой из файлов Claude');
  const layered = await ask(project('layered'), `global:${group?.id}`);
  check('запрос дошёл до модели', layered.length > 0);
  check('текст правила группы в запросе к модели', layered.includes(RULE_MARK));
  // Скилл — родным корнем `skills.directories`: qwen сам перечисляет его модели.
  check(
    'скилл группы в собственном перечне скиллов qwen',
    layered.includes(SKILL_ENTRY),
    layered.match(/.{0,80}ladder.{0,160}/)?.[0],
  );
  check('MCP-сервер группы запущен qwen', existsSync(join(marks, 'mcp.mark')));
  check('хук SessionStart группы сработал', existsSync(join(marks, 'hook.mark')));
  const after = (await stand.api('/groups')).body;
  const stored = (Array.isArray(after) ? after : (after?.groups ?? [])).find(
    (item) => item.id === group?.id,
  );
  check(
    'группа в Claude осталась выключенной',
    stored?.isEnabled === false,
    JSON.stringify(stored),
  );
  check('каталоги Claude прогоном не тронуты (.claude.json тот же)', claudeJson() === sleeping);
  check(
    'настройки Qwen человека не тронуты (settings.json в QWEN_HOME нет)',
    !existsSync(join(qwenHome, 'settings.json')),
  );
  if (existsSync(join(marks, 'hook.mark'))) {
    console.log(`    stdin хука: ${readFileSync(join(marks, 'hook.mark'), 'utf8').slice(0, 160)}`);
  }
  check('«числа» выбранной группы в запросе к модели', layered.includes(KNOB_LINE));
  check('правила чужой группы у модели нет', !layered.includes(BOUND_MARK));
  const layeredId = ask.lastId;

  console.log('\n3. Выбранная группа плюс привязанная к папке проекта');
  const boundDir = project('bound');
  const bound = await stand.api('/groups', {
    method: 'POST',
    body: {
      name: 'Bound probe',
      isEnabled: false,
      projectPaths: [boundDir],
      members: [
        { kind: 'rule', id: boundRule?.id },
        { kind: 'hook', id: slowHook?.id },
        { kind: 'permission', id: 'Bash(git:*)' },
      ],
    },
  });
  check('привязанная группа заведена', bound.status === 200, bound.text);
  const sentAt = Date.now();
  const both = await ask(boundDir, `global:${group?.id}`);
  const bothId = ask.lastId;
  check('правило выбранной группы у модели', both.includes(RULE_MARK));
  check('правило привязанной группы у модели', both.includes(BOUND_MARK));
  check('«числа» выбранной группы у модели', both.includes(KNOB_LINE));
  const notices = async (id) =>
    ((await stand.api(`/provider-chat/chats/${id}`)).body?.messages ?? []).filter(
      (item) => item.role === 'notice' && item.content.startsWith('Группы на этом прогоне'),
    );
  const first = await notices(bothId);
  const text = first[0]?.content ?? '';
  check('заметка о группах в ленте — одна', first.length === 1, JSON.stringify(first));
  check(
    'заметка называет обе группы',
    text.includes('«Qwen layer probe»') && text.includes('«Bound probe»'),
    text,
  );
  check(
    'заметка называет отказ по разрешению',
    text.includes('Не едет:') && text.includes('Разрешения группы в'),
    text,
  );
  check('медленный хук группы начат', existsSync(join(marks, 'slow.mark.start')));
  await wait(Math.max(0, sentAt + 9000 - Date.now()));
  check(
    'тайм-аут хука соблюдён: хук погашен до конца (6 с при тайм-ауте 2 с)',
    !existsSync(join(marks, 'slow.mark')),
  );
  const again = await sendTo(bothId);
  check('второе сообщение дошло до модели', again.length > 0);
  check('второе сообщение заметку не повторяет', (await notices(bothId)).length === 1);

  console.log('\n4. Ребёнок разделения из разговора с группой');
  // Уровни выключены: иначе первым идёт прогон разбора пересечений, а не дети.
  const cascade = await stand.api('/chat/cascade', {
    method: 'PUT',
    body: { path: project('layered'), enabled: false },
  });
  check('уровни для папки выключены', cascade.status === 200, cascade.text);
  const from = model.bodies.length;
  const split = await stand.api('/chat/split', {
    method: 'POST',
    body: {
      projectPath: project('layered'),
      proposal: {
        groups: [
          { title: 'Звено A', branch: 'split/a', tasks: ['Проверь сборку'], kind: 'design' },
          { title: 'Звено B', branch: 'split/b', tasks: ['Проверь тесты'], kind: 'design' },
        ],
      },
      startRuns: true,
      parentChatId: layeredId,
    },
  });
  check('разделение запущено', split.status === 200, split.text);
  for (let i = 0; i < 480 && model.bodies.length < from + 2; i += 1) await wait(250);
  await wait(1500);
  const children = model.bodies.slice(from);
  check(
    'запросы обоих детей дошли до модели',
    children.some((body) => body.includes('Проверь сборку')) &&
      children.some((body) => body.includes('Проверь тесты')),
    split.text,
  );
  for (const [index, body] of children.slice(0, 2).entries()) {
    check(`правило группы родителя у ребёнка ${index + 1}`, body.includes(RULE_MARK));
    check(
      `«числа» группы родителя у ребёнка ${index + 1}`,
      body.includes(KNOB_LINE),
      body.match(/.{0,400}Проверь (сборку|тесты)/)?.[0],
    );
  }
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
