/**
 * Доставка группы: MR выбирается по ветке-источнику у форджа, когда голова
 * копии совпала с головой предшественника (пакет 30.09, п. 7; ревью 29.09).
 *
 * Группа B отведена от ветки группы A и своих коммитов ещё не имеет: на
 * удалённом `feature/a` и `feature/b` на одном коммите, и на нём же головы
 * MR №1 (из `feature/a`) и MR №2 (из `feature/b`). Агент B в ответе назвал
 * MR №1 — чужой. По одной голове их не различить; различает только фордж.
 *
 * Своя одноразовая панель; удалённый — голый репозиторий, но копия знает его
 * по веб-адресу заглушки GitLab (`insteadOf`), как у своего GitLab на http с
 * портом. Фордж включён через API панели, заглушка отвечает на чтение MR
 * веткой-источником и описанием. Вместо `claude` — фальшивый CLI с сессиями.
 *
 * 1. «Перепроверить MR» → ход группы её же сессией, ответ называет MR №1.
 * 2. Проверка доставки спрашивает фордж о MR №1 и №2 и берёт №2 — MR ветки B.
 *
 * Мутант: `QA_MR_SOURCE_MUTANT=1` — заглушка называет источником MR №2
 * `feature/a`; проверка обязана покраснеть (MR ветки B нет).
 * Запуск: `node tools/qa/check-split-delivery-mr-source.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeClaudeSession, readCalls } from './fake-claude-session.mjs';
import { freePort, runOnStand, wait } from './throwaway-stand.mjs';

const MUTANT = process.env.QA_MR_SOURCE_MUTANT === '1';
const PARENT = 'qa-mr-source-parent';
const SESSION = '5e551000-0000-4000-8000-0000000000b2';
const TASK = 'PROJ-88 Вычитание в калькуляторе';

const forgePort = await freePort();
const SITE = `http://127.0.0.1:${forgePort}`;
const REMOTE = `${SITE}/team/app.git`;
const mr = (iid) => `${SITE}/team/app/-/merge_requests/${iid}`;
const SOURCES = { 1: 'feature/a', 2: MUTANT ? 'feature/a' : 'feature/b' };

const forgeCalls = [];
const forge = createServer((req, res) => {
  const path = decodeURIComponent(req.url ?? '');
  forgeCalls.push(path);
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const one = /\/api\/v4\/projects\/team(?:%2F|\/)app\/merge_requests\/(\d+)$/.exec(
    (req.url ?? '').split('?')[0],
  );
  if (one) {
    const iid = Number(one[1]);
    if (!SOURCES[iid]) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"message":"404 Not found"}');
      return;
    }
    json({
      iid,
      title: `MR ${iid}`,
      state: 'opened',
      source_branch: SOURCES[iid],
      target_branch: 'main',
      description: `Описание MR ${iid}`,
      web_url: mr(iid),
    });
    return;
  }
  if (/\/discussions|\/notes|\/pipelines|merge_requests\?/.test(path)) return json([]);
  json({});
});
await new Promise((done) => forge.listen(forgePort, '127.0.0.1', done));

const FAKE_CLAUDE = fakeClaudeSession(
  `Conflicts: none. Comments: none. Pipeline: green. Tasks: done.\n${mr(1)}`,
);

let copy = '';
let exitCode = 0;
try {
  await runOnStand(
    {
      web: false,
      label: 'mr-source',
      fakeCli: { claude: FAKE_CLAUDE },
      seed: ({ root, cfg }) => {
        const bare = join(root, 'remote.git');
        copy = join(root, 'copy-b');
        mkdirSync(copy, { recursive: true });
        const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
        git(root, 'init', '--bare', '-q', bare);
        git(copy, 'init', '-q', '-b', 'feature/a');
        writeFileSync(join(copy, 'README.md'), '# calc\n', 'utf8');
        git(copy, 'add', '.');
        git(
          copy,
          '-c',
          'user.name=qa',
          '-c',
          'user.email=qa@example.com',
          'commit',
          '-q',
          '-m',
          'a',
        );
        // Удалённый — по веб-адресу заглушки, git ходит в голый репозиторий.
        git(copy, 'remote', 'add', 'origin', REMOTE);
        git(copy, 'config', `url.${bare.replace(/\\/g, '/')}.insteadOf`, REMOTE);
        git(copy, 'push', '-q', 'origin', 'feature/a');
        // B отведена от A без своих коммитов: голова та же.
        git(copy, 'checkout', '-q', '-b', 'feature/b');
        git(copy, 'push', '-q', '-u', 'origin', 'feature/b');
        git(copy, 'push', '-q', 'origin', 'HEAD:refs/merge-requests/1/head');
        git(copy, 'push', '-q', 'origin', 'HEAD:refs/merge-requests/2/head');

        // Транскрипт сессии группы есть: перепроверка продолжает её.
        const dir = join(cfg, 'projects', copy.replace(/[^a-zA-Z0-9]/g, '-'));
        mkdirSync(dir, { recursive: true });
        const line = (type, content) =>
          JSON.stringify({ type, sessionId: SESSION, cwd: copy, message: { role: type, content } });
        writeFileSync(
          join(dir, `${SESSION}.jsonl`),
          `${line('user', TASK)}\n${line('assistant', [{ type: 'text', text: mr(1) }])}\n`,
        );

        const groupA = {
          index: 0,
          title: 'Сложение',
          branch: 'feature/a',
          after: [],
          status: 'done',
          deliver: true,
          startedAt: '2026-10-09T09:05:00.000Z',
          mr: mr(1),
        };
        const groupB = {
          index: 1,
          title: 'Вычитание',
          branch: 'feature/b',
          base: 'feature/a',
          after: [0],
          status: 'done',
          deliver: true,
          chatId: SESSION,
          path: copy,
          startedAt: '2026-10-09T09:10:00.000Z',
          mr: mr(1),
        };
        const plan = {
          parentChatId: PARENT,
          projectPath: copy,
          createdAt: '2026-10-09T09:00:00.000Z',
          order: [0, 1],
          request: {},
          proposal: {
            groups: [
              { title: 'Сложение', branch: 'feature/a', tasks: ['PROJ-87 Сложение'] },
              { title: 'Вычитание', branch: 'feature/b', tasks: [TASK] },
            ],
          },
          groups: [groupA, groupB],
        };
        const link = {
          parentChatId: PARENT,
          title: 'Вычитание',
          branch: 'feature/b',
          groupIndex: 1,
          conversation: SESSION,
          createdAt: '2026-10-09T09:10:00.000Z',
        };
        const file = join(cfg, 'agentdeck', 'state.json');
        const state = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(
          file,
          `${JSON.stringify({ ...state, splitPlans: { [PARENT]: plan }, chatLinks: { [SESSION]: link } })}\n`,
        );
      },
    },
    async (stand, check) => {
      const groupB = async () => (await stand.api(`/chat/${PARENT}/tree`)).body?.split?.groups?.[1];

      const saved = await stand.api('/integrations/forge', {
        method: 'PUT',
        body: {
          settings: { enabled: true, kind: 'gitlab', baseUrl: SITE, repo: 'team/app' },
          token: 'qa-token',
        },
      });
      check('фордж включён через API панели', saved.status === 200, saved.text.slice(0, 300));
      forgeCalls.length = 0;

      const started = await stand.api(`/chat/split/${PARENT}/recheck`, {
        method: 'POST',
        body: { index: 1 },
      });
      check('«Перепроверить MR» принят', started.status === 200, started.text.slice(0, 300));

      let group;
      for (let t = 0; t < 60_000; t += 500) {
        await wait(500);
        group = await groupB();
        if (readCalls(stand.bin).length > 0 && group?.status === 'done' && group.mr === mr(2))
          break;
      }
      const calls = readCalls(stand.bin);
      check(
        'ход группы — её же сессией, в её копии',
        calls.length > 0 &&
          calls[0].resume === SESSION &&
          calls[0].outcome === 'answered' &&
          calls[0].cwd?.toLowerCase() === copy.toLowerCase(),
        JSON.stringify(calls.map((c) => ({ resume: c.resume, outcome: c.outcome, cwd: c.cwd }))),
      );
      const reads = forgeCalls.filter((call) => /merge_requests\/\d+$/.test(call.split('?')[0]));
      check(
        'фордж спрошен о ветке-источнике MR №1 и №2',
        reads.some((call) => call.endsWith('/merge_requests/1')) &&
          reads.some((call) => call.endsWith('/merge_requests/2')),
        JSON.stringify(forgeCalls),
      );
      check(
        'у группы B — MR её ветки (№2), а не названный агентом MR предшественника',
        group?.status === 'done' && group.mr === mr(2),
        JSON.stringify({
          status: group?.status,
          mr: group?.mr,
          missing: group?.deliveryMissing,
          error: group?.error,
        }),
      );
    },
  );
} catch (error) {
  exitCode = 1;
  throw error;
} finally {
  forge.close();
  if (exitCode) process.exitCode = exitCode;
}
