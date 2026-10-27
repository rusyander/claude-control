import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `tests-cli delivery` — вся проверка доставки группы у неё в копии, ДО ответа
 * (g3 25.10, N1): описание MR и строки сит группа узнавала только следующим кругом,
 * круг стоил ~427k токенов. Настоящий процесс CLI, настоящий git с MR как служебной
 * ссылкой GitLab, состояние панели — в своём каталоге настроек; подменена только сеть
 * (`insteadOf` уводит адрес форджа на голый репозиторий на диске) и сама панель — HTTP-
 * заглушка `GET /api/integrations/forge/mr-review` (F-14: живое MR читает панель).
 */
const PANEL_TOKEN = 'test-panel-token';
const CLI = resolve(__dirname, '../../../../../../tools/tests-cli.mjs');
const WEB = 'https://git.example.com/team/app';
const MR = `${WEB}/-/merge_requests/1`;
const STARTED = '2026-10-25T08:00:00.000Z';
const WORK = '2026-10-25T09:00:00.000Z';
/**
 * Пробел сита browser-focus: своей строкой или номером в свёрнутой строке того же
 * пробела («— the same holds for …», аудит g0 F5).
 */
const SIEVE_BROWSER_FOCUS =
  /^- sieve (browser-focus\b|[^\n]*the same holds for [^\n]*\bbrowser-focus\b)/m;

function git(cwd: string, args: string[], date = WORK): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).trim();
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

describe('tests-cli delivery: проверка доставки до ответа', { timeout: 90_000 }, () => {
  let root = '';
  let work = '';
  let config = '';
  let home = '';
  let panel: Server;
  let panelUrl = '';
  /** Что отвечает заглушка панели; по умолчанию — ключа форджа нет. */
  let panelReply: object = { review: null, reason: 'no-token' };
  const asked: { url: string | null; auth: string | undefined }[] = [];
  /** Ответ `…/jira/issue/:key/comments` по ключу; по умолчанию трекер не подключён. */
  let commentsReply: (key: string) => { status: number; body: object } = () => ({
    status: 200,
    body: { comments: null, reason: 'not-connected' },
  });
  const commentsAsked: { key: string; auth: string | undefined }[] = [];

  beforeEach(async () => {
    asked.length = 0;
    commentsAsked.length = 0;
    panelReply = { review: null, reason: 'no-token' };
    commentsReply = () => ({ status: 200, body: { comments: null, reason: 'not-connected' } });
    panel = createServer((req, res) => {
      const at = new URL(req.url ?? '/', 'http://x');
      const comments = /^\/api\/integrations\/jira\/issue\/([^/]+)\/comments$/u.exec(at.pathname);
      if (comments) {
        const key = decodeURIComponent(comments[1] ?? '');
        commentsAsked.push({ key, auth: req.headers.authorization });
        const reply = commentsReply(key);
        res
          .writeHead(reply.status, { 'content-type': 'application/json' })
          .end(JSON.stringify(reply.body));
        return;
      }
      if (at.pathname !== '/api/integrations/forge/mr-review') {
        res.writeHead(404).end();
        return;
      }
      asked.push({ url: at.searchParams.get('url'), auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(panelReply));
    });
    await new Promise<void>((done) => panel.listen(0, '127.0.0.1', done));
    panelUrl = `http://127.0.0.1:${(panel.address() as AddressInfo).port}`;
    root = mkdtempSync(join(tmpdir(), 'cc-delivery-cli-'));
    // Свой домашний каталог: токен API панели — тестовый, настоящий не читается.
    home = join(root, 'home');
    write(home, { '.agentdeck/api-token': `${PANEL_TOKEN}\n` });
    const bare = join(root, 'remote.git');
    work = join(root, 'work');
    config = join(root, 'config');
    mkdirSync(work);
    git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
    git(work, ['init', '-q', '-b', 'main']);
    mkdirSync(join(work, '.git', 'info'), { recursive: true });
    writeFileSync(join(work, '.git', 'info', 'exclude'), '.agent/\nanswer.md\nmr.md\n');
    write(work, { 'src/Page.tsx': 'export const Page = 1;\n' });
    git(work, ['add', '-A'], '2026-10-24T08:00:00.000Z');
    git(work, ['commit', '-q', '-m', 'seed'], '2026-10-24T08:00:00.000Z');
    git(work, ['remote', 'add', 'origin', `${WEB}.git`]);
    git(work, ['config', `url.${bare.replace(/\\/g, '/')}.insteadOf`, `${WEB}.git`]);
    git(work, ['push', '-q', 'origin', 'main']);
    git(work, ['switch', '-q', '-c', 'fix/PROJ-1']);
    // Правка интерфейса — сито browser-focus применимо, живая проверка нужна.
    write(work, { 'src/Page.tsx': 'export const Page = 2;\n' });
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'fix']);
    git(work, ['push', '-q', 'origin', 'fix/PROJ-1']);
    git(bare, ['update-ref', 'refs/merge-requests/1/head', git(work, ['rev-parse', 'HEAD'])]);
    state();
  });

  /** Состояние панели: группа плана с этой копией (поиск — по пути копии, как у `gaps`). */
  const state = (group: object = {}, chatLinks: object = {}): void =>
    write(config, {
      'agentdeck/state.json': JSON.stringify({
        splitPlans: {
          parent: {
            parentChatId: 'parent',
            projectPath: work,
            // `groups` обязателен в записи плана (`SplitPlanRecord.proposal`): сверка отданных
            // пунктов (`deferralGaps`) читает его без запасного значения.
            proposal: { shared: '', groups: [] },
            groups: [
              {
                index: 0,
                branch: 'fix/PROJ-1',
                path: work,
                startedAt: STARTED,
                status: 'started',
                mr: MR,
                ...group,
              },
            ],
          },
        },
        chatLinks,
      }),
    });

  afterEach(async () => {
    await new Promise((done) => panel.close(done));
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  // Асинхронно: заглушка панели живёт в этом же процессе и должна успеть ответить.
  /** Окружение звена: `AGENTDECK_GROUP_DELIVER_AHEAD` ставит панель процессу звена до доставки. */
  let stageEnv: Record<string, string> = {};
  beforeEach(() => {
    stageEnv = {};
  });
  const delivery = (...args: string[]) =>
    new Promise<{ code: number | null; out: string }>((done, failed) => {
      const child = spawn(process.execPath, [CLI, 'delivery', '--project', work, ...args], {
        env: {
          ...process.env,
          // Тест сам бывает запущен звеном группы — его окружение не должно решать за проверку.
          AGENTDECK_GROUP_DELIVER_AHEAD: '',
          ...stageEnv,
          CLAUDE_CONFIG_DIR: config,
          AGENTDECK_URL: panelUrl,
          HOME: home,
          USERPROFILE: home,
        },
        windowsHide: true,
      });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      const timer = setTimeout(() => child.kill(), 80_000);
      child.on('error', failed);
      child.on('close', (code) => {
        clearTimeout(timer);
        done({ code, out });
      });
    });

  const answer = (rows: object[]): void =>
    write(work, {
      'answer.md': `Done.\n\n\`\`\`agentdeck:sieves\n${JSON.stringify({ sieves: rows })}\n\`\`\`\n`,
    });

  it('этап ревью: вердикт берётся из блока review в --answer, как его запишет конвейер (группа #5 25.10)', async () => {
    state(
      { chatId: 'review-1', stageTrace: [{ stage: 'review', at: STARTED }] },
      { 'review-1': { parentChatId: 'parent', stage: 'review' } },
    );
    const sieves = '```agentdeck:sieves\n{"sieves":[]}\n```\n';
    write(work, { 'answer.md': `Done.\n\n${sieves}` });
    const bare = await delivery('--answer', 'answer.md');
    expect(bare.out).toContain('there is no reviewer verdict');
    expect(bare.out).toContain('end it with an ```agentdeck:review``` block');

    write(work, { 'answer.md': `${sieves}\n\`\`\`agentdeck:review\n{"findings":[]}\n\`\`\`\n` });
    const approved = await delivery('--answer', 'answer.md');
    expect(approved.out).not.toContain('reviewer verdict');

    write(work, {
      'answer.md': `${sieves}\n\`\`\`agentdeck:review\n{"findings":["a","b"]}\n\`\`\`\n`,
    });
    const changes = await delivery('--answer', 'answer.md');
    expect(changes.out).toContain('review findings (2) are not fixed');
    expect(changes.out).not.toContain('reviewer verdict');
  });

  // check-cannot-change (g5 25.10): звено ревью дважды перезапускало сверку ради «не отправлено /
  // нет MR» — строк, которые в звене только для чтения не снять: пуш и MR делает звено доставки.
  it('до звена доставки пуш и MR не пробелы; в звене доставки — пробелы', async () => {
    write(work, { 'src/Page.tsx': 'export const Page = 3;\n' });
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'review fix']);
    const sieves = '```agentdeck:sieves\n{"sieves":[]}\n```\n';
    write(work, { 'answer.md': `Done.\n\n${sieves}` });
    const delivering = await delivery('--answer', 'answer.md');
    expect(delivering.out).toContain('branch fix/PROJ-1 is not pushed to the remote');
    expect(delivering.out).toContain('no MR whose head is the copy HEAD');
    stageEnv = { AGENTDECK_GROUP_DELIVER_AHEAD: '1' };
    const reviewing = await delivery('--answer', 'answer.md');
    expect(reviewing.out).not.toContain('is not pushed');
    expect(reviewing.out).not.toContain('no MR whose head');
    expect(reviewing.out).toContain('The delivery stage is still ahead');
  });

  // P6 (g5 25.10): правка MR потеряла раздел «Проверки на финальном дереве» и снимков у правки
  // интерфейса не было — сверка доставки молчала о том и другом.
  it('описание MR без раздела проверок и без снимков правки интерфейса — два пробела', async () => {
    answer([{ id: 'browser-focus', status: 'pass', evidence: 'npx playwright test → 3 passed' }]);
    write(work, { 'mr.md': 'Fix the page constant.\n' });
    const bare = await delivery('--answer', 'answer.md', '--mr-description', 'mr.md');
    expect(bare.code).toBe(1);
    expect(bare.out).toMatch(
      /^- MR \S+ description: no section with the checks on the final tree/m,
    );
    expect(bare.out).toMatch(
      /^- MR \S+ description: the branch changes the UI \(src\/Page\.tsx\)/m,
    );
    write(work, {
      'mr.md':
        'Fix the page constant.\n\n## Checks on the final tree\n- type-check, lint — green\n\n' +
        'Screenshots: none — the constant is not rendered\n',
    });
    const full = await delivery('--answer', 'answer.md', '--mr-description', 'mr.md');
    expect(full.out).not.toContain('no section with the checks');
    expect(full.out).not.toContain('the branch changes the UI');
  });

  // g0 26.10 (F3): самопроверка группы судит источник строк следа задач тем же кодом, что
  // панель: файл задач в копии, описание MR и название группы — тексты, из которых цитируют.
  it('след задач: цитата из файла задач и описания MR принята, без цитаты и мимо текстов — пробелы', async () => {
    state({ taskTrace: true, title: 'Группа фильтра журнала' });
    write(work, {
      '.agent/run/tickets.md':
        '# Tracker tickets\n\n## PROJ-1 — Фильтр\n\nФильтр журнала принимает диапазон дат.\n',
      'mr.md':
        'Кнопка сброса фильтра возвращает весь журнал.\n\n## Checks on the final tree\n- test — green\n',
    });
    answer([
      {
        id: 'task-1',
        status: 'pass',
        // Без ключа задачи: цитату держит только файл задач в копии.
        evidence: '«фильтр журнала принимает диапазон дат» — src/Page.tsx:1',
      },
      {
        id: 'task-2',
        status: 'pass',
        evidence: 'MR description: «Кнопка сброса фильтра возвращает весь журнал» — src/Page.tsx:1',
      },
      { id: 'task-3', status: 'pass', evidence: 'src/Page.tsx in the diff, tests green' },
      { id: 'task-4', status: 'pass', evidence: '«правка с тестами для фильтра» — src/Page.tsx:1' },
      // Текст из записи группы в плане (`groupPointTexts`) — CLI читает его из состояния панели.
      { id: 'task-5', status: 'pass', evidence: '«Группа фильтра журнала» — src/Page.tsx:1' },
    ]);
    const out = (await delivery('--answer', 'answer.md', '--mr-description', 'mr.md')).out;
    expect(out).toMatch(/^- task point task-3 is pass with no source/m);
    expect(out).toMatch(
      /^- task point task-4: the quote «правка с тестами для фильтра» is in none/m,
    );
    expect(out).not.toMatch(/task point task-[125]\b/);
  });

  // g8 26.10 (F8): файл сит без ограды блока давал «сито не сдано» по каждой строке.
  it('файл --answer — голый JSON сит: строки приняты так же, как из блока', async () => {
    const rows = [
      { id: 'browser-focus', status: 'pass', evidence: 'npx playwright test → 3 passed' },
    ];
    write(work, { 'answer.md': JSON.stringify({ sieves: rows }, null, 2) });
    const bare = await delivery('--answer', 'answer.md');
    expect(bare.out).not.toMatch(SIEVE_BROWSER_FOCUS);
    write(work, { 'answer.md': '{"sieves": [' });
    const broken = await delivery('--answer', 'answer.md');
    expect(broken.out).toMatch(SIEVE_BROWSER_FOCUS);
  });

  it('нет строки сита — строка пробела сита и непроверенное описание MR, код 1', async () => {
    const result = await delivery();
    expect(result.code).toBe(1);
    expect(result.out).toMatch(SIEVE_BROWSER_FOCUS);
    expect(result.out).toContain(`the MR description of ${MR} was not checked`);
    expect(result.out).not.toContain('not a panel group');
    expect(result.out).not.toContain('No --answer');
  });

  it('без --answer строки прошлого раунда названы прошлым раундом; с --answer — нет (аудит g0 F5)', async () => {
    state({ sieveRows: [{ id: 'browser-focus', status: 'pass', evidence: '', at: STARTED }] });
    const earlier = await delivery();
    expect(earlier.code).toBe(1);
    expect(earlier.out).toContain(
      'No --answer: the sieve and task rows below are the ones reported in an earlier round',
    );
    expect(earlier.out).toMatch(SIEVE_BROWSER_FOCUS);
    answer([{ id: 'browser-focus', status: 'pass', evidence: 'npx playwright test → 3 passed' }]);
    const fresh = await delivery('--answer', 'answer.md');
    expect(fresh.out).not.toContain('No --answer');
  });

  it('«not checked» у живого сита — описание MR без него названо пробелом, с ним — нет', async () => {
    answer([
      {
        id: 'browser-focus',
        status: 'fail',
        evidence: 'not checked: no stand with this branch here',
      },
    ]);
    write(work, { 'mr.md': 'Fix the page constant.\n' });
    const silent = await delivery('--answer', 'answer.md', '--mr-description', 'mr.md');
    expect(silent.code).toBe(1);
    expect(silent.out).toMatch(
      new RegExp(
        `^- MR ${MR.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} description: the delivery notes \\(browser-focus\\)`,
        'm',
      ),
    );
    expect(silent.out).toContain('note (name it in the MR description)');
    write(work, { 'mr.md': 'Fix the page constant.\n\nNot checked: browser-focus — no stand.\n' });
    const named = await delivery('--answer', 'answer.md', '--mr-description', 'mr.md');
    expect(named.out).not.toContain('the delivery notes (browser-focus)');
    expect(named.out).not.toMatch(SIEVE_BROWSER_FOCUS);
    // Файл дан — описание проверяется по файлу; панель спрошена только о картинках живого MR,
    // и её «не прочитано» строк не даёт.
    expect(asked.map((item) => item.url)).toEqual([MR, MR]);
    expect(named.out).not.toContain('was not checked');
  });

  // g9 26.10 (F9): причина n/a живой проверки прятала заметки доставки — группа узнавала
  // пробелы по одному (~8 прогонов сверки, 5 правок описания MR).
  it('n/a живой проверки и заметка доставки — обе строки описания MR за один прогон', async () => {
    answer([
      { id: 'browser-focus', status: 'fail', evidence: 'not checked: no stand with this branch' },
      { id: 'contract-by-request', status: 'n/a', evidence: 'no request contract in this diff' },
    ]);
    write(work, { 'mr.md': 'Fix the page constant.\n' });
    const result = await delivery('--answer', 'answer.md', '--mr-description', 'mr.md');
    expect(result.code).toBe(1);
    expect(result.out).toMatch(
      /^- the description of MR \S+ does not give the n\/a reason .*contract-by-request/m,
    );
    expect(result.out).toMatch(/^- MR \S+ description: the delivery notes \(browser-focus\)/m);
  });

  // g9 26.10 (F9): снимки загружены в MR правкой описания прямо в фордже, файл описания их не
  // знал — следующая перезапись из файла убрала их из MR на два часа.
  it('файл описания теряет картинки живого MR — строка называет их; с ними в файле — нет', async () => {
    answer([{ id: 'browser-focus', status: 'pass', evidence: 'npx playwright test → 3 passed' }]);
    const shots =
      '![до](/uploads/1a2b/page_BEFORE.png) ![после](/uploads/1a2b/page_AFTER.png)\n' +
      '<img src="/uploads/3c4d/focus_AFTER.png" width="600">\n';
    panelReply = {
      review: {
        state: 'open',
        author: 'group',
        description: `Fix the page constant.\n\n## Checks\n- lint — green\n\n${shots}`,
        threads: [],
      },
    };
    write(work, { 'mr.md': 'Fix the page constant.\n\n## Checks\n- lint — green\n\n' });
    const dropped = await delivery('--answer', 'answer.md', '--mr-description', 'mr.md');
    expect(dropped.code).toBe(1);
    expect(dropped.out).toMatch(
      /^- the description file mr\.md drops 3 image link\(s\) the live MR \S+ shows: \/uploads\/1a2b\/page_BEFORE\.png, \/uploads\/1a2b\/page_AFTER\.png, \/uploads\/3c4d\/focus_AFTER\.png/m,
    );
    write(work, {
      'mr.md': `Fix the page constant.\n\n## Checks\n- lint — green\n\n${shots}`,
    });
    const kept = await delivery('--answer', 'answer.md', '--mr-description', 'mr.md');
    expect(kept.out).not.toContain('image link(s) the live MR');
    expect(kept.out).not.toContain('the branch changes the UI');
  });

  // F-14 (аудит g0 25.10): описание писали файлом для `--mr-description` и вторым разом —
  // в фордж (~11k токенов вывода). Без файла живое MR читает панель — её ключом форджа.
  describe('без --mr-description живое MR читает панель', () => {
    const notChecked = [
      {
        id: 'browser-focus',
        status: 'fail',
        evidence: 'not checked: no stand with this branch here',
      },
    ];

    it('описание и ветки ревьюера из панели проверены, файл не нужен', async () => {
      answer(notChecked);
      panelReply = {
        review: {
          state: 'open',
          author: 'group',
          description: 'Fix the page constant.\n',
          threads: [
            {
              id: 't1',
              resolvable: true,
              resolved: false,
              notes: [
                {
                  id: 'n1',
                  author: 'reviewer',
                  body: 'Rename this constant.',
                  createdAt: '2026-10-26T15:00:00Z',
                },
              ],
            },
            // Закрытая ветка в счёт открытых не идёт.
            {
              id: 't2',
              resolvable: true,
              resolved: true,
              notes: [
                {
                  id: 'n2',
                  author: 'reviewer',
                  body: 'Typo in the title.',
                  createdAt: '2026-10-26T14:00:00Z',
                },
              ],
            },
          ],
        },
      };
      const silent = await delivery('--answer', 'answer.md');
      expect(asked).toEqual([{ url: MR, auth: `Bearer ${PANEL_TOKEN}` }]);
      expect(silent.code).toBe(1);
      expect(silent.out).toContain('the delivery notes (browser-focus)');
      expect(silent.out).toContain('Rename this constant.');
      expect(silent.out).toContain(`The live MR ${MR} was read through the panel`);
      // Что панель увидела — цитируемой строкой (F6, g1 26.10): перечитывать MR незачем.
      expect(silent.out).toContain(
        '1 unresolved reviewer thread(s), last note by reviewer at 2026-10-26T15:00:00Z',
      );
      expect(silent.out).toContain('do not read them again through the forge');
      expect(silent.out).not.toContain(`the MR description of ${MR} was not checked`);
      expect(silent.out).not.toContain('Reviewer threads are checked by the panel only');
      // Токен API панели уходит только в заголовок — в выводе его нет.
      expect(silent.out).not.toContain(PANEL_TOKEN);

      panelReply = {
        review: {
          state: 'open',
          author: 'group',
          description: 'Fix the page constant.\n\nNot checked: browser-focus — no stand.\n',
          threads: [],
        },
      };
      const named = await delivery('--answer', 'answer.md');
      expect(named.out).not.toContain('the delivery notes (browser-focus)');
      expect(named.out).not.toContain(`the MR description of ${MR} was not checked`);
      expect(named.out).toContain(
        '0 unresolved reviewer thread(s); the description names browser-focus',
      );
      // Заметка, которую описание уже называет, — счётом, не текстом (F4, g1 26.10).
      expect(named.out).toContain('1 note(s) already named in the live MR description');
      expect(named.out).not.toContain('note (name it in the MR description)');
    });

    it('панель не прочла MR — строка с причиной и порядком «опубликуй, затем проверь»', async () => {
      const result = await delivery();
      expect(asked).toHaveLength(1);
      expect(result.code).toBe(1);
      expect(result.out).toContain(
        `the MR description of ${MR} was not checked (the panel did not read the MR: no-token): ` +
          'post it to the MR once and rerun this command',
      );
      expect(result.out).toContain('Reviewer threads are checked by the panel only');
    });

    it('панели нет — та же строка, причина названа, доставка не падает', async () => {
      await new Promise((done) => panel.close(done));
      panel = createServer();
      const result = await delivery();
      expect(result.code).toBe(1);
      expect(result.out).toMatch(
        /was not checked \(the panel did not read the MR: panel unreachable at /,
      );
    });
  });

  // g8 F4 (26.10): пробел «нет комментария со ссылкой на MR» группа узнавала только
  // следующим кругом — проверка в копии задачи трекера не видела, ключ трекера у панели.
  describe('задачи трекера: комментарии читает панель', () => {
    const gap = 'tickets PROJ-1 have no comment linking MR';
    const unread = 'the comments of tickets PROJ-1 were not read';

    it('в задаче нет комментария со ссылкой на MR — пробел; с ссылкой — пробела нет', async () => {
      commentsReply = () => ({ status: 200, body: { comments: ['Взял в работу.'] } });
      const bare = await delivery();
      expect(commentsAsked).toEqual([{ key: 'PROJ-1', auth: `Bearer ${PANEL_TOKEN}` }]);
      expect(bare.code).toBe(1);
      expect(bare.out).toContain(`${gap} ${MR}`);
      expect(bare.out).not.toContain(PANEL_TOKEN);

      commentsReply = () => ({
        status: 200,
        body: { comments: ['Взял в работу.', 'Сделано, проверка — в описании !1.'] },
      });
      const linked = await delivery();
      expect(linked.out).not.toContain(gap);
      expect(linked.out).not.toContain(unread);
    });

    it('трекер у панели не подключён — задачи не проверяются, как у панели', async () => {
      const result = await delivery();
      expect(commentsAsked).toHaveLength(1);
      expect(result.out).not.toContain(gap);
      expect(result.out).not.toContain(unread);
    });

    it('панель не прочла задачу — заметка «не прочитаны», не пробел', async () => {
      commentsReply = () => ({ status: 502, body: { comments: null, reason: 'unreachable' } });
      const result = await delivery();
      expect(result.out).toContain(unread);
      expect(result.out).not.toContain(gap);
    });

    it('до звена доставки трекер не спрашивается', async () => {
      stageEnv = { AGENTDECK_GROUP_DELIVER_AHEAD: '1' };
      commentsReply = () => ({ status: 200, body: { comments: [] } });
      const result = await delivery();
      expect(commentsAsked).toHaveLength(0);
      expect(result.out).not.toContain(gap);
    });
  });
});
