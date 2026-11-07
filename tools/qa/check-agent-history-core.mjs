/**
 * «Агенты» чата над ядром (этап 11, W3-17) — настоящая дорога человека: одноразовая панель с
 * фронтом, своё ядро, НАСТОЯЩИЙ CLI из PATH, Chromium кликает в окне чата `/chat`; модель — сценарий
 * `packages/stub-model` в этом процессе (единственное, что подменено). Узлы окна приходят от ядра
 * (`GET /api/core/agents?conversationId=`), транскрипты CLI панель для этого не читает.
 *
 * Что видно:
 *   1. ход claude (модель чата не названа — потолок субагента называет CLI): модель зовёт `Agent`
 *      (модель sonnet), затем фоновый `Bash` на ~60 с — над полем
 *      ввода карточка «Агенты · фоном: 1»; в окне строка субагента с моделью «sonnet» и фоновая
 *      строка «идёт»; в «Плане агента» строка того же субагента — модель и вызовы от ядра; затем
 *      фон «завершён (код 0)», а карточка — «фоновых нет»;
 *   2. второй ход: фоновый `Bash` надолго, хост сессий ядра снят — ядро закрывает сироту: снята
 *      уборкой (`reaped`, сигнал `bg-orphan`) — «осиротел — снят уборкой»; CLI не назвал номер
 *      процесса (`lost` без сигнала, так у claude) — по аварийному концу владельца «осиротел —
 *      потерян». Жив ли процесс команды после этого — печатается;
 *   2б. чат Б той же группы, фильтр «Группа»: сирота чата А в окне чата Б — подробность находит
 *      владельца в другом чате и говорит «осиротел — потерян» (членство в группе подменено — см.
 *      `groupOwnerStep`);
 *   3. чат на другом CLI (`qwen`, если есть в PATH): карточка «Агенты» тоже есть — окно не
 *      привязано к транскрипту Claude.
 *
 * Отрицательный — мутант `runningBackground` (карточка не считает фон): шаг 1 краснеет на
 * «фоном: 1» (`node ~/.claude/tools/mustfail.mjs --cmd "node tools/qa/check-agent-history-core.mjs"
 * --mutate apps/web/src/entities/AgentTree/model/coreAgents.ts ...`); мутант `ownerPool` (только
 * узлы чата) — шаг 2б краснеет на «осиротел — потерян».
 *
 * Запуск: `node tools/qa/check-agent-history-core.mjs` (стенд свой, `pnpm dev` не нужен; нет `claude`
 * в PATH — «не проверено»). `SHOTS=<dir>` — кадры карточки и окна.
 * Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NotChecked,
  coreSessionIdentities,
  createdOfStart,
  reapCoreSessions,
  runOnStand,
  wait,
} from './throwaway-stand.mjs';
import { cliDir } from './panel-agent-core-stand.mjs';
import { openProjectChat } from './chat-walk.mjs';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';
import { killLeftovers } from '../../apps/server/src/lib/kill-tree.mjs';

const SHOTS = process.env.SHOTS || '';
const BG_SHORT = 'node -e "setTimeout(()=>console.log(\'bg-done\'),60000)"';
const BG_LONG = 'node -e "setTimeout(()=>console.log(\'never\'),600000)"';

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((b) => b?.type === 'text')
          .map((b) => b.text ?? '')
          .join('\n')
      : '';

/**
 * Ход модели по последнему сообщению человека: `PROBE_AGENTS` — Agent(sonnet), затем фоновый Bash
 * на 60 с, затем текст; `PROBE_ORPHAN` — фоновый Bash надолго, затем текст. Запрос субагента знает
 * только свою вводную `PROBE_SUB`. Прочие запросы (заголовок чата) — короткий текст.
 */
function agentsScript(ctx) {
  const messages = Array.isArray(ctx.request.body?.messages) ? ctx.request.body.messages : [];
  if (ctx.request.raw.includes('PROBE_SUB') && !ctx.request.raw.includes('PROBE_AGENTS'))
    return 'DONE PROBE_SUB';
  let at = -1;
  messages.forEach((m, i) => {
    if (m?.role === 'user' && /PROBE_(AGENTS|ORPHAN)/.test(textOf(m.content))) at = i;
  });
  if (at < 0) return 'OK';
  const ask = /PROBE_(AGENTS|ORPHAN)/.exec(textOf(messages[at].content))[1];
  const used = messages
    .slice(at + 1)
    .filter((m) => m?.role === 'assistant' && Array.isArray(m.content))
    .reduce((n, m) => n + m.content.filter((b) => b?.type === 'tool_use').length, 0);
  if (ask === 'AGENTS') {
    if (used === 0)
      return {
        tool: {
          name: 'Agent',
          args: {
            description: 'probe subagent',
            // Хук набора панели `agent-prompt-guard` (слой сеанса чата) отказывает вызову без
            // этих двух меток — живой прогон 06.11; настоящая модель дописала бы их по отказу.
            prompt: 'PROBE_SUB answer DONE. [return-format] one line. [no-subagents]',
            subagent_type: 'general-purpose',
            model: 'sonnet',
          },
        },
      };
    if (used === 1)
      return {
        tool: {
          name: 'Bash',
          args: { command: BG_SHORT, description: 'bg short', run_in_background: true },
        },
      };
    return 'DONE PROBE_AGENTS';
  }
  if (used === 0)
    return {
      tool: {
        name: 'Bash',
        args: { command: BG_LONG, description: 'bg long', run_in_background: true },
      },
    };
  return 'DONE PROBE_ORPHAN';
}

const dir = cliDir('claude');
const qwenDir = cliDir('qwen');
const repo = { dir: '' };
const model = await startStubModel({ script: agentsScript });
const stubEnv = { ANTHROPIC_BASE_URL: model.baseUrl, ANTHROPIC_API_KEY: 'stand-stub-key' };

async function shoot(page, target, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(300);
    await target.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.colorScheme = 'light';
  });
}

try {
  await runOnStand(
    {
      label: 'agent-history-core',
      core: true,
      env: stubEnv,
      extraPath: [dir, qwenDir].filter(Boolean),
      seed: ({ root, cfg }) => {
        repo.dir = join(root, 'repo');
        mkdirSync(repo.dir, { recursive: true });
        const git = (...a) => execFileSync('git', a, { cwd: repo.dir, encoding: 'utf8' });
        git('init', '-q', '-b', 'main');
        git('config', 'user.name', 'stand');
        git('config', 'user.email', 'stand@example.invalid');
        writeFileSync(join(repo.dir, 'README.md'), 'repo\n');
        git('add', '.');
        git('commit', '-qm', 'init');
        // Вход claude — адрес и ключ заглушки в личном слое (ядро передаёт его CLI как есть).
        const settingsPath = join(cfg, 'settings.json');
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        writeFileSync(settingsPath, `${JSON.stringify({ ...settings, env: stubEnv }, null, 2)}\n`);
      },
    },
    async (stand, check) => {
      if (!dir) throw new NotChecked('claude нет в PATH');
      const { chromium } = await import('playwright');
      const tasksDir = join(stand.coreHome, 'tasks');
      const tasks = () => (existsSync(tasksDir) ? readdirSync(tasksDir) : []);
      const journal = (taskId) => {
        const name = readdirSync(join(tasksDir, taskId)).find((f) => f.endsWith('.jsonl'));
        if (!name) return [];
        return readFileSync(join(tasksDir, taskId, name), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      };
      const tail = (taskId, n = 10) =>
        journal(taskId)
          .filter((l) => l.kind !== 'tool.event' && l.kind !== 'turn.usage')
          .slice(-n)
          .map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 200)}`)
          .join('\n      ');
      const until = async (probe, seconds) => {
        for (let i = 0; i < seconds * 2; i++) {
          const got = await probe();
          if (got) return got;
          await wait(500);
        }
        return undefined;
      };

      // Модель чата не названа — как у человека по умолчанию: потолок субагента — модель, которую
      // CLI назвал для сеанса (правка ядра после живого прогона 06.11, где без названной модели
      // судья отказывал любому субагенту с явной моделью — `subagent-model-unknown`).
      const browser = await chromium.launch();
      try {
        const page = await openProjectChat(stand, browser, repo.dir, 'repo');
        const say = async (text) => {
          const input = page.locator('textarea[data-chat-input]');
          await input.fill(text);
          await input.press('Enter');
        };
        const card = page.locator('[data-agent-history-card]');
        const bgBadge = page.locator('[data-agent-history-bg]');
        const modal = page.locator('[data-agent-history-modal]');
        const openModal = async () => {
          if (await modal.isVisible().catch(() => false)) return;
          await page.locator('[data-agent-history-open]').click();
          await modal.waitFor({ timeout: 15_000 });
        };
        const closeModal = async () => {
          if (!(await modal.isVisible().catch(() => false))) return;
          await page.keyboard.press('Escape');
          await modal.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
        };
        const bgRows = modal.locator('[data-agent-row][data-agent-kind="background-shell"]');
        // Последний ответ ядра со списком узлов — в подробности провала: что окно получило.
        let lastList = [];
        page.on('response', (res) => {
          if (!/\/api\/core\/agents\?/.test(res.url())) return;
          void res
            .json()
            .then((body) => {
              if (Array.isArray(body?.nodes)) lastList = body.nodes;
            })
            .catch(() => undefined);
        });
        const listDump = () =>
          lastList
            .map(
              (n) =>
                `${n.kind}/${n.status} ${n.nodeId} parent=${n.parentId} model=${n.model} signals=${n.signals.join('|')}`,
            )
            .join('\n      ') || 'список не приходил';

        /**
         * 2б. Фильтр группы: владелец узла — в другом чате группы. Окно чата Б под фильтром группы
         * показывает потерянную фоновую работу чата А; её подробность обязана найти владельца
         * (сеанс задачи А, `lost`) и сказать «осиротел — потерян», хотя в узлах чата Б его нет
         * (`ownerPool`, ревью волны 3). Чат Б и все узлы — настоящие, от ядра этого стенда; подменено
         * одно членство в группе: задачу с `groupId`, начатую из чата, панель сейчас не заводит
         * (пункты `group-item` собирает только API ядра). Поэтому ответ `/tasks/<Б>` получает
         * `groupId`, а список `?groupId=` — все узлы ядра стенда (ровно задачи А и Б).
         * Различает только сирота без сигнала `bg-orphan`: со снятым уборкой или с сигналом слово
         * не зависит от владельца — тогда шаг печатает «не проверено».
         */
        const groupOwnerStep = async (chatA) => {
          const orphan = chatA.find(
            (n) =>
              n.kind === 'background-shell' &&
              n.status === 'lost' &&
              !n.signals.includes('bg-orphan'),
          );
          const owner = orphan
            ? chatA.find((n) => n.taskId === orphan.taskId && n.nodeId === orphan.parentId)
            : undefined;
          if (!orphan || !owner || !['lost', 'failed', 'killed'].includes(owner.status)) {
            console.log(
              `  ~ фильтр группы: сирота без сигнала с аварийным владельцем не вышла — не проверено (${orphan?.status ?? 'нет'}/${owner?.status ?? 'нет'})`,
            );
            return;
          }
          const GROUP = 'group-qa-owner';
          const pageB = await openProjectChat(stand, browser, repo.dir, 'repo');
          try {
            let listB = [];
            pageB.on('response', (res) => {
              if (!/\/api\/core\/agents\?/.test(res.url()) || /groupId=/.test(res.url())) return;
              void res
                .json()
                .then((body) => {
                  if (Array.isArray(body?.nodes)) listB = body.nodes;
                })
                .catch(() => undefined);
            });
            const beforeB = tasks();
            const inputB = pageB.locator('textarea[data-chat-input]');
            await inputB.fill('чат Б группы');
            await inputB.press('Enter');
            const taskB = await until(() => tasks().find((t) => !beforeB.includes(t)), 90);
            check(`фильтр группы: задача чата Б заведена (${taskB ?? 'нет'})`, Boolean(taskB));
            if (!taskB) return;
            await pageB.route(new RegExp(`/api/core/tasks/${taskB}(\\?|$)`), async (route) => {
              const res = await route.fetch();
              const body = await res.json();
              await route.fulfill({
                response: res,
                json: { ...body, view: { ...body.view, groupId: GROUP } },
              });
            });
            await pageB.route(/\/api\/core\/agents\?[^#]*groupId=/, async (route) => {
              const url = new URL(route.request().url());
              url.searchParams.delete('groupId');
              await route.continue({ url: url.toString() });
            });
            await pageB.locator('[data-agent-history-card]').waitFor({ timeout: 60_000 });
            const modalB = pageB.locator('[data-agent-history-modal]');
            await pageB.locator('[data-agent-history-open]').click();
            await modalB.waitFor({ timeout: 15_000 });
            const ownB = await until(() => (listB.length > 0 ? listB : undefined), 30);
            check(
              `фильтр группы: владелец сироты не среди узлов чата Б (${(ownB ?? []).length} узл.)`,
              Boolean(ownB) &&
                !ownB.some((n) => n.taskId === owner.taskId && n.nodeId === owner.nodeId),
            );
            const groupSelect = modalB
              .locator('[data-agent-filters]')
              .getByLabel('Группа', { exact: true });
            const offered = await until(
              async () => ((await groupSelect.count()) > 0 ? true : undefined),
              30,
            );
            check('фильтр группы: поле «Группа» в окне чата Б', Boolean(offered));
            if (!offered) return;
            await groupSelect.selectOption(GROUP);
            const row = modalB.locator(`[data-agent-row="${orphan.nodeId}"]`);
            await row.waitFor({ timeout: 30_000 });
            await row.click();
            const status = modalB.locator(`[data-bg-detail="${orphan.nodeId}"] [data-node-status]`);
            const look = await until(
              async () =>
                (await status.getAttribute('data-node-status').catch(() => null)) ?? undefined,
              30,
            );
            const word = (await status.innerText().catch(() => '')).replace(/\s+/g, ' ');
            check(
              `фильтр группы: подробность сироты чата А из чата Б — «осиротел — потерян» (${look ?? 'нет'}: ${word})`,
              look === 'orphanLost',
            );
            await shoot(pageB, modalB, 'modal-group-owner');
          } finally {
            await pageB.close();
          }
        };

        // ── 1. Agent(sonnet) + фон на 60 с ─────────────────────────────────────────────────────
        const before = tasks();
        await say('PROBE_AGENTS: раздай работу и запусти фон');
        const taskId = await until(() => tasks().find((t) => !before.includes(t)), 90);
        check(`ход 1: задача ядра заведена (${taskId ?? 'нет'})`, Boolean(taskId));
        if (!taskId) return;
        const bgStarted = await until(
          () => journal(taskId).find((l) => l.kind === 'bg.started'),
          150,
        );
        check('ход 1: ядро записало bg.started', Boolean(bgStarted), tail(taskId));
        if (!bgStarted) return;

        const live = await until(
          async () =>
            (await bgBadge.getAttribute('data-agent-history-bg').catch(() => null)) === '1',
          30,
        );
        const badgeText = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ');
        check(
          `карточка над полем ввода — «фоном: 1» (${badgeText})`,
          Boolean(live) && /фоном: 1/.test(badgeText),
        );
        await shoot(page, card, 'card-bg-running');

        await openModal();
        const subRow = modal.locator('[data-agent-row][data-agent-kind="subagent"]').first();
        const subText = (await subRow.innerText().catch(() => '')).replace(/\s+/g, ' ');
        check(
          `окно: строка субагента с моделью «sonnet» (${subText})`,
          /sonnet/.test(subText),
          `${listDump()}\n      журнал агентов: ${
            journal(taskId)
              .filter((l) => /^agent\./.test(l.kind))
              .map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 160)}`)
              .join('\n      ') || 'строк agent.* нет'
          }\n      вызов Agent в журнале: ${
            journal(taskId)
              .filter(
                (l) =>
                  l.kind !== 'turn.usage' &&
                  (/"Agent"|subagent|PROBE_SUB/.test(JSON.stringify(l.data ?? {})) ||
                    (l.kind === 'decision' && l.data?.class === 'hook-block')),
              )
              .slice(0, 12)
              .map(
                (l) =>
                  `${l.kind} ${JSON.stringify(l.data).slice(0, 240)}${
                    l.data?.output?.detail ? ` — ${String(l.data.output.detail).slice(0, 400)}` : ''
                  }`,
              )
              .join('\n      ') || 'нет'
          }`,
        );
        const runningText = (
          await bgRows
            .first()
            .innerText()
            .catch(() => '')
        ).replace(/\s+/g, ' ');
        check(`окно: фоновая строка «идёт» (${runningText})`, /идёт/.test(runningText));
        await shoot(page, modal, 'modal-bg-running');
        const subId = await subRow.getAttribute('data-agent-row').catch(() => null);
        await closeModal();

        // «План агента»: строка того же субагента берёт модель и вызовы у ядра — транскрипт
        // субагента панель не читает (ревью волны 3: без этого строка стояла голой).
        const sheet = page.locator('[data-chat-progress]');
        if (subId) {
          const head = sheet.locator('button[aria-expanded]').first();
          if ((await head.getAttribute('aria-expanded').catch(() => null)) === 'false')
            await head.click().catch(() => undefined);
          const metrics = await until(async () => {
            const text = await sheet
              .locator(`[data-agent-node="${subId}"] [data-agent-metrics]`)
              .first()
              .innerText()
              .catch(() => '');
            return /sonnet/.test(text) ? text.replace(/\s+/g, ' ') : undefined;
          }, 30);
          check(
            `«План агента»: строка субагента с моделью и вызовами от ядра (${metrics ?? 'нет'})`,
            Boolean(metrics) && /вызов/.test(metrics ?? ''),
            listDump(),
          );
          await shoot(page, sheet, 'progress-sheet-subagent');
        } else check('«План агента»: id строки субагента в окне не найден', false, listDump());
        await openModal();

        const ended = await until(() => journal(taskId).find((l) => l.kind === 'bg.ended'), 90);
        check(
          `ход 1: фон кончился сам (${ended?.data?.how ?? 'нет'} код ${ended?.data?.exitCode ?? '—'})`,
          ended?.data?.how === 'exit',
          tail(taskId),
        );
        const doneText = await until(async () => {
          const text = (
            await bgRows
              .first()
              .innerText()
              .catch(() => '')
          ).replace(/\s+/g, ' ');
          return /завершён \(код 0\)/.test(text) ? text : undefined;
        }, 30);
        check(
          `окно без F5: фоновая строка «завершён (код 0)» (${doneText ?? 'нет'})`,
          Boolean(doneText),
        );
        await bgRows.first().click();
        const detail = page.locator('[data-bg-detail]');
        const detailText = (await detail.innerText({ timeout: 15_000 }).catch(() => '')).replace(
          /\s+/g,
          ' ',
        );
        check(
          `подробно о фоне: команда и «завершён (код 0)» (${detailText.slice(0, 160)})`,
          detailText.includes('setTimeout') && /завершён \(код 0\)/.test(detailText),
        );
        await shoot(page, modal, 'modal-bg-done');
        await closeModal();
        const none = await until(
          async () => (await bgBadge.innerText().catch(() => '')).includes('фоновых нет'),
          30,
        );
        check('карточка после конца фона — «фоновых нет»', Boolean(none));

        // ── 2. Фон надолго, хост сессий снят — «осиротел» ──────────────────────────────────────
        await until(
          () => journal(taskId).some((l) => l.kind === 'turn.ended' || l.kind === 'step.ended'),
          60,
        );
        const bgCount = () => journal(taskId).filter((l) => l.kind === 'bg.started').length;
        await say('PROBE_ORPHAN: запусти долгий фон');
        const second = await until(() => (bgCount() >= 2 ? true : undefined), 120);
        check('ход 2: второй bg.started', Boolean(second), tail(taskId));
        if (second) {
          await wait(2000);
          const hosts = coreSessionIdentities(stand.coreHome).filter((id) => id.role === 'host');
          const batch = new Map();
          for (const id of hosts) {
            const created = createdOfStart(id.start);
            if (typeof created === 'bigint') batch.set(id.pid, created);
          }
          const killed = killLeftovers(batch, { slackMs: 0 });
          check(`хост сессий снят (${killed.join(',') || 'никто'})`, killed.length > 0);
          const reaped = await until(
            () =>
              journal(taskId).find(
                (l) =>
                  l.kind === 'bg.ended' && (l.data?.how === 'reaped' || l.data?.how === 'lost'),
              ),
            120,
          );
          const orphanSignal = await until(
            () =>
              journal(taskId).find(
                (l) =>
                  /signal|observer|decision/.test(l.kind) &&
                  JSON.stringify(l.data).includes('bg-orphan'),
              ),
            30,
          );
          // Снять было нечего (CLI не назвал pid / процесса уже нет) — ядро закрывает работу `lost`
          // без сигнала (observer/background/orphan.ts); сносила уборка — сигнал `bg-orphan` обязателен.
          const swept = /^(reaped|not reaped):/.test(reaped?.data?.summary ?? '');
          check(
            `ядро закрыло сироту (${reaped?.data?.how ?? 'нет'}: ${reaped?.data?.summary ?? ''}; bg-orphan ${orphanSignal?.kind ?? 'нет'})`,
            Boolean(reaped) && (!swept || Boolean(orphanSignal)),
            tail(taskId),
          );
          // Процесс долгой команды после снятия хоста — факт для отчёта, не вердикт окна.
          const leftover = execFileSync(
            'powershell',
            [
              '-NoProfile',
              '-Command',
              "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*never*600000*' }).Count",
            ],
            { encoding: 'utf8' },
          ).trim();
          console.log(`  · процессов долгой команды после снятия хоста: ${leftover}`);
          const want =
            reaped?.data?.how === 'reaped' ? /осиротел — снят уборкой/ : /осиротел — потерян/;
          await openModal();
          const orphanText = await until(async () => {
            const texts = await bgRows.allInnerTexts().catch(() => []);
            return texts.map((t) => t.replace(/\s+/g, ' ')).find((t) => want.test(t));
          }, 40);
          check(
            `окно: фоновая строка ${want.source} (${orphanText ?? 'нет'})`,
            Boolean(orphanText),
            listDump(),
          );
          await shoot(page, modal, 'modal-bg-orphan');
          await closeModal();
          await groupOwnerStep(lastList);
        }
        await page.close();

        // ── 3. Чат на другом CLI — карточка тоже есть ──────────────────────────────────────────
        if (!qwenDir) {
          console.log('  ~ qwen нет в PATH — карточка у чужого CLI не проверена');
        } else {
          const set = await stand.api('/settings', {
            method: 'PATCH',
            headers: { origin: stand.webUrl },
            body: { provider: 'qwen' },
          });
          check(`активный CLI — qwen (${set.status})`, set.status === 200, set.text.slice(0, 200));
          const qwenPage = await openProjectChat(stand, browser, repo.dir, 'repo');
          const beforeQ = tasks();
          const input = qwenPage.locator('textarea[data-chat-input]');
          await input.fill('привет от qwen');
          await input.press('Enter');
          const qTask = await until(() => tasks().find((t) => !beforeQ.includes(t)), 90);
          const started = qTask
            ? journal(qTask).find((l) => l.kind === 'session.started')?.data?.adapter
            : undefined;
          check(
            `qwen: задача ядра заведена (${qTask ?? 'нет'}, ${started ?? '?'})`,
            Boolean(qTask),
          );
          const shown = await qwenPage
            .locator('[data-agent-history-card]')
            .waitFor({ timeout: 60_000 })
            .then(() => true)
            .catch(() => false);
          check('qwen: карточка «Агенты» над полем ввода есть', shown, qTask ? tail(qTask) : '');
          await qwenPage.close();
        }
      } finally {
        await browser.close();
        reapCoreSessions(stand.coreHome);
      }
    },
  );
} finally {
  await model.close();
}
