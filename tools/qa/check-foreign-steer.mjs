/**
 * Сообщение посреди ответа чужого CLI (В1) — настоящими CLI, через настоящую панель.
 *
 * На каждый CLI (Codex — `app-server`, Qwen — `serve`, Goose — `acp`, Kimi Code —
 * `web`, OpenCode — сессия `serve`) свой одноразовый стенд (`throwaway-stand.mjs`) и заглушка модели
 * (`stub-steer-model.mjs`), держащая ход занятым. Сценарий — путь человека через
 * API панели: вопрос → ход стал «принимающим» → второе сообщение с меткой,
 * пока модель держит ход → ответ. Доказательство — у модели: метка пришла ей
 * в ТОМ ЖЕ ходе (ответ «STEER_SEEN»), второго хода и очереди не было.
 *
 * Подменена только модель (сетевая граница). CLI — настоящие: из `STEER_CLI_DIR`
 * (каталоги через разделитель PATH), иначе из PATH. Нет CLI — «не проверено» по
 * нему, не провал. Дома CLI — временные каталоги: настоящие `~/.codex`, `~/.qwen`,
 * данные Goose, `~/.kimi-code`, конфиг OpenCode и `~/.claude` не трогаются.
 *
 * Код выхода: 1 — провал; 2 — провалов нет, но хоть один CLI не проверен; 0 — всё.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotChecked, startStand, wait } from './throwaway-stand.mjs';
import { startStubModel } from './stub-steer-model.mjs';
import { FOREIGN_CLIS, applyCliEnv, cliProcesses, findCli, reap } from './foreign-cli.mjs';

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

async function checkCli(name, spec) {
  console.log(`\n${name}`);
  const dir = findCli(name);
  if (!dir) {
    skipped.push(name);
    console.log(`  Не проверено: «${name}» нет ни в STEER_CLI_DIR, ни в PATH.`);
    return;
  }
  const marker = `STEER-MARK-${Math.random().toString(36).slice(2, 8)}`;
  const stub = await startStubModel({ marker, holdMs: 8000 });
  const root = mkdtempSync(join(tmpdir(), `cc-steer-${name}-`));
  const added = spec.env(root, `http://127.0.0.1:${stub.port}`);
  const restoreEnv = applyCliEnv(added, dir);

  const before = cliProcesses(dir);
  let stand;
  try {
    stand = await startStand({ web: false, label: `steer-${name}`, settings: { provider: name } });
    const chat = await stand.api('/provider-chat/chats', { method: 'POST', body: {} });
    if (!check('разговор создан', chat.status === 200 && chat.body?.id, chat.text)) return;
    const id = chat.body.id;
    // Разговор без «Разрешить правки» отдаёт каждую просьбу CLI о команде
    // человеку карточкой (`ProviderChatService` → `decidePermission`), а здесь
    // отвечать на неё некому: Codex ждал решения, модель — результата, и ход
    // вставал до метки. Проверка — про сообщение посреди хода, не про права.
    const rights = await stand.api(`/provider-chat/chats/${id}`, {
      method: 'PATCH',
      body: { allowEdits: true },
    });
    if (!check('правки разрешены (вопросов о командах нет)', rights.status === 200, rights.text))
      return;
    const status = async () => (await stand.api(`/provider-chat/chats/${id}/status`)).body;

    const first = await stand.api(`/provider-chat/chats/${id}/send`, {
      method: 'POST',
      body: { text: 'Первый вопрос: ответь, когда закончишь.' },
    });
    if (!check('вопрос принят', first.status === 200, first.text)) return;

    const steerable = await until(async () => (await status())?.steerable === true, 90);
    if (
      !check(
        'статус: ход принимает сообщения посреди ответа',
        steerable,
        JSON.stringify(await status()),
      )
    ) {
      // Ход кончился, не начавшись: причина — в последней реплике (ошибка CLI),
      // а журнал панели о ней молчит.
      const messages = (await stand.api(`/provider-chat/chats/${id}`)).body?.messages ?? [];
      console.log(
        `    последняя реплика: ${JSON.stringify(messages.at(-1) ?? null).slice(0, 800)}`,
      );
      console.log(`    модель получила запросов: ${stub.requests.length}`);
      console.log(stand.log().slice(-1500));
      return;
    }
    const holding = await until(() => stub.isHolding(), 90);
    if (!check('модель держит ход', holding, JSON.stringify(stub.requests))) return;

    const steer = await stand.api(`/provider-chat/chats/${id}/send`, {
      method: 'POST',
      body: { text: `Учти ещё ${marker}`, queueIfBusy: true },
    });
    check(
      'сообщение посреди ответа принято ходом (200, steered)',
      steer.status === 200 && steer.body?.steered === true,
      `${steer.status} ${steer.text}`,
    );

    const ended = await until(async () => (await status())?.isRunning === false, 120);
    check('ход кончился', ended, JSON.stringify(await status()));
    const after = await status();
    check(
      'очереди нет, «принимает» снято',
      !after?.queued && !after?.steerable,
      JSON.stringify(after),
    );

    const messages = (await stand.api(`/provider-chat/chats/${id}`)).body?.messages ?? [];
    const shape = messages.map((item) => `${item.role}${item.steered ? ':steered' : ''}`);
    check(
      'переписка: вопрос, подхваченное сообщение, ОДИН ответ',
      shape.join(',') === 'user,user:steered,assistant',
      shape.join(','),
    );
    const answer = messages.at(-1);
    check(
      'метка дошла до модели в том же ходе (STEER_SEEN в ответе)',
      answer?.role === 'assistant' && answer.content.includes('STEER_SEEN'),
      answer?.content,
    );
    check(
      `ответ транспортом ${spec.transport}`,
      answer?.transport === spec.transport,
      String(answer?.transport),
    );
    check(
      'модель получила метку запросом этого прогона',
      stub.requests.some((request) => request.marker),
      JSON.stringify(stub.requests.map((request) => [request.n, request.marker, request.reply])),
    );

    // Обратная сторона: хода нет — сообщение уходит обычной отправкой, а не «посреди».
    const idle = await stand.api(`/provider-chat/chats/${id}/send`, {
      method: 'POST',
      body: { text: 'Новый вопрос после ответа.', queueIfBusy: true },
    });
    check(
      'без идущего хода — обычная отправка, не steered',
      idle.status === 200 && idle.body?.steered === undefined && !idle.body?.queued,
      `${idle.status} ${idle.text}`,
    );
    await until(async () => (await status())?.isRunning === false, 120);
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
      // Каталог держит пережившая проверку дочка CLI (Codex запускает `git`):
      // это не провал сценария, но и не молчание — остаток назван.
      console.log(`  ! временный каталог не удалён: ${root} (${error.code ?? error.message})`);
    }
  }
}

for (const [name, spec] of Object.entries(FOREIGN_CLIS)) {
  if (only.length > 0 && !only.includes(name)) continue;
  await checkCli(name, spec);
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
