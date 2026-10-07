/**
 * Набор панели в настоящем Codex (наложение на запуск, владелец 06.10.2026) —
 * через настоящую панель, без подмены дома Codex.
 *
 * Одноразовый стенд (`throwaway-stand.mjs`) с провайдером Codex; Codex — настоящий
 * `codex app-server` из `STEER_CLI_DIR`, потом PATH. Его дом — временный
 * `CODEX_HOME`, в `config.toml` — заглушка модели (OpenAI responses) и СОБСТВЕННЫЕ
 * `developer_instructions` с меткой. В правило и навык набора метки пишутся через
 * API панели (`PUT /api/kit/item`) — так, как их правит человек.
 *
 * Свидетель — тело запроса, ушедшего к модели:
 *   «Ваши и набор панели»  → в нём метка правила набора, метка навыка набора
 *                            (навык виден Codex как навык) И метка человека;
 *   «Только ваши» (контроль) → метка человека есть, меток набора нет — иначе
 *                            первая половина ничего не доказывает.
 * И в обоих прогонах `config.toml` побайтно тот же, в доме Codex не появилось
 * ни навыков, ни правил набора.
 *
 * Подменена только модель (сетевая граница). Нет codex — «не проверено», код 2.
 * Настоящие `~/.codex`, `~/.agents` и `~/.claude` не пишутся.
 *
 * Запуск: STEER_CLI_DIR=<каталог с codex> node tools/qa/check-codex-kit.mjs
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { startStand, wait } from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const tag = Math.random().toString(36).slice(2, 8);
const OWN = `USER-OWN-${tag}`;
const RULE = `KIT-RULE-${tag}`;
const SKILL = `kit-skill-${tag}`;

let bad = 0;
const check = (text, ok, detail) => {
  console.log(
    `  ${ok ? '✓' : '✗'} ${text}${!ok && detail ? ` — ${String(detail).slice(0, 600)}` : ''}`,
  );
  if (!ok) bad += 1;
  return ok;
};

function findCli(name) {
  const names = IS_WIN ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/** Заглушка модели (OpenAI responses, поток): на любой запрос — текст «OK», тела копятся. */
function startModel() {
  const bodies = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!/\/responses/.test(req.url ?? '')) return void res.writeHead(404).end();
      bodies.push(raw);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const resp = {
        id: 'resp_1',
        object: 'response',
        model: 'stub-model',
        status: 'in_progress',
        output: [],
      };
      const item = {
        type: 'message',
        id: 'msg_1',
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
        item_id: 'msg_1',
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
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      }),
    ),
  );
}

async function until(probe, seconds) {
  for (let i = 0; i < seconds * 2; i += 1) {
    if (await probe()) return true;
    await wait(500);
  }
  return false;
}

const listFiles = (dir) => {
  const out = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else out.push(file.slice(dir.length));
    }
  };
  walk(dir);
  return out.sort();
};

/** Один прогон: стенд, метки в набор, режим, один вопрос в чат Codex. Тело запроса к модели. */
async function scenario(mode, cliDir) {
  console.log(`\n— режим «${mode}»`);
  const model = await startModel();
  const root = mkdtempSync(join(tmpdir(), `cc-codex-kit-${mode}-`));
  const home = join(root, 'codex-home');
  mkdirSync(home, { recursive: true });
  const config = [
    'model_provider = "stub"',
    'model = "stub-model"',
    `developer_instructions = "${OWN}: answer briefly."`,
    '[model_providers.stub]',
    'name = "stub"',
    `base_url = "http://127.0.0.1:${model.port}/v1"`,
    'wire_api = "responses"',
    'env_key = "STUB_KEY"',
    '',
  ].join('\n');
  writeFileSync(join(home, 'config.toml'), config);
  const saved = {
    CODEX_HOME: process.env.CODEX_HOME,
    STUB_KEY: process.env.STUB_KEY,
    PATH: process.env.PATH,
  };
  Object.assign(process.env, {
    CODEX_HOME: home,
    STUB_KEY: 'x',
    PATH: `${cliDir}${delimiter}${process.env.PATH ?? ''}`,
  });

  let stand;
  try {
    stand = await startStand({
      web: false,
      label: `codex-kit-${mode}`,
      settings: { provider: 'codex' },
    });
    const kit = (await stand.api('/kit')).body;
    const view = kit?.providers?.find((provider) => provider.id === 'codex');
    if (
      !check(
        'Codex в списке набора с режимом «Ваши и набор панели»',
        view?.modes?.includes('hybrid'),
        JSON.stringify(view),
      )
    )
      return;
    check(
      'у Codex сказано, что доезжает: правила и навыки',
      JSON.stringify(view.carries) === '["rule","skill"]',
      JSON.stringify(view.carries),
    );

    const rule = kit.items.find((item) => item.kind === 'rule' && item.enabled);
    const skill = kit.items.find((item) => item.kind === 'skill' && item.enabled);
    if (
      !check(
        'в наборе есть включённые правило и навык',
        rule && skill,
        JSON.stringify(kit.items.map((i) => i.id)),
      )
    )
      return;
    const ruleText =
      (await stand.api(`/kit/item?id=${encodeURIComponent(rule.id)}`)).body?.content ?? '';
    const put = await stand.api('/kit/item', {
      method: 'PUT',
      body: { id: rule.id, content: `${ruleText}\n- ${RULE}: obey the panel kit.\n` },
    });
    check('метка записана в правило набора', put.status === 200, put.text);
    const skillText = [
      '---',
      `name: ${SKILL}`,
      `description: "Marker skill ${SKILL} from the panel kit"`,
      '---',
      'Body of the marker skill.',
      '',
    ].join('\n');
    const putSkill = await stand.api('/kit/item', {
      method: 'PUT',
      body: { id: skill.id, content: skillText },
    });
    check('навык набора переписан под метку', putSkill.status === 200, putSkill.text);

    const set = await stand.api('/kit/mode', { method: 'PUT', body: { provider: 'codex', mode } });
    check(`режим набора у Codex — «${mode}»`, set.status === 200, set.text);

    const chat = await stand.api('/provider-chat/chats', { method: 'POST', body: {} });
    if (!check('разговор создан', chat.status === 200 && chat.body?.id, chat.text)) return;
    const id = chat.body.id;
    const sent = await stand.api(`/provider-chat/chats/${id}/send`, {
      method: 'POST',
      body: { text: 'Привет' },
    });
    if (!check('вопрос принят', sent.status === 200, sent.text)) return;
    const asked = await until(() => model.bodies.length > 0, 120);
    if (!check('Codex обратился к модели', asked, stand.log().slice(-1500))) return;
    await until(async () => {
      const messages = (await stand.api(`/provider-chat/chats/${id}`)).body?.messages ?? [];
      return messages.some(
        (message) => message.role === 'assistant' && /OK/.test(JSON.stringify(message)),
      );
    }, 60);

    const body = model.bodies.join('\n');
    check(
      'собственные инструкции человека дошли до модели',
      body.includes(OWN),
      body.slice(0, 400),
    );
    const kitOn = mode !== 'global';
    check(
      kitOn ? 'правило набора дошло до модели' : 'правила набора у модели нет',
      body.includes(RULE) === kitOn,
      `RULE в теле: ${body.includes(RULE)}`,
    );
    check(
      kitOn ? 'навык набора виден модели' : 'навыка набора у модели нет',
      body.includes(SKILL) === kitOn,
      `SKILL в теле: ${body.includes(SKILL)}`,
    );
    if (kitOn)
      check(
        'инструкции человека стоят перед правилами набора',
        body.indexOf(OWN) < body.indexOf(RULE),
        `${body.indexOf(OWN)} / ${body.indexOf(RULE)}`,
      );
  } finally {
    await stand?.stop?.();
    await model.close();
    Object.assign(process.env, saved);
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
    await wait(500);
    check(
      'config.toml Codex не изменён',
      readFileSync(join(home, 'config.toml'), 'utf8') === config,
    );
    // Codex сам пишет в свой дом (клон плагинов, миграции) — критерий не «ничего
    // нового», а «ни один файл дома не несёт метку набора».
    const marked = listFiles(home).filter((file) => {
      try {
        const text = readFileSync(join(home, file), 'utf8');
        return text.includes(RULE) || text.includes(SKILL);
      } catch {
        return false;
      }
    });
    check(
      'в дом Codex не легли ни навыки, ни правила набора',
      marked.length === 0,
      marked.join(' | '),
    );
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Codex на Windows ещё держит каталог — временная папка, ОС уберёт её сама.
    }
  }
}

const cliDir = findCli('codex');
if (!cliDir) {
  console.log('НЕ ПРОВЕРЕНО: codex не найден (STEER_CLI_DIR или PATH)');
  process.exit(2);
}
console.log(`codex: ${cliDir}`);
await scenario('hybrid', cliDir);
await scenario('global', cliDir);
console.log(bad === 0 ? '\nВсё сходится.' : `\nПровалов: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
