/**
 * «Перепроверить MR», когда транскрипта группы на диске уже нет (вопрос ревью Q2, 05.10.2026).
 *
 * Транскрипт Claude группы удалён мимо панели (руками, чисткой диска, другим
 * каталогом конфигурации). Панель продолжала группу `claude --resume <сессия>`,
 * CLI отвечал «No conversation found», и доставленная группа становилась
 * «упала» — а «Продолжить» падал точно так же, и выхода не было.
 *
 * Своя одноразовая панель, в записи — план разделения с одной доставленной
 * группой, её копия — настоящая папка, сессия группы известна панели, а файла
 * сессии нет. Вместо `claude` — фальшивый CLI, который ведёт себя как настоящий
 * в главном: `--resume` неизвестной сессии — итог-ошибка «No conversation
 * found…» и код 1; без `--resume` — новая сессия с файлом транскрипта в
 * `projects/`. Он пишет в `calls.jsonl`, что ДОШЛО до процесса.
 *
 * 1. «Перепроверить MR» → CLI позван БЕЗ `--resume` пропавшей сессии, в копии
 *    группы; в задании — что разговора нет, ветка и задачи группы.
 * 2. Группа не «упала»; новая сессия связана с группой.
 * 3. Следующее слово панели группе (напоминание доставки) идёт в ту же НОВУЮ
 *    сессию, а не заводит третью: разговор снова непрерывен.
 *
 * Ни настоящий `~/.claude`, ни рабочий стенд, ни настоящий CLI не трогаются.
 * Запуск: `node tools/qa/check-split-recheck-lost-transcript.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeClaudeSession, readCalls } from './fake-claude-session.mjs';
import { runOnStand, wait } from './throwaway-stand.mjs';

const PARENT = 'qa-lost-parent';
const LOST = '0b1e7c3e-0000-4000-8000-00000000a11e';
const MR = 'https://forge.example.com/team/app/-/merge_requests/77';
const TASK = 'PROJ-77 Сложение двух чисел в калькуляторе';

const FAKE_CLAUDE = fakeClaudeSession(
  `Conflicts: none. Comments: none. Pipeline: green. Tasks: done.\n${MR}`,
);

let copy = '';

await runOnStand(
  {
    web: false,
    label: 'lost-transcript',
    fakeCli: { claude: FAKE_CLAUDE },
    seed: ({ root, cfg }) => {
      // Копия — как у живой группы: git, ветка группы с коммитом, отправленная
      // в удалённый. Иначе проверка доставки после хода валит группу сама.
      copy = join(root, 'copy-g0');
      const remote = join(root, 'remote.git');
      mkdirSync(copy, { recursive: true });
      const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
      git(root, 'init', '--bare', '-q', remote);
      git(copy, 'init', '-q', '-b', 'feature/add');
      writeFileSync(join(copy, 'README.md'), '# copy\n', 'utf8');
      git(copy, 'add', '.');
      const who = ['-c', 'user.name=qa', '-c', 'user.email=qa@example.com'];
      git(copy, ...who, 'commit', '-q', '-m', 'add');
      git(copy, 'remote', 'add', 'origin', remote);
      git(copy, 'push', '-q', '-u', 'origin', 'feature/add');
      const group = {
        index: 0,
        title: 'Сложение',
        branch: 'feature/add',
        after: [],
        status: 'done',
        deliver: true,
        chatId: LOST,
        path: copy,
        startedAt: '2026-10-09T09:05:00.000Z',
        mr: MR,
      };
      const plan = {
        parentChatId: PARENT,
        projectPath: copy,
        createdAt: '2026-10-09T09:00:00.000Z',
        order: [0],
        request: {},
        proposal: { groups: [{ title: 'Сложение', branch: 'feature/add', tasks: [TASK] }] },
        groups: [group],
      };
      const link = {
        parentChatId: PARENT,
        title: 'Сложение',
        branch: 'feature/add',
        groupIndex: 0,
        conversation: LOST,
        createdAt: '2026-10-09T09:05:00.000Z',
      };
      const file = join(cfg, 'agentdeck', 'state.json');
      const state = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(
        file,
        `${JSON.stringify({ ...state, splitPlans: { [PARENT]: plan }, chatLinks: { [LOST]: link } })}\n`,
      );
    },
  },
  async (stand, check) => {
    const calls = () => readCalls(stand.bin);
    const groupOf = async () => (await stand.api(`/chat/${PARENT}/tree`)).body?.split?.groups?.[0];
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
    const afterFirst = await settled(0);
    const firstCalls = calls();
    check(
      'CLI не продолжал пропавшую сессию',
      firstCalls.length > 0 && firstCalls.every((call) => call.resume !== LOST),
      JSON.stringify(firstCalls.map((call) => ({ resume: call.resume, outcome: call.outcome }))),
    );
    const answered = firstCalls.find((call) => call.outcome === 'answered');
    check(
      'новый разговор — в копии группы',
      answered?.cwd?.toLowerCase() === copy.toLowerCase(),
      `${answered?.cwd} vs ${copy}`,
    );
    check(
      'в задании сказано, что прежнего разговора нет, и названы ветка и задачи группы',
      Boolean(
        answered &&
        /previous conversation/i.test(answered.text) &&
        answered.text.includes('feature/add') &&
        answered.text.includes(TASK) &&
        answered.text.includes(MR),
      ),
      (answered?.text ?? '').slice(0, 600),
    );
    check(
      'группа не «упала»',
      afterFirst?.status !== 'failed',
      JSON.stringify({ status: afterFirst?.status, error: afterFirst?.error }),
    );

    const links = (await stand.api(`/chat/${answered?.session}/tree`)).body;
    check(
      'новая сессия связана с группой',
      Boolean(answered?.session) && JSON.stringify(links ?? {}).includes(PARENT),
      JSON.stringify(links ?? {}).slice(0, 300),
    );

    // 3. Следующее слово панели группе — напоминание доставки после проверки
    //    (фордж не настроен, MR не сверить): оно обязано прийти в НОВУЮ сессию,
    //    а не завести третью и не упереться в пропавшую.
    const before = calls().length;
    let next = [];
    for (let t = 0; t < 90_000 && next.length === 0; t += 500) {
      await wait(500);
      next = calls().slice(before);
    }
    check(
      'следующее слово группе — в той же новой сессии',
      next.length > 0 &&
        next.every((call) => call.session === answered?.session && call.outcome === 'answered'),
      JSON.stringify(
        next.map((call) => ({ resume: call.resume, session: call.session, outcome: call.outcome })),
      ),
    );
    const later = await groupOf();
    check(
      'и группа снова не «упала» на пропавшем разговоре',
      !/No conversation found/.test(later?.error ?? ''),
      JSON.stringify({ status: later?.status, error: later?.error }),
    );
  },
);
