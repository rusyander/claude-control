/**
 * Сито, выученное по треду MR, приходит только в задачу, задевшую его область
 * (пакет 30.09, п. 9 — половина с форджем, у которого есть треды).
 *
 * Своя одноразовая панель, заглушка GitLab и фальшивый `claude` с сессиями. В
 * плане три доставляющие группы, у каждой своя копия (git, удалённый — голый
 * репозиторий под веб-адресом заглушки):
 *  - A «Биллинг» — доставлена, MR №5; на MR нерешённый тред ревьюера к файлу
 *    `src/billing/charge.ts`;
 *  - B «Возвраты» — правки в `src/billing/refund.ts`;
 *  - C «Документация» — правки в `docs/notes.md`.
 *
 * 1. «Перепроверить MR» у A: панель читает треды форджем и пересылает тред
 *    группе со ссылкой и файлом; группа (фальшивый CLI) отвечает блоком
 *    `learned` с этой ссылкой → сито «предложено», область `src/billing`.
 * 2. Предложенное ни в какое задание не идёт; человек принимает его (API).
 * 3. Человек пишет в чат B и в чат C → после хода работы панель заводит звено
 *    доставки, и абзац сит в его задании несёт выученное сито только у B.
 *
 * Мутант: `QA_SIEVE_AREA_MUTANT=1` — тред ревьюера к `docs/style.md`; сито
 * должно уйти к C, а не к B, и проверка — покраснеть.
 * Запуск: `node tools/qa/check-split-learned-sieve-area.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeClaudeSession, readCalls } from './fake-claude-session.mjs';
import { freePort, runOnStand, wait } from './throwaway-stand.mjs';

const MUTANT = process.env.QA_SIEVE_AREA_MUTANT === '1';
const PARENT = 'qa-sieve-area-parent';
const SESSIONS = [
  '5e5e0000-0000-4000-8000-00000000000a',
  '5e5e0000-0000-4000-8000-00000000000b',
  '5e5e0000-0000-4000-8000-00000000000c',
];
const THREAD_FILE = MUTANT ? 'docs/style.md' : 'src/billing/charge.ts';
const MARKER = 'QA-SIEVE-MONEY: суммы в копейках целыми числами и тест на округление комиссии';
const HEADER = 'Sieves learned from earlier MR blockers';

const forgePort = await freePort();
const SITE = `http://127.0.0.1:${forgePort}`;
const REMOTE = `${SITE}/team/app.git`;
const mr = (iid) => `${SITE}/team/app/-/merge_requests/${iid}`;
const THREAD = `${mr(5)}#note_501`;

const forgeCalls = [];
const forge = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  forgeCalls.push(decodeURIComponent(req.url ?? ''));
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const hit = /\/api\/v4\/projects\/team(?:%2F|\/)app\/merge_requests\/(\d+)(\/[a-z_]+)?$/.exec(
    path,
  );
  if (!hit) return json(path.endsWith('/merge_requests') ? [] : {});
  const iid = Number(hit[1]);
  if (hit[2] === '/discussions') {
    if (iid !== 5) return json([]);
    return json([
      {
        id: 'd501',
        notes: [
          {
            id: 501,
            body: 'Комиссия считается во float — копейки теряются на округлении.',
            author: { username: 'reviewer' },
            resolvable: true,
            resolved: false,
            created_at: '2026-10-09T10:00:00.000Z',
            position: { new_path: THREAD_FILE, new_line: 12 },
          },
        ],
      },
    ]);
  }
  if (hit[2]) return json([]);
  json({
    iid,
    title: `MR ${iid}`,
    state: 'opened',
    source_branch: 'feature/billing',
    target_branch: 'main',
    description: `Описание MR ${iid}`,
    author: { username: 'group-agent' },
    web_url: mr(iid),
  });
});
await new Promise((done) => forge.listen(forgePort, '127.0.0.1', done));

const LEARNED = JSON.stringify({
  learned: [
    {
      thread: THREAD,
      class: 'data',
      scope: 'project',
      trigger: 'денежные расчёты в коде биллинга',
      check: MARKER,
    },
  ],
});
const FAKE_CLAUDE = fakeClaudeSession(`Готово.\n\n\`\`\`agentdeck:sieves\n${LEARNED}\n\`\`\``);

const GROUPS = [
  { title: 'Биллинг', branch: 'feature/billing', file: 'src/billing/charge.ts', mr: 5 },
  { title: 'Возвраты', branch: 'feature/refund', file: 'src/billing/refund.ts' },
  { title: 'Документация', branch: 'feature/docs', file: 'docs/notes.md' },
];
const copies = [];

await runOnStand(
  {
    web: false,
    label: 'sieve-area',
    fakeCli: { claude: FAKE_CLAUDE },
    seed: ({ root, cfg }) => {
      const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
      const who = ['-c', 'user.name=qa', '-c', 'user.email=qa@example.com'];
      const bare = join(root, 'remote.git');
      git(root, 'init', '--bare', '-q', bare);
      const insteadOf = [`url.${bare.replace(/\\/g, '/')}.insteadOf`, REMOTE];

      const groups = GROUPS.map((spec, index) => {
        const copy = join(root, `copy-${index}`);
        copies.push(copy);
        mkdirSync(copy, { recursive: true });
        git(copy, 'init', '-q', '-b', 'main');
        git(copy, 'remote', 'add', 'origin', REMOTE);
        git(copy, 'config', ...insteadOf);
        if (index === 0) {
          writeFileSync(join(copy, 'README.md'), '# calc\n', 'utf8');
          git(copy, 'add', '.');
          git(copy, ...who, 'commit', '-q', '-m', 'base');
          git(copy, 'push', '-q', '-u', 'origin', 'main');
        } else {
          git(copy, 'fetch', '-q', 'origin', 'main');
          git(copy, 'reset', '-q', '--hard', 'origin/main');
        }
        git(copy, 'remote', 'set-head', 'origin', 'main');
        git(copy, 'checkout', '-q', '-b', spec.branch);
        mkdirSync(join(copy, spec.file, '..'), { recursive: true });
        writeFileSync(join(copy, spec.file), `// ${spec.title}\n`, 'utf8');
        git(copy, 'add', '.');
        git(copy, ...who, 'commit', '-q', '-m', spec.title);
        git(copy, 'push', '-q', '-u', 'origin', spec.branch);
        if (spec.mr) git(copy, 'push', '-q', 'origin', `HEAD:refs/merge-requests/${spec.mr}/head`);

        // Транскрипт есть у каждой группы: её чат продолжается, а не заводится.
        const session = SESSIONS[index];
        const dir = join(cfg, 'projects', copy.replace(/[^a-zA-Z0-9]/g, '-'));
        mkdirSync(dir, { recursive: true });
        const line = (type, content) =>
          JSON.stringify({ type, sessionId: session, cwd: copy, message: { role: type, content } });
        writeFileSync(
          join(dir, `${session}.jsonl`),
          `${line('user', spec.title)}\n${line('assistant', [{ type: 'text', text: 'ok' }])}\n`,
        );
        return {
          index,
          title: spec.title,
          branch: spec.branch,
          after: [],
          status: 'done',
          deliver: true,
          chatId: session,
          path: copy,
          startedAt: '2026-10-09T09:05:00.000Z',
          ...(spec.mr ? { mr: mr(spec.mr), doneAt: '2026-10-09T09:30:00.000Z' } : {}),
        };
      });
      const plan = {
        parentChatId: PARENT,
        projectPath: copies[0],
        createdAt: '2026-10-09T09:00:00.000Z',
        order: [0, 1, 2],
        request: {},
        proposal: {
          groups: GROUPS.map((spec) => ({
            title: spec.title,
            branch: spec.branch,
            tasks: [spec.title],
          })),
        },
        groups,
      };
      const chatLinks = Object.fromEntries(
        GROUPS.map((spec, index) => [
          SESSIONS[index],
          {
            parentChatId: PARENT,
            title: spec.title,
            branch: spec.branch,
            groupIndex: index,
            conversation: SESSIONS[index],
            // Модель работы — как у связи настоящей группы: звено доставки идёт на ней.
            model: 'sonnet',
            createdAt: '2026-10-09T09:05:00.000Z',
          },
        ]),
      );
      const file = join(cfg, 'agentdeck', 'state.json');
      const state = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(
        file,
        `${JSON.stringify({ ...state, splitPlans: { [PARENT]: plan }, chatLinks })}\n`,
      );
    },
  },
  async (stand, check) => {
    const calls = () => readCalls(stand.bin);
    const of = (session) => calls().filter((call) => call.session === session);
    const learned = async () =>
      ((await stand.api('/sieves')).body?.learned ?? []).find((sieve) => sieve.check === MARKER);

    const saved = await stand.api('/integrations/gitlab', {
      method: 'PUT',
      body: {
        settings: { enabled: true, baseUrl: SITE, repo: 'team/app' },
        token: 'qa-token',
      },
    });
    check('фордж включён через API панели', saved.status === 200, saved.text.slice(0, 300));

    // 1. Перепроверка A пересылает тред, группа раскладывает его в сито.
    const started = await stand.api(`/chat/split/${PARENT}/recheck`, {
      method: 'POST',
      body: { index: 0 },
    });
    check('«Перепроверить MR» у A принят', started.status === 200, started.text.slice(0, 300));
    let sieve;
    for (let t = 0; t < 45_000 && !sieve; t += 500) {
      await wait(500);
      sieve = await learned();
    }
    const relay = of(SESSIONS[0])[0];
    check(
      'тред ушёл группе A ссылкой и файлом',
      Boolean(relay?.text?.includes(THREAD) && relay.text.includes(THREAD_FILE)),
      (relay?.text ?? '').slice(0, 900),
    );
    check(
      'сито записано предложенным, с областью файла треда',
      sieve?.status === 'proposed' &&
        JSON.stringify(sieve.areas) ===
          JSON.stringify([THREAD_FILE.split('/').slice(0, -1).slice(0, 2).join('/')]) &&
        sieve.sources?.some((source) => source.thread === THREAD),
      `${JSON.stringify(sieve ?? (await stand.api('/sieves')).body).slice(0, 600)}\n${JSON.stringify(
        (({ status, mrWatch, recheckRequestedAt, waitingFor }) => ({
          status,
          mrWatch,
          recheckRequestedAt,
          waitingFor,
        }))(
          JSON.parse(readFileSync(join(stand.cfg, 'agentdeck', 'state.json'), 'utf8')).splitPlans[
            PARENT
          ].groups[0],
        ),
      )}\n${stand
        .log()
        .split('\n')
        .filter((line) => /sieve|mr watch|mr recheck|learn/i.test(line))
        .slice(-12)
        .join('\n')}`,
    );
    check(
      'предложенное сито не попало ни в одно задание',
      !calls().some((call) => call.text?.includes(HEADER)),
      JSON.stringify(calls().map((call) => call.text?.slice(0, 80))),
    );

    if (process.env.QA_DUMP_LOG) writeFileSync(process.env.QA_DUMP_LOG, stand.log());
    // 2. Человек принимает сито.
    const accepted = await stand.api(`/sieves/learned/${sieve?.id}/accept`, {
      method: 'POST',
      body: { scope: 'project' },
    });
    check('сито принято человеком', accepted.status === 200, accepted.text.slice(0, 300));

    // 3. Ход работы в чатах B и C → звено доставки с абзацем сит.
    const sentAt = Date.now();
    for (const index of [1, 2]) {
      stand
        .api('/chat/send', {
          method: 'POST',
          body: {
            chatId: SESSIONS[index],
            sessionId: SESSIONS[index],
            prompt: 'Поправь опечатку в своей правке',
            projectPath: copies[index],
          },
        })
        .catch(() => undefined);
    }
    // Звено доставки — новый разговор в копии группы: узнаётся по её ветке и
    // вводной нового разговора, а не по сессии работы.
    const stageOf = (index) =>
      calls().filter(
        (call) =>
          call.at >= sentAt &&
          call.session !== SESSIONS[index] &&
          call.cwd?.toLowerCase() === copies[index].toLowerCase() &&
          call.text?.includes(`Group branch: ${GROUPS[index].branch}.`),
      );
    for (let t = 0; t < 60_000; t += 500) {
      await wait(500);
      if (stageOf(1).length > 0 && stageOf(2).length > 0) break;
    }
    const withSieve = (index) =>
      stageOf(index).some((call) => call.text?.includes(HEADER) && call.text.includes(MARKER));
    check(
      'у B и у C после хода работы заведено звено доставки',
      stageOf(1).length > 0 && stageOf(2).length > 0,
      JSON.stringify(
        calls().map((call) => ({ session: call.session, text: call.text?.slice(0, 80) })),
      ),
    );
    check(
      'выученное сито — в задании B (правки в src/billing)',
      withSieve(1),
      (stageOf(1)[0]?.text ?? '').slice(0, 2500),
    );
    check(
      'и не в задании C (правки в docs)',
      stageOf(2).length > 0 && !withSieve(2),
      (stageOf(2)[0]?.text ?? '').slice(0, 2500),
    );
  },
).finally(() => forge.close());
