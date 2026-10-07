/**
 * «Обновить CLI» у чужих CLI: какая подкоманда ДОХОДИТ до процесса. Кейс cli-x6-001.
 *
 * `POST /api/chat/cli/update?provider=<id>` запускает подкоманду обновления той копии
 * CLI, которую панель находит в PATH. Подкоманды сверены с `--help` самих CLI
 * (goose 1.53.0 `update`, Kimi Code 2.1.1 `update -y` — без `-y` ждёт подтверждения,
 * opencode 1.18.34 `upgrade`). У gemini/aider/continue/cursor подкоманда не проверена:
 * ответ 409 и НИ ОДНОГО запуска процесса.
 *
 * Проверка идёт в настоящий экземпляр панели (`apps/server/src/index.ts`) на
 * одноразовом доме (`throwaway-stand.mjs`), без фронта. Вместо CLI — фальшивые
 * под теми же именами, первыми в PATH: каждый пишет свой argv в журнал рядом с собой
 * и ничего не обновляет. Настоящий CLI не запускается ни разу.
 * Свидетельство — журнал вызовов, а не ответ маршрута.
 *
 * Запуск: `node tools/qa/check-cli-x6-update-args.mjs [--server-dir <копия apps/server>]`.
 */
import { join } from 'node:path';
import { runOnStand } from './throwaway-stand.mjs';

const serverAt = process.argv.indexOf('--server-dir');
const SERVER_DIR = serverAt > 0 ? process.argv[serverAt + 1] : undefined;

/** Фальшивый CLI: строка журнала на каждый запуск, `--version` отвечает версией. */
const fakeSource = (name) => `
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const argv = process.argv.slice(2);
appendFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'calls.jsonl'),
  JSON.stringify({ cli: ${JSON.stringify(name)}, argv }) + '\\n',
);
if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === '-V') console.log('1.0.0');
else console.log('fake ${name}: nothing updated');
`;

/** Провайдер → имя CLI в PATH → ожидаемый argv (null — отказ 409). */
const CASES = [
  ['goose', 'goose', ['update']],
  ['kimi', 'kimi', ['update', '-y']],
  ['opencode', 'opencode', ['upgrade']],
  ['gemini', 'gemini', null],
  ['aider', 'aider', null],
  ['continue', 'cn', null],
  ['cursor', 'cursor-agent', null],
];

const fakeCli = Object.fromEntries(CASES.map(([, bin]) => [bin, fakeSource(bin)]));

await runOnStand(
  {
    label: 'cli-x6-update',
    web: false,
    fakeCli,
    ...(SERVER_DIR ? { serverDir: SERVER_DIR } : {}),
  },
  async (stand, check) => {
    const origin = `http://127.0.0.1:${Number(new URL(stand.apiUrl).port) + 1}`;
    const journal = join(stand.bin, 'calls.jsonl');
    const calls = () =>
      (stand.read(journal) ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));

    for (const [provider, bin, argv] of CASES) {
      console.log(`${provider} (${bin})`);
      const info = await stand.api(`/chat/cli?provider=${provider}&refresh=1`);
      check(
        `${provider}: панель нашла фальшивый ${bin} в PATH`,
        info.status === 200 && String(info.body?.path ?? '').startsWith(stand.bin),
        JSON.stringify(info.body).slice(0, 400),
      );
      check(
        `${provider}: кнопка «Обновить CLI» ${argv ? 'есть' : 'скрыта'} (canUpdate=${argv !== null})`,
        info.body?.canUpdate === (argv !== null),
        `canUpdate=${info.body?.canUpdate}`,
      );

      const before = calls().length;
      const update = await stand.api(`/chat/cli/update?provider=${provider}`, {
        method: 'POST',
        headers: { origin },
      });
      const during = calls().slice(before);
      const launches = during.filter((call) => call.argv[0] !== '--version');

      if (argv) {
        check(
          `${provider}: ответ 200, ok=true`,
          update.status === 200 && update.body?.ok === true,
          `${update.status} ${update.text.slice(0, 300)}`,
        );
        check(
          `${provider}: до процесса дошло ровно «${bin} ${argv.join(' ')}»`,
          JSON.stringify(launches) === JSON.stringify([{ cli: bin, argv }]),
          JSON.stringify(launches),
        );
      } else {
        check(
          `${provider}: ответ 409 cli-update-unsupported`,
          update.status === 409 && update.body?.messageCode === 'cli-update-unsupported',
          `${update.status} ${update.text.slice(0, 300)}`,
        );
        check(
          `${provider}: ни одного запуска CLI за время запроса`,
          during.length === 0,
          JSON.stringify(during),
        );
      }
    }

    const updates = calls().filter((call) => call.argv[0] !== '--version');
    check(
      `за весь прогон подкоманда обновления запускалась только у goose/kimi/opencode (${updates.length})`,
      updates.length === 3 &&
        updates.every((call) => ['goose', 'kimi', 'opencode'].includes(call.cli)),
      JSON.stringify(updates),
    );
  },
);
