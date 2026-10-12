/**
 * Сессия чужого CLI между ходами разговора (E2b) — настоящими CLI, через настоящую панель.
 *
 * На каждый CLI с живым транспортом (Codex — `app-server`, Qwen — `serve`, Goose —
 * `acp`, Kimi Code — `web`) свой одноразовый стенд (`throwaway-stand.mjs`) и
 * заглушка модели (`stub-session-model.mjs`). Сценарий — путь человека через API
 * панели: первый вопрос с секретом → ответ → второй вопрос без секрета → ответ.
 * Доказательство — у модели: во втором ходе в реплике с вопросом секрета нет
 * (панель прислала только новое), а в том же запросе он есть (контекст держит
 * сессия CLI); пересказ переписки панелью положил бы его в реплику с вопросом.
 * И отметка панели (`<разговор>.live.json`): тот же id сессии после обоих
 * ходов, увиденных реплик 2, потом 4.
 *
 * Подменена только модель (сетевая граница). CLI и их дома — как у
 * `check-foreign-steer.mjs` (`foreign-cli.mjs`). Нет CLI — «не проверено» по
 * нему, не провал.
 *
 * Код выхода: 1 — провал; 2 — провалов нет, но хоть один CLI не проверен; 0 — всё.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotChecked, startStand, wait } from './throwaway-stand.mjs';
import { startSessionModel } from './stub-session-model.mjs';
import { FOREIGN_CLIS, applyCliEnv, cliProcesses, findCli, reap } from './foreign-cli.mjs';

/** У OpenCode свои сессии `serve` и до E2b — здесь только CLI живого транспорта. */
const SESSION_CLIS = ['codex', 'qwen', 'goose', 'kimi'];
const only = process.argv.slice(2);

let failures = 0;
const skipped = [];
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`);
  }
  return condition;
};

/** Ждать, пока условие станет правдой; `undefined` — не дождались. */
async function until(probe, seconds) {
  for (let i = 0; i < seconds * 4; i += 1) {
    const value = await probe();
    if (value) return value;
    await wait(250);
  }
  return undefined;
}

/** Файл отметки разговора где-то в данных стенда; нет — `undefined`. */
function findMark(dir, file) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === file) return path;
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      const found = findMark(path, file);
      if (found) return found;
    }
  }
  return undefined;
}

const readMark = (root, chatId) => {
  const path = findMark(root, `${chatId}.live.json`);
  return path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
};

async function checkCli(name, spec) {
  console.log(`\n${name}`);
  const dir = findCli(name);
  if (!dir) {
    skipped.push(name);
    console.log(`  Не проверено: «${name}» нет ни в STEER_CLI_DIR, ни в PATH.`);
    return;
  }
  const secret = `SESSION-SECRET-${Math.random().toString(36).slice(2, 8)}`;
  const stub = await startSessionModel({ secret });
  const root = mkdtempSync(join(tmpdir(), `cc-session-${name}-`));
  const restoreEnv = applyCliEnv(spec.env(root, `http://127.0.0.1:${stub.port}`), dir);

  const before = cliProcesses(dir);
  let stand;
  try {
    stand = await startStand({
      web: false,
      label: `session-${name}`,
      settings: { provider: name },
    });
    const chat = await stand.api('/provider-chat/chats', { method: 'POST', body: {} });
    if (!check('разговор создан', chat.status === 200 && chat.body?.id, chat.text)) return;
    const id = chat.body.id;
    const status = async () => (await stand.api(`/provider-chat/chats/${id}/status`)).body;
    const messages = async () =>
      (await stand.api(`/provider-chat/chats/${id}`)).body?.messages ?? [];

    /** Отправить и дождаться конца хода; вернуть запросы модели за этот ход. */
    const turn = async (text) => {
      const from = stub.requests.length;
      const sent = await stand.api(`/provider-chat/chats/${id}/send`, {
        method: 'POST',
        body: { text },
      });
      if (!check(`«${text.slice(0, 24)}…» принят`, sent.status === 200, sent.text)) return;
      await until(async () => (await status())?.isRunning === true, 10);
      const ended = await until(async () => (await status())?.isRunning === false, 120);
      if (!check('ход кончился', ended, JSON.stringify(await status()))) return;
      return stub.requests.slice(from);
    };

    const QUESTION_1 = `Запомни слово ${secret}. Ответь коротко.`;
    const QUESTION_2 = 'Какое слово я просил запомнить?';
    /** Реплика хода среди реплик запроса: CLI кладут рядом свои. */
    const own = (request, question) => request.users.find((text) => text.includes(question));
    const brief = (requests) =>
      JSON.stringify(
        requests.map(({ n, path, inBody, users }) => ({
          n,
          path,
          inBody,
          users: users.map((text) => text.slice(0, 160)),
        })),
      );

    const first = await turn(QUESTION_1);
    if (!first) return;
    const afterFirst = await messages();
    const reply1 = afterFirst.at(-1);
    if (
      !check(
        `первый ответ транспортом ${spec.transport}`,
        reply1?.role === 'assistant' && reply1.transport === spec.transport,
        JSON.stringify(reply1 ?? null).slice(0, 600),
      )
    ) {
      console.log(stand.log().slice(-1500));
      return;
    }
    check(
      'первый ход: реплика хода дошла до модели',
      first.some((request) => own(request, QUESTION_1)),
      brief(first),
    );
    const mark1 = readMark(stand.root, id);
    check(
      'отметка после первого хода: id сессии, увиденных реплик 2',
      Boolean(mark1?.id) && mark1.covered === 2 && !mark1.stale,
      JSON.stringify(mark1 ?? null),
    );

    const second = await turn(QUESTION_2);
    if (!second) return;
    // Пересказ всей переписки положил бы секрет в ту же реплику, что и вопрос;
    // запрос заголовка у Goose собирает все реплики сразу — поэтому «есть такой
    // запрос», а не «каждый».
    check(
      'второй ход: в реплике хода секрета нет, в контексте того же запроса — есть ' +
        '(панель прислала только новое, остальное держит сессия CLI)',
      second.some((request) => {
        const text = own(request, QUESTION_2);
        return text !== undefined && !text.includes(secret) && request.inBody;
      }),
      brief(second),
    );
    const reply2 = (await messages()).at(-1);
    check(
      'второй ответ: модель видела секрет',
      reply2?.role === 'assistant' && /_SEEN$/.test(reply2.content.trim()),
      JSON.stringify(reply2 ?? null).slice(0, 600),
    );
    const mark2 = readMark(stand.root, id);
    check(
      'отметка после второго хода: та же сессия, увиденных реплик 4',
      mark2?.id === mark1?.id && mark2?.covered === 4 && !mark2?.stale,
      JSON.stringify(mark2 ?? null),
    );
  } catch (error) {
    if (error instanceof NotChecked) {
      skipped.push(name);
      console.log(`  Не проверено: ${error.message}`);
    } else check('сценарий дошёл до конца', false, error?.stack ?? String(error));
  } finally {
    if (stand) await stand.stop();
    reap(before, dir, stand ? [root, stand.root] : [root]);
    await wait(500);
    // Сервер CLI писал в дом стенда до самого снятия — стенд не смог его стереть.
    if (stand) rmSync(stand.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    await stub.close();
    restoreEnv();
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (error) {
      console.log(`  ! временный каталог не удалён: ${root} (${error.code ?? error.message})`);
    }
  }
}

for (const name of SESSION_CLIS) {
  if (only.length > 0 && !only.includes(name)) continue;
  await checkCli(name, FOREIGN_CLIS[name]);
}

if (failures > 0) {
  console.log(`\nПровалов: ${failures}`);
  process.exit(1);
}
if (skipped.length > 0) {
  console.log(`\nПровалов нет; не проверено: ${skipped.join(', ')}`);
  process.exit(2);
}
console.log('\nВсё сходится.');
process.exit(0);
