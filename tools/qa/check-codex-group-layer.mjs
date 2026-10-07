/**
 * Группа из файлов Claude в чате Codex — настоящим codex через настоящую панель.
 *
 * Codex каталогов Claude не читает, поэтому группа едет накладкой на прогон
 * (`domains/groups/codex-layer.ts`): правила — в `developer_instructions` после
 * собственного текста человека, скилл — корнем `skills/extraRoots/set`, MCP —
 * `-c mcp_servers.…` с секретом ТОЛЬКО в окружении (по имени через `env_vars`),
 * хук `UserPromptSubmit` — надзирателем панели. Сценарии:
 *   1. контроль — разговор без группы: ни правила у модели, ни MCP-сервера,
 *      ни хука группы;
 *   2. разговор с выбранной группой: всё это есть, секрет дошёл до MCP-сервера
 *      и отсутствует в командной строке codex, группа в Claude выключена,
 *      `config.toml` Codex и `.claude.json` не тронуты.
 *
 * Свидетели — тело запроса к заглушке модели, файлы-метки MCP-сервера и хука и
 * командные строки процессов codex, снятые, пока модель держит ответ. Подменена
 * только модель (сетевая граница). CLI — из `STEER_CLI_DIR`, иначе из PATH;
 * нет его — «не проверено», код 2. Дома CLI и панели — временные каталоги.
 *
 * Запуск: node tools/qa/check-codex-group-layer.mjs
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { NotChecked, reporter, startStand, wait } from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const tag = Math.random().toString(36).slice(2, 8);
const RULE_MARK = `GROUP_RULE_${tag}`;
const OWN_MARK = `USER_OWN_${tag}`;
const SECRET = `grp-secret-${tag}-9931`;
const HOLD_MS = 4000;
const fwd = (path) => path.replace(/\\/g, '/');

function findCli() {
  const names = IS_WIN ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/** Командные строки всех процессов — чтобы увидеть, что ушло в argv codex. */
function commandLines() {
  if (IS_WIN) {
    return execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  }
  return execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Заглушка OpenAI responses: тело копится, ответ «OK» после паузы (снимок argv). */
function startModel() {
  const bodies = [];
  let onHold;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      if (!/\/responses/.test(req.url ?? '')) return void res.writeHead(404).end();
      bodies.push(raw);
      await onHold?.();
      await wait(HOLD_MS);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const resp = {
        id: 'r1',
        object: 'response',
        model: 'stub-model',
        status: 'in_progress',
        output: [],
      };
      const item = {
        type: 'message',
        id: 'm1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'OK', annotations: [] }],
      };
      send('response.created', { type: 'response.created', response: resp });
      send('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, content: [] },
      });
      send('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: 'm1',
        output_index: 0,
        content_index: 0,
        delta: 'OK',
      });
      send('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item,
      });
      send('response.completed', {
        type: 'response.completed',
        response: {
          ...resp,
          status: 'completed',
          output: [item],
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            total_tokens: 11,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      });
      res.end();
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({
        port: server.address().port,
        bodies,
        setHold: (fn) => (onHold = fn),
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      }),
    ),
  );
}

// MCP-сервер группы: пишет метку с тем, что получил в окружении, и отвечает на рукопожатие.
const MCP_SRC = `
const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify({secret:process.env.GRP_SECRET??null}));
let buf='';process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;const m=JSON.parse(line);
const reply=r=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:r})+'\\n');
if(m.method==='initialize')reply({protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'grp',version:'1'}});
else if(m.method==='tools/list')reply({tools:[{name:'group_ping_${tag}',description:'ping',inputSchema:{type:'object',properties:{}}}]});
else if(m.id!==undefined)reply({});}});
`;
const HOOK_SRC = `
const fs=require('fs');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>fs.writeFileSync(process.argv[2],s||'fired'));
`;

const { check, finish } = reporter();
const cliDir = findCli();
if (!cliDir) {
  console.log('Не проверено: codex нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}

const model = await startModel();
const root = mkdtempSync(join(tmpdir(), 'cc-codex-group-'));
const marks = join(root, 'marks');
mkdirSync(marks, { recursive: true });
const codexHome = join(root, 'codex-home');
mkdirSync(codexHome, { recursive: true });
const configToml = [
  'model_provider = "stub"',
  'model = "stub-model"',
  `developer_instructions = "${OWN_MARK}: answer briefly."`,
  '[model_providers.stub]',
  'name = "stub"',
  `base_url = "http://127.0.0.1:${model.port}/v1"`,
  'wire_api = "responses"',
  'env_key = "STUB_KEY"',
  '',
].join('\n');
writeFileSync(join(codexHome, 'config.toml'), configToml);
Object.assign(process.env, { CODEX_HOME: codexHome, STUB_KEY: 'x' });

let stand;
try {
  stand = await startStand({
    label: 'codex-group',
    settings: { provider: 'codex' },
    web: false,
    extraPath: [cliDir],
    seed: ({ cfg }) => {
      mkdirSync(join(cfg, 'skills', `ladder-${tag}`), { recursive: true });
      writeFileSync(
        join(cfg, 'skills', `ladder-${tag}`, 'SKILL.md'),
        `---\nname: ladder-${tag}\ndescription: Review in rounds\n---\n\nDo two rounds.\n`,
      );
      writeFileSync(join(cfg, 'CLAUDE.md'), `## ПРАВИЛО: Group rule\n\n${RULE_MARK}: one word.\n`);
      writeFileSync(join(root, 'mcp.cjs'), MCP_SRC);
      writeFileSync(join(root, 'hook.cjs'), HOOK_SRC);
      writeFileSync(
        join(cfg, '.claude.json'),
        JSON.stringify({
          mcpServersDisabled: {
            grp: {
              command: process.execPath,
              args: [fwd(join(root, 'mcp.cjs')), fwd(join(marks, 'mcp.mark'))],
              env: { GRP_SECRET: SECRET },
            },
          },
        }),
      );
      writeFileSync(
        join(cfg, 'settings.json'),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `"${fwd(process.execPath)}" "${fwd(join(root, 'hook.cjs'))}" "${fwd(join(marks, 'hook.mark'))}"`,
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
    const body = (await stand.api(path)).body;
    return Array.isArray(body) ? body : (body?.items ?? body?.rules ?? body?.hooks ?? []);
  };
  const rule = (await list('/rules')).find((item) => item.title === 'Group rule');
  const hook = (await list('/hooks')).find((item) => item.event === 'UserPromptSubmit');
  check('правило и хук Claude прочитаны панелью', Boolean(rule && hook), `${rule?.id} ${hook?.id}`);

  const created = await stand.api('/groups', {
    method: 'POST',
    body: {
      name: 'Codex layer probe',
      isEnabled: false,
      members: [
        { kind: 'skill', id: `ladder-${tag}` },
        { kind: 'rule', id: rule?.id },
        { kind: 'hook', id: hook?.id },
        { kind: 'mcp', id: 'grp' },
      ],
    },
  });
  const group = created.body;
  check('группа заведена', created.status === 200 && Boolean(group?.id), created.text);
  const claudeJson = () => readFileSync(join(stand.cfg, '.claude.json'), 'utf8');
  const sleeping = claudeJson();

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
    if (groupChoice) {
      const set = await stand.api(`/chat/${encodeURIComponent(`codex:${id}`)}/group-settings`, {
        method: 'PUT',
        body: { groupChoice },
      });
      check('выбор группы записан разговору', set.status === 200, set.text);
    }
    let argv = '';
    model.setHold(async () => {
      if (!argv) argv = commandLines();
    });
    const from = model.bodies.length;
    const sent = await stand.api(`/provider-chat/chats/${id}/send`, {
      method: 'POST',
      body: { text: 'Привет' },
    });
    check('вопрос принят', sent.status === 200, sent.text);
    let status;
    for (let i = 0; i < 480; i += 1) {
      status = (await stand.api(`/provider-chat/chats/${id}/status`)).body;
      if (status?.isRunning === false && model.bodies.length > from) break;
      await wait(250);
    }
    await wait(500);
    const messages = (await stand.api(`/provider-chat/chats/${id}`)).body?.messages ?? [];
    return { body: model.bodies.slice(from).join('\n'), argv, messages };
  };

  console.log('1. Контроль: разговор Codex без группы');
  const bare = await ask(project('bare'));
  check('запрос дошёл до модели', bare.body.length > 0);
  check('свой текст человека у модели есть', bare.body.includes(OWN_MARK));
  check('текста правила группы у модели нет', !bare.body.includes(RULE_MARK));
  check('MCP-сервер группы не запускался', !existsSync(join(marks, 'mcp.mark')));
  check('хук группы не срабатывал', !existsSync(join(marks, 'hook.mark')));

  console.log('\n2. Разговор Codex с группой из файлов Claude');
  const layered = await ask(project('layered'), `global:${group?.id}`);
  const body = layered.body;
  check('запрос дошёл до модели', body.length > 0);
  check(
    'правило группы у модели — после своего текста человека',
    body.includes(RULE_MARK) && body.indexOf(OWN_MARK) < body.indexOf(RULE_MARK),
    body.match(/.{0,120}GROUP_RULE.{0,40}/)?.[0],
  );
  check('скилл группы виден модели', body.includes(`ladder-${tag}`));
  check('инструмент MCP группы в запросе к модели', body.includes(`group_ping_${tag}`));
  const mark = existsSync(join(marks, 'mcp.mark'))
    ? JSON.parse(readFileSync(join(marks, 'mcp.mark'), 'utf8'))
    : undefined;
  check('MCP-сервер группы получил секрет по имени', mark?.secret === SECRET, JSON.stringify(mark));
  check('хук UserPromptSubmit группы сыгран надзирателем', existsSync(join(marks, 'hook.mark')));
  check(
    'снимок командных строк видит запуск codex с MCP группы (снимок не пустой)',
    layered.argv.includes('mcp_servers.grp='),
    layered.argv.length,
  );
  check('секрета нет ни в одной командной строке', !layered.argv.includes(SECRET));
  check(
    'заметка о группе в ленте',
    layered.messages.some(
      (item) => item.role === 'notice' && item.content.includes('Codex layer probe'),
    ),
    JSON.stringify(layered.messages.map((item) => item.role)),
  );
  const after = (await stand.api('/groups')).body;
  const stored = (Array.isArray(after) ? after : (after?.groups ?? [])).find(
    (item) => item.id === group?.id,
  );
  check(
    'группа в Claude осталась выключенной',
    stored?.isEnabled === false,
    JSON.stringify(stored),
  );
  check('файлы Claude прогоном не тронуты (.claude.json тот же)', claudeJson() === sleeping);
  check(
    'config.toml Codex не тронут',
    readFileSync(join(codexHome, 'config.toml'), 'utf8') === configToml,
  );
  // Каталог слоя — где бы ни лежали данные одноразовой панели: ищем по всему её корню.
  const overlays = readdirSync(stand.root, { recursive: true })
    .map(String)
    .filter((path) => /codex-group-layers[\\/][^\\/]+[\\/]overlay\.json$/.test(path))
    .map((path) => join(stand.root, path));
  check(
    'файл слоя есть, секрета в нём нет',
    overlays.length > 0 && overlays.every((file) => !readFileSync(file, 'utf8').includes(SECRET)),
    overlays.join(', ') || 'файлов слоя нет',
  );
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
  await model.close();
}
if (process.exitCode !== 2) finish();
