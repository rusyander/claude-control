/**
 * Ответ с телефона на вопрос ядра (этап 10, зона D): подпись библиотекой телефона
 * (`apps/mobile/src/shared/api/signing/*` — тот же код, что в приложении) → прокладка панели
 * `/api/core/commands` → НАСТОЯЩЕЕ ядро стенда.
 *
 * Корень, который чинится: телефон подписывает номером машины ПАНЕЛИ (`/api/system`), а ядро
 * проверяло подпись своим номером (`<дом ядра>/machine-id`) — ни одна подпись телефона не
 * проходила. Теперь перенос устройств (`POST /v1/devices/adopt`) несёт номер машины панели, и
 * ядро принимает его своим.
 *
 * Что проверяется:
 * 1. Перенос ключа телефона с номером машины панели принят (число страницы + чистый пир).
 * 2. Ответ, подписанный телефоном, — `applied`; вопрос в виде задачи — `answered`.
 * 3. Тот же конверт, подписанный ДРУГИМ номером машины, — отказ `signature-invalid` (проверка
 *    умеет краснеть: без номера панели подпись телефона не проходит).
 * 4. Вопрос второй задачи — ответ без подписи через панель: отказ (Telegram и любой канал без
 *    ключа устройства ответить не может — ответ `human-strict`).
 *
 * Вопрос в журнале — кодом ядра до его старта (`core-ask-seed.mjs`). Стенд свой, сеть не нужна.
 * Запуск: `node tools/qa/check-core-phone-answer.mjs`. Код выхода: 0 / 1 провал / 2 стенд.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mobileModule } from './mobile-lib.mjs';
import { REPO, runOnStand } from './throwaway-stand.mjs';

const { newId } = await import('../../apps/core/src/lib/ids/uuidv7.ts');
const { keyFromSeed } = await mobileModule('shared/api/signing/signing.ts');
const { signedCoreCommand } = await mobileModule('shared/api/signing/coreCommand.ts');

const asks = [];
function seedAsk(coreHome, title) {
  const out = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      join(REPO, 'tools/qa/core-ask-seed.mjs'),
      coreHome,
      title,
    ],
    { encoding: 'utf8' },
  );
  if (out.status !== 0) throw new Error(`seed failed: ${out.stderr}`);
  asks.push(JSON.parse(out.stdout.trim().split('\n').at(-1)));
}

await runOnStand(
  {
    label: 'core-phone',
    core: true,
    web: false,
    // Ядро стенда — своё (`core: true`): надзор панели второго не поднимает.
    env: { AGENTDECK_CORE_SUPERVISE: '0' },
    seed: ({ coreHome }) => {
      seedAsk(coreHome, 'Ответ с телефона');
      seedAsk(coreHome, 'Ответ без подписи');
    },
  },
  async (stand, check) => {
    const [signed, unsigned] = asks;
    const json = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) });
    const post = (path, body) =>
      fetch(`${stand.apiUrl}/api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(json);
    const system = await fetch(`${stand.apiUrl}/api/system`).then((r) => r.json());
    const panel = system.machineId;
    check('панель назвала номер машины', typeof panel === 'string' && panel.length > 0);

    const key = keyFromSeed(new Uint8Array(randomBytes(32)));
    const page = newId();
    const minted = await fetch(`${stand.apiUrl}/api/core/nonce?page=${page}`).then(json);
    check('ядро выдало число страницы', minted.status === 200, JSON.stringify(minted.body));
    const adopt = await post('/core/devices/adopt', {
      cmdId: newId(),
      machineId: panel,
      devices: [{ id: key.deviceId, publicKey: key.publicKey }],
      proof: { nonce: minted.body.nonce, page },
    });
    check(
      'перенос ключа телефона с номером машины панели принят',
      adopt.status === 200 && adopt.body.adopted?.[0] === key.deviceId,
      `${adopt.status} ${JSON.stringify(adopt.body)}`,
    );

    const command = (task, fields) => ({
      cmdId: newId(),
      kind: 'answer',
      target: { taskId: task.taskId },
      fields,
    });
    const answer = command(signed, { askId: signed.askId, answer: 'approve-split' });
    const foreign = signedCoreCommand({
      key,
      panel: `${panel}-other`,
      command: { ...answer, cmdId: newId() },
      nonce: newId(),
      time: Date.now(),
    });
    const wrongMachine = await post('/core/commands', foreign);
    check(
      'подпись под другим номером машины — отказ signature-invalid',
      wrongMachine.status === 403 && wrongMachine.body.code === 'signature-invalid',
      `${wrongMachine.status} ${JSON.stringify(wrongMachine.body)}`,
    );

    const phone = signedCoreCommand({
      key,
      panel,
      command: answer,
      nonce: newId(),
      time: Date.now(),
    });
    const applied = await post('/core/commands', phone);
    check(
      'ответ, подписанный телефоном, — applied',
      applied.status === 200 && applied.body.status === 'applied',
      `${applied.status} ${JSON.stringify(applied.body)}`,
    );
    const view = await fetch(`${stand.apiUrl}/api/core/tasks/${signed.taskId}`).then(json);
    const ask = view.body.view?.asks?.find((a) => a.askId === signed.askId);
    check(
      'вопрос в виде задачи — answered, ответ записан',
      ask?.state === 'answered' && ask.answer === 'approve-split',
      JSON.stringify(ask ?? view.body),
    );

    const bare = await post('/core/commands', {
      ...command(unsigned, { askId: unsigned.askId, answer: 'approve-split' }),
      proof: {},
    });
    check(
      'ответ без подписи через панель — отказ',
      bare.status === 403 && bare.body.status !== 'applied',
      `${bare.status} ${JSON.stringify(bare.body)}`,
    );
  },
);
