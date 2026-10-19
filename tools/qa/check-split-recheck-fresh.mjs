/**
 * «Перепроверить MR» — новым разговором группы, а не продолжением старого (живое
 * наблюдение 19.10.2026, R2 и R5).
 *
 * Перепроверку доставленной группы жмут через часы после её работы. Панель
 * продолжала прежнюю сессию (`claude --resume`): кэш подсказки за час простоя
 * истёк, и каждая группа заново писала в кэш весь разговор (~150 тыс. токенов),
 * а модель подхватывала давние нити своего контекста — группа фронтового MR без
 * единой правки в Go гоняла 14 наборов Go-тестов утренней работы, и в её копии
 * лежали 7 чужих `go.mod`, готовых уехать в коммит.
 *
 * Своя одноразовая панель; в записи — план с одной доставленной группой. Копия
 * группы — настоящий `git worktree` основной копии: ветка группы правит
 * `web/Button.tsx` против `origin/main`, а в дереве копии лежит изменённый
 * `svc/go.mod`, которого в MR нет. Транскрипт прежней сессии группы НА ДИСКЕ —
 * её можно продолжить. Вместо `claude` — фальшивый CLI с настоящими сессиями
 * (`fake-claude-session.mjs`), он пишет, что дошло до процесса.
 *
 * 1. «Перепроверить MR» → CLI позван БЕЗ `--resume`, в копии группы.
 * 2. Первое сообщение нового разговора: что он новый и прежний (его id) остаётся
 *    в истории, ветка, копия, MR, задание группы, указатель на `.agent/PROGRESS.md`;
 *    охват — файлы ветки против цели MR (`web/Button.tsx`), а `svc/go.mod` назван
 *    чужим для MR, его не коммитят; плюс сами четыре проверки.
 * 3. Прежний разговор цел: его транскрипт не тронут, его связь с группой на месте.
 * 4. Группа теперь ведётся новой сессией: она связана с родителем, и следующее
 *    слово панели группе (напоминание доставки) идёт в неё же, а не в прежнюю.
 *
 * Ни настоящий `~/.claude`, ни рабочий стенд, ни настоящий CLI не трогаются.
 * Запуск: `node tools/qa/check-split-recheck-fresh.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeClaudeSession, readCalls } from './fake-claude-session.mjs';
import { runOnStand, wait } from './throwaway-stand.mjs';

const PARENT = 'qa-fresh-parent';
const OLD = '0b1e7c3e-0000-4000-8000-0000000f2e5a';
const MR = 'https://forge.example.com/team/app/-/merge_requests/78';
const TASK = 'PROJ-78 Кнопка «Сохранить» в форме профиля';
const OLD_TRANSCRIPT = '{"type":"user","sessionId":"' + OLD + '","message":{"content":"утро"}}\n';

const FAKE_CLAUDE = fakeClaudeSession(
  `Conflicts: none. Comments: none. Pipeline: green. Tasks: done.\n${MR}`,
);

let copy = '';
let oldFile = '';

await runOnStand(
  {
    web: false,
    label: 'recheck-fresh',
    fakeCli: { claude: FAKE_CLAUDE },
    seed: ({ root, cfg }) => {
      const repo = join(root, 'repo');
      const remote = join(root, 'remote.git');
      copy = join(root, 'repo-worktrees', 'feature-button');
      mkdirSync(repo, { recursive: true });
      const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
      const who = ['-c', 'user.name=qa', '-c', 'user.email=qa@example.com'];
      git(root, 'init', '--bare', '-q', remote);
      git(repo, 'init', '-q', '-b', 'main');
      mkdirSync(join(repo, 'web'), { recursive: true });
      mkdirSync(join(repo, 'svc'), { recursive: true });
      writeFileSync(join(repo, 'web', 'Button.tsx'), 'export const Button = 1;\n', 'utf8');
      writeFileSync(join(repo, 'svc', 'go.mod'), 'module svc\n', 'utf8');
      git(repo, 'add', '.');
      git(repo, ...who, 'commit', '-q', '-m', 'base');
      git(repo, 'remote', 'add', 'origin', remote);
      git(repo, 'push', '-q', '-u', 'origin', 'main');
      // `.agent/` — рабочая папка вне git, как в живых проектах.
      writeFileSync(join(repo, '.git', 'info', 'exclude'), '.agent/\n', 'utf8');
      git(repo, 'worktree', 'add', '-q', '-b', 'feature/button', copy);
      writeFileSync(join(copy, 'web', 'Button.tsx'), 'export const Button = 2;\n', 'utf8');
      git(copy, 'add', '.');
      git(copy, ...who, 'commit', '-q', '-m', 'button');
      git(copy, 'push', '-q', '-u', 'origin', 'feature/button');
      // Чужое для MR: инструмент переписал go.mod в копии, в коммит он не попал.
      writeFileSync(join(copy, 'svc', 'go.mod'), 'module svc\n\nrequire x v1\n', 'utf8');
      mkdirSync(join(copy, '.agent'), { recursive: true });
      writeFileSync(join(copy, '.agent', 'PROGRESS.md'), '# progress\n', 'utf8');

      // Прежний разговор группы — на диске: продолжить его можно.
      const dir = join(cfg, 'projects', 'qa-old');
      mkdirSync(dir, { recursive: true });
      oldFile = join(dir, `${OLD}.jsonl`);
      writeFileSync(oldFile, OLD_TRANSCRIPT, 'utf8');

      const group = {
        index: 0,
        title: 'Кнопка',
        branch: 'feature/button',
        after: [],
        status: 'done',
        deliver: true,
        chatId: OLD,
        path: copy,
        startedAt: '2026-10-19T06:40:00.000Z',
        doneAt: '2026-10-19T07:00:00.000Z',
        mr: MR,
      };
      const plan = {
        parentChatId: PARENT,
        projectPath: repo,
        createdAt: '2026-10-19T06:30:00.000Z',
        order: [0],
        request: {},
        proposal: { groups: [{ title: 'Кнопка', branch: 'feature/button', tasks: [TASK] }] },
        groups: [group],
      };
      const link = {
        parentChatId: PARENT,
        title: 'Кнопка',
        branch: 'feature/button',
        groupIndex: 0,
        conversation: OLD,
        stage: 'work',
        reviewedAt: '2026-10-19T06:59:00.000Z',
        groupTask: `Задача группы:\n- ${TASK}`,
        createdAt: '2026-10-19T06:40:00.000Z',
      };
      const file = join(cfg, 'agentdeck', 'state.json');
      const state = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(
        file,
        `${JSON.stringify({ ...state, splitPlans: { [PARENT]: plan }, chatLinks: { [OLD]: link } })}\n`,
      );
    },
  },
  async (stand, check) => {
    const calls = () => readCalls(stand.bin);
    const tree = async (id) => (await stand.api(`/chat/${id}/tree`)).body;
    const groupOf = async () => (await tree(PARENT))?.split?.groups?.[0];
    /** Ждать, пока группа перестанет идти (ход кончился так или иначе). */
    const settled = async (since) => {
      for (let t = 0; t < 45_000; t += 300) {
        await wait(300);
        const group = await groupOf();
        if (calls().length > since && group && group.status !== 'running') return group;
      }
      return groupOf();
    };

    const first = await stand.api(`/chat/split/${PARENT}/recheck`, {
      method: 'POST',
      body: { index: 0 },
    });
    check('«Перепроверить MR» принят', first.status === 200, first.text.slice(0, 300));
    await settled(0);
    const firstCalls = calls();
    const answered = firstCalls.find((call) => call.outcome === 'answered');
    check(
      'CLI позван новым разговором — без --resume прежней сессии',
      firstCalls.length > 0 && firstCalls.every((call) => call.resume === undefined),
      JSON.stringify(firstCalls.map((call) => ({ resume: call.resume, outcome: call.outcome }))),
    );
    check(
      'новый разговор — в копии группы',
      answered?.cwd?.toLowerCase() === copy.toLowerCase(),
      `${answered?.cwd} vs ${copy}`,
    );
    const text = answered?.text ?? '';
    check(
      'вводная: разговор новый, прежний назван и остаётся в истории',
      /NEW conversation/.test(text) && text.includes(OLD) && /chat history/.test(text),
      text.slice(0, 900),
    );
    check(
      'вводная: ветка, копия, MR, задание группы, указатель на PROGRESS.md',
      text.includes('feature/button') &&
        [copy, copy.replaceAll('\\', '/')].some((form) =>
          text.toLowerCase().includes(form.toLowerCase()),
        ) &&
        text.includes(MR) &&
        text.includes(TASK) &&
        text.includes('.agent/PROGRESS.md'),
      text.slice(0, 900),
    );
    check(
      'охват: файлы ветки против цели MR — web/Button.tsx, и не go.mod',
      /Scope/.test(text) &&
        /In scope \(1\):\n\s+- web\/Button\.tsx\n/.test(text) &&
        !/In scope[^]*?svc\/go\.mod[^]*?Outside the scope/.test(text),
      text.slice(text.indexOf('Scope'), text.indexOf('Scope') + 900),
    );
    check(
      'чужое для MR названо: svc/go.mod не коммитят, add -A запрещён',
      /svc\/go\.mod/.test(text) && /never stage, commit/.test(text) && /git add -A/.test(text),
      text.slice(text.indexOf('Scope'), text.indexOf('Scope') + 900),
    );
    check(
      'и сами проверки перепроверки на месте',
      text.includes('recheck its delivered MR') && text.includes('4. Completeness.'),
      text.slice(0, 300),
    );

    check(
      'прежний разговор цел: транскрипт не тронут',
      readFileSync(oldFile, 'utf8') === OLD_TRANSCRIPT,
      readFileSync(oldFile, 'utf8').slice(0, 300),
    );
    const oldTree = await tree(OLD);
    check(
      'прежний разговор по-прежнему под родителем',
      JSON.stringify(oldTree ?? {}).includes(PARENT),
      JSON.stringify(oldTree ?? {}).slice(0, 300),
    );
    const fresh = answered?.session;
    const newTree = fresh ? await tree(fresh) : undefined;
    check(
      'новая сессия связана с группой',
      Boolean(fresh) && fresh !== OLD && JSON.stringify(newTree ?? {}).includes(PARENT),
      JSON.stringify(newTree ?? {}).slice(0, 300),
    );
    const group = await groupOf();
    check(
      'группа ведётся новым разговором, а не прежним',
      Boolean(group?.chatId) && group.chatId !== OLD,
      JSON.stringify({ chatId: group?.chatId, status: group?.status, error: group?.error }),
    );

    // Следующее слово панели группе — напоминание доставки после проверки
    // (фордж не настроен, MR не сверить): оно обязано прийти в НОВУЮ сессию.
    const before = calls().length;
    let next = [];
    for (let t = 0; t < 90_000 && next.length === 0; t += 500) {
      await wait(500);
      next = calls().slice(before);
    }
    // Живой процесс (пул живых сессий) берёт слово вторым ходом без нового
    // `--resume` — тогда `resume` у записи пуст, а сессия та же; новый процесс
    // обязан продолжать именно новую сессию, а не прежнюю.
    check(
      'следующее слово группе — в той же новой сессии',
      fresh !== OLD &&
        next.length > 0 &&
        next.every(
          (call) => call.session === fresh && (call.resume === undefined || call.resume === fresh),
        ),
      JSON.stringify(
        next.map((call) => ({
          resume: call.resume,
          session: call.session,
          outcome: call.outcome,
          text: call.text?.slice(0, 200),
        })),
      ),
    );
  },
);
