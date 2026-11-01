/**
 * Лента задачи ядра `/core?id=<taskId>` (этап 9, зона A) — настоящая дорога: одноразовая панель,
 * своё ядро, настоящий `claude` из PATH человека против сценария `packages/stub-model` (модель —
 * единственное, что подменено). Браузер ходит через прокладку панели, ответы ядра не перехватываются.
 *
 * Что видно:
 *   - строки ленты уникальны и идут по номеру журнала; строки + скрытые = весь журнал; после
 *     обрыва потока (жёсткий перезапуск панели) и после перезагрузки — то же самое;
 *   - заголовок каждого решения = шаблон языка интерфейса по классу и исходу строки журнала (ru, en);
 *   - проверки шага: полный прогон, затем повтор записи на том же дереве — у своих решений;
 *   - строка сессии: CLI с версией, модель, маршрут — из `session.started`;
 *   - расход = `view.spend` = сумма `turn.usage` журнала; сигналы — все строки `signal`;
 *   - карточка вопроса: двойное нажатие уходит в ядро одним конвертом, ответ ядра показан дословно;
 *   - итоговый отчёт и запись проверки — тем, что отдаёт ядро (тело или честная карточка кода);
 *   - ядро убито — карточка «Ядро задач не запущено» на странице задачи.
 *
 * Запуск: `node tools/qa/check-core-timeline.mjs` (стенд свой, `pnpm dev` не нужен; нужен `claude`
 * в PATH). `SHOTS=<dir>` — кадры в обеих темах. Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Сценарий модели: этот же файл ядро грузит как модуль заглушки ─────────────────────────────

const STEP = /agentdeck-step: ?([0-9a-f-]{36})/;
const PREFIX = 'mcp__agentdeck__';

function toolUses(body) {
  const out = [];
  for (const m of body.messages ?? []) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const c of m.content) if (c.type === 'tool_use') out.push(c);
  }
  return out;
}

/**
 * Сессия шага: если шагу предложен `check` — дважды одна и та же проверка (прогон, затем повтор
 * записи на том же дереве), потом один `step_done`. Инструменты ядра у CLI отложены — сначала
 * `ToolSearch select:`; у сессий без маркера шага — короткий текст.
 */
export function stepDoneScript({ checkArgv = null, extra = {} } = {}) {
  return (ctx) => {
    const body = ctx.request.body ?? {};
    const text = JSON.stringify(body);
    const stepId = STEP.exec(text)?.[1];
    if (!stepId) return { text: 'stub side reply' };
    const used = toolUses(body);
    const count = (name) => used.filter((u) => u.name === PREFIX + name).length;
    const loader = ctx.info.tools.find((t) => t.name === 'ToolSearch');
    const direct = (name) => ctx.info.tools.some((t) => t.name === PREFIX + name);
    const offered = (name) => direct(name) || (loader && text.includes(PREFIX + name));
    let need = null;
    if (checkArgv && offered('check') && count('check') < 2) need = 'check';
    else if (count('step_done') < 1) need = 'step_done';
    if (!need) return { text: 'step reported' };
    const full = PREFIX + need;
    if (direct(need)) {
      const args =
        need === 'check'
          ? { argv: checkArgv }
          : { stepId, outcome: 'done', requirements: [], summary: 'stub step done', ...extra };
      return { tool: { name: full, args } };
    }
    const loaded = used.some(
      (u) => u.name === 'ToolSearch' && String(u.input?.query).includes(full),
    );
    if (loader && !loaded) {
      return { tool: { name: 'ToolSearch', args: { query: `select:${full}`, max_results: 1 } } };
    }
    return { text: `no ${need} tool here` };
  };
}

// ── Проверка ──────────────────────────────────────────────────────────────────────────────────

const SELF = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase();
if (isMain) await main();

async function main() {
  const { chromium } = await import('playwright');
  const { runOnStand, NotChecked, wait } = await import('./throwaway-stand.mjs');
  const { uuidv7 } = await import('./core-scenario-stand.mjs');
  const REPO_ROOT = resolve(dirname(SELF), '..', '..');
  const fileUrl = (rel) => new URL(`file:///${join(REPO_ROOT, rel).replace(/\\/g, '/')}`).href;
  const { decisionOutcome } = await import(fileUrl('packages/contracts/src/core/decision-view.ts'));
  const { decisionsRu } = await import(
    fileUrl('apps/web/src/shared/config/i18n/core-timeline/decisions.ru.ts')
  );
  const { decisionsEn } = await import(
    fileUrl('apps/web/src/shared/config/i18n/core-timeline/decisions.en.ts')
  );

  const SHOTS = process.env.SHOTS || '';
  const CHECK_ARGV = ['node', '-e', 'process.exit(0)'];
  const CANCEL = 'Отменить задачу';

  // Стенд вырезает из PATH каталоги `claude`; дорога ленты идёт через настоящий CLI — его каталог
  // возвращается в конец PATH панели и ядра. Нет CLI — не проверено, а не провал продукта.
  const where = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
    encoding: 'utf8',
  });
  const claudeAt = where.status === 0 ? where.stdout.split(/\r?\n/)[0].trim() : '';

  const git = (cwd, args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  let repo = '';

  async function shoot(page, name) {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
        document.documentElement.style.colorScheme = t;
      }, theme);
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(SHOTS, `${name}-${theme}_AFTER.png`), fullPage: true });
    }
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
      document.documentElement.style.colorScheme = 'light';
    });
  }

  await runOnStand(
    {
      label: 'core-timeline',
      extraPath: claudeAt ? [dirname(claudeAt)] : [],
      core: {
        stub: [
          {
            name: 'stand',
            script: {
              module: SELF,
              export: 'stepDoneScript',
              args: [
                {
                  checkArgv: CHECK_ARGV,
                  extra: { extracted: [{ text: 'Write hello.txt', source: 'request' }] },
                },
              ],
            },
          },
        ],
      },
      seed: ({ root }) => {
        repo = join(root, 'repo');
        mkdirSync(join(repo, '.agentdeck'), { recursive: true });
        git(repo, ['init', '-q', '-b', 'main']);
        git(repo, ['config', 'user.name', 'stand']);
        git(repo, ['config', 'user.email', 'stand@example.invalid']);
        writeFileSync(join(repo, 'README.md'), 'stand\n');
        // Проверка в реестре репозитория: argv вне реестра ядро отклоняет (`not-registered`).
        writeFileSync(
          join(repo, '.agentdeck', 'checks.json'),
          `${JSON.stringify({ v: 1, checks: [{ id: 'probe', class: 'static', argv: CHECK_ARGV }] })}\n`,
        );
        git(repo, ['add', '.']);
        git(repo, ['commit', '-qm', 'init']);
      },
    },
    async (stand, check) => {
      if (!claudeAt) throw new NotChecked('claude не найден в PATH — дороге ленты нужен CLI');
      const token = readFileSync(join(stand.coreHome, 'token'), 'utf8').trim();
      const coreRow = JSON.parse(readFileSync(join(stand.coreHome, 'procs.json'), 'utf8')).cores.at(
        -1,
      );
      // Засев прямо в ядро — подготовка данных (оценка — экран зоны B, маршрут — настройка),
      // проверяемая дорога — браузер через прокладку.
      const direct = async (method, path, body) => {
        const res = await fetch(`${coreRow.url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const text = await res.text();
        let parsed;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          parsed = undefined;
        }
        return { status: res.status, body: parsed, text };
      };
      const proof = async () => {
        const page = uuidv7();
        const minted = await direct('GET', `/v1/nonce?page=${page}`);
        return { nonce: minted.body?.nonce, page };
      };
      const est = await direct('POST', '/v1/estimate', {
        cmdId: uuidv7(),
        fields: {
          title: 'Лента: проверка стенда',
          request: 'Write hello.txt',
          repos: [{ path: repo, baseRef: null }],
          scenario: { preset: 'bug-fix' },
          launchPolicy: 'confirm',
          ciWait: false,
        },
        proof: await proof(),
      });
      const taskId = est.body?.taskId;
      if (!taskId) throw new Error(`оценка не создала задачу: ${est.status} ${est.text}`);
      const command = async (kind, fields) =>
        direct('POST', '/v1/commands', {
          cmdId: uuidv7(),
          kind,
          target: { taskId },
          fields,
          proof: await proof(),
        });
      const route = await command('set-route', {
        scope: 'task',
        scopeId: taskId,
        allowedRoutes: [
          { adapter: 'claude', route: { kind: 'stub', id: 'stub:stand' }, modelPattern: '*' },
        ],
      });
      const model = await command('set-model', {
        scope: 'task',
        scopeId: taskId,
        model: 'stub-model',
        effort: null,
        timing: 'now',
      });
      if (route.status !== 200 || model.status !== 200) {
        throw new Error(`маршрут/модель: ${route.text} ${model.text}`);
      }

      const journal = () => {
        const dir = join(stand.coreHome, 'tasks', taskId);
        const file = readdirSync(dir).find((f) => f.endsWith('.jsonl'));
        return readFileSync(join(dir, file), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      };
      const view = async () => (await stand.api(`/core/tasks/${taskId}`)).body?.view;
      const until = async (what, probe, seconds) => {
        for (let i = 0; i < seconds; i++) {
          const got = await probe();
          if (got) return got;
          await wait(1000);
        }
        throw new Error(`не дождались: ${what}`);
      };

      const browser = await chromium.launch();
      try {
        // Высокое окно: прокрутка у панели своя (внутренний контейнер), `fullPage` её не видит.
        const page = await stand.newPage(browser, { width: 1440, height: 4400 });
        const posts = [];
        page.on('request', (r) => {
          if (r.method() === 'POST' && /\/api\/core\/commands$/.test(r.url())) posts.push(r);
        });
        await page.goto(`${stand.webUrl}/core?id=${taskId}`);
        // Первый заход холодный: Vite одноразового стенда собирает модули по запросу.
        await page
          .locator('[data-core-timeline]')
          .waitFor({ timeout: 90_000 })
          .catch(async (error) => {
            const text = (
              await page
                .locator('body')
                .innerText()
                .catch(() => '')
            ).slice(0, 400);
            throw new Error(
              `${error.message}\n    страница: ${text}\n    ошибки: ${page.errors.join(' | ')}`,
            );
          });

        /**
         * Ответ на карточке: двойное нажатие — один конверт (замок `useRef`), строка итога —
         * дословно ответ ядра через прокладку. Не принят — тот же выбор прямо в ядро, чтобы задача
         * дошла до конца; отказ прокладки назван в выводе.
         */
        async function answerOnCard(source, option, fallback) {
          const card = page.locator(`[data-core-ask][data-ask-source="${source}"]`);
          await card.waitFor({ timeout: 240_000 }).catch(async (error) => {
            const at = await page
              .locator('[data-core-timeline]')
              .getAttribute('data-last-seq')
              .catch(() => '?');
            const asks = await page
              .locator('[data-core-ask]')
              .evaluateAll((els) => els.map((e) => e.getAttribute('data-ask-source')));
            const asked = journal().filter((l) => l.kind === 'human.asked');
            const rows = [];
            for (const l of asked) {
              const li = page.locator(`li[data-core-row="${l.seq}"]`);
              rows.push(`${l.seq}: ${(await li.count()) ? await li.innerText() : 'нет строки'}`);
            }
            throw new Error(
              `${error.message}\n    лента до ${at}, журнал до ${journal().at(-1).seq}, карточки ${JSON.stringify(asks)}` +
                `\n    вид: ${JSON.stringify((await view())?.asks)}\n    строки: ${rows.join(' | ')}` +
                `\n    ошибки страницы: ${page.errors.join(' | ')}`,
            );
          });
          check(`карточка вопроса «${source}» появилась`, true);
          await shoot(page, `core-timeline-ask-${source}`);
          const before = posts.length;
          const replied = page.waitForResponse(
            (r) => r.request().method() === 'POST' && /\/api\/core\/commands$/.test(r.url()),
          );
          await card.locator(`[data-ask-option="${option}"]`).dblclick();
          const res = await replied;
          const body = await res.json().catch(() => ({}));
          const result = card.locator('[data-ask-result]');
          // Принятый ответ закрывает вопрос: поток приносит human.answered, и карточка уходит из
          // открытых — бывает, раньше, чем строка итога успела показаться (звено записано, P131).
          // Итог тогда — карточки нет; непринятый ответ вопрос не закрывает, строка итога остаётся.
          const settled = await Promise.race([
            result
              .waitFor({ timeout: 20_000 })
              .then(() => 'result')
              .catch(() => 'none'),
            card
              .waitFor({ state: 'detached', timeout: 20_000 })
              .then(() => 'closed')
              .catch(() => 'none'),
          ]);
          await page.waitForTimeout(500);
          check(
            `«${source}»: двойное нажатие — один конверт в ядро`,
            posts.length - before === 1,
            `конвертов: ${posts.length - before}`,
          );
          const closed = settled === 'closed' || (await card.count()) === 0;
          const kind = closed ? 'closed' : await result.getAttribute('data-ask-result');
          const shown = closed ? 'карточка закрыта' : await result.innerText();
          const applied = res.ok() && body.status === 'applied';
          const expected = applied
            ? null
            : typeof body.reason === 'string'
              ? body.code
                ? `${body.code}: ${body.reason}`
                : body.reason
              : String(body.error ?? '');
          check(
            `«${source}»: итог на карточке — ответ ядра дословно (${res.status()} ${body.status ?? body.code ?? ''})`,
            applied
              ? kind === 'applied' || kind === 'closed'
              : kind !== 'applied' && kind !== 'closed' && shown.includes(expected),
            `показано «${shown}», ответ ${res.status()} ${JSON.stringify(body)}`,
          );
          if (!applied) {
            console.log(
              `    прокладка не приняла ответ (${res.status()} ${body.code ?? ''}), прямо в ядро`,
            );
            const r = await fallback();
            if (r.body?.status !== 'applied') throw new Error(`ответ в ядро: ${r.text}`);
          }
        }

        const launchAsk = await until(
          'вопрос запуска в журнале',
          () => journal().find((l) => l.kind === 'human.asked' && l.data?.source === 'launch'),
          240,
        );
        await answerOnCard('launch', 'approve-split', () =>
          command('approve-split', { splitId: launchAsk.data.dedupe.slice('split:'.length) }),
        );

        // Обрыв потока посреди работы: жёсткий перезапуск панели, поток переподключается сам.
        await until(
          'шаг работы запущен',
          () => journal().some((l) => l.kind === 'session.started'),
          240,
        );
        const lastSeq = async () =>
          Number(
            await page
              .locator('[data-core-timeline]')
              .getAttribute('data-last-seq')
              .catch(() => 0),
          );
        const atRestart = journal().at(-1).seq;
        await stand.restartHard();
        // Переподключился = строки, записанные ПОСЛЕ перезапуска, дошли до ленты.
        const caught = await until(
          'лента догнала журнал после перезапуска панели',
          async () => {
            const tail = journal().at(-1).seq;
            const seen = await lastSeq();
            return tail > atRestart && seen >= tail ? { tail, seen } : null;
          },
          120,
        ).catch(async (error) => {
          const state = await page.locator('[data-stream-state]').getAttribute('data-stream-state');
          return {
            failed: `${error.message}: лента ${await lastSeq()}, журнал ${journal().at(-1).seq}, поток ${state}`,
          };
        });
        check(
          `поток переподключился: строки после перезапуска в ленте (${atRestart} → ${caught.seen ?? '—'})`,
          !caught.failed,
          caught.failed,
        );
        // Застрявший поток — дефект, но не повод бросать остальные свойства: дальше — как человек, F5.
        if (caught.failed) await page.reload();

        const capAsk = await until(
          'вопрос исчерпанных кругов',
          () =>
            journal().find(
              (l) =>
                l.kind === 'human.asked' &&
                l.data?.source === 'round-cap' &&
                !journal().some(
                  (a) => a.kind === 'human.answered' && a.data?.askId === l.data.askId,
                ),
            ),
          300,
        );
        const capId = capAsk.data.askId;
        const answerCap = () => command('answer', { askId: capId, answer: CANCEL });
        // Карточка открытого вопроса — или вопрос уже закрыт ядром без ответа: тогда карточки быть
        // не должно, а закрытие без ответа — дефект ядра (задача ждёт вопроса, которого нет).
        const capState = await until(
          'карточка точки 6 или её закрытие ядром',
          async () => {
            if ((await page.locator(`[data-core-ask="${capId}"]`).count()) === 1) return 'card';
            const state = (await view())?.asks?.find((a) => a.askId === capId)?.state;
            return state && state !== 'open' ? state : null;
          },
          120,
        );
        if (capState === 'card') {
          await answerOnCard('round-cap', CANCEL, answerCap);
        } else {
          const closed = journal().find(
            (l) => l.kind === 'ask.transition' && l.data?.askId === capId,
          );
          await page.waitForTimeout(1000);
          check(
            `закрытый ядром вопрос (${capState}) карточкой не показан`,
            (await page.locator(`[data-core-ask="${capId}"]`).count()) === 0,
          );
          check(
            'точка 6 «исчерпал круги» ждёт человека, а не закрыта ядром без ответа',
            false,
            `ядро: ${capState} на строке ${closed?.seq} через ${closed ? closed.seq - capAsk.seq : '?'} строк после вопроса, ${JSON.stringify(closed?.data)}`,
          );
          // Поздний ответ ядро принимает (06 §Human points) — задача доходит до отчёта.
          const late = await answerCap();
          if (late.body?.status !== 'applied') throw new Error(`поздний ответ: ${late.text}`);
        }

        const finalView = await until(
          'итоговый отчёт ядра',
          async () => {
            const v = await view();
            return v?.report && v?.ended ? v : null;
          },
          180,
        );
        const lines = journal();
        const last = lines.at(-1).seq;
        await until(
          'лента дошла до последней строки журнала',
          async () =>
            Number(await page.locator('[data-core-timeline]').getAttribute('data-last-seq')) >=
            last,
          30,
        );

        async function rowsSeen() {
          const seqs = await page
            .locator('li[data-core-row]')
            .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-core-row'))));
          const hidden = Number(
            (await page
              .locator('[data-core-hidden]')
              .getAttribute('data-core-hidden')
              .catch(() => '0')) ?? 0,
          );
          return { seqs, hidden };
        }
        async function checkRows(when) {
          const { seqs, hidden } = await rowsSeen();
          const unique = new Set(seqs).size === seqs.length;
          const ordered = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
          const known = new Set(lines.map((l) => l.seq));
          check(
            `${when}: строки ленты уникальны и по порядку журнала`,
            unique && ordered && seqs.every((s) => known.has(s)),
            `строк ${seqs.length}, уникальных ${new Set(seqs).size}`,
          );
          check(
            `${when}: строки + скрытые = весь журнал (${lines.length})`,
            seqs.length + hidden === lines.length,
            `строк ${seqs.length} + скрытых ${hidden}`,
          );
          return seqs;
        }
        const liveSeqs = await checkRows('после обрыва потока');

        const bySeq = new Map(lines.map((l) => [l.seq, l]));
        async function checkHeadlines(texts, lang) {
          const rows = await page
            .locator('li[data-core-row]:has([data-decision-class])')
            .evaluateAll((els) =>
              els.map((e) => ({
                seq: Number(e.getAttribute('data-core-row')),
                headline: e.querySelector('[data-decision-headline]')?.textContent ?? '',
              })),
            );
          const wrong = [];
          for (const r of rows) {
            const d = bySeq.get(r.seq)?.data ?? {};
            const outcome = decisionOutcome(d.class, d.output);
            const want = texts[d.class]?.outcomes?.[outcome];
            if (!want || r.headline !== want)
              wrong.push(`${r.seq} ${d.class}/${outcome}: «${r.headline}»`);
          }
          const total = lines.filter((l) => l.kind === 'decision').length;
          check(
            `${lang}: заголовок каждого решения = шаблон класса и исхода (${rows.length} из ${total})`,
            rows.length === total && wrong.length === 0,
            wrong.slice(0, 5).join('\n    '),
          );
        }
        await checkHeadlines(decisionsRu, 'ru');

        const checks = finalView.checks ?? [];
        const modes = checks.map((c) => c.mode);
        check(
          `проверки: прогон, затем повтор записи (${modes.join(', ')})`,
          modes.includes('run') &&
            modes.includes('replay') &&
            modes.indexOf('run') < modes.indexOf('replay'),
        );
        let checksOk = checks.length > 0;
        for (const c of checks) {
          const n = await page
            .locator(`li[data-core-row="${c.seq}"] [data-check-mode="${c.mode}"]`)
            .count();
          if (n !== 1) checksOk = false;
        }
        check(
          'проверка показана у своего решения со своим режимом',
          checksOk,
          JSON.stringify(checks),
        );

        const sessions = lines.filter((l) => l.kind === 'session.started');
        let sessionsOk = sessions.length > 0;
        const sessionDetail = [];
        for (const s of sessions) {
          const el = page.locator(`[data-core-session="${s.data.sessionId}"]`);
          const text = (await el.count()) === 1 ? await el.innerText() : '';
          const routeId = await el
            .locator('[data-session-route]')
            .getAttribute('data-session-route')
            .catch(() => null);
          const ok =
            text.includes(`${s.data.adapter} ${s.data.cliVersion}`) &&
            routeId === s.data.route.id &&
            (!s.data.modelAsked || text.includes(s.data.modelAsked));
          if (!ok) {
            sessionsOk = false;
            sessionDetail.push(`${s.data.sessionId}: «${text}» route=${routeId}`);
          }
        }
        check(
          `строка сессии: CLI с версией, модель, маршрут из session.started (${sessions.length}, ${sessions[0]?.data.adapter} ${sessions[0]?.data.cliVersion}, ${sessions[0]?.data.route.id})`,
          sessionsOk,
          sessionDetail.slice(0, 3).join('\n    '),
        );

        // Строка того же сообщения сессии заменяет прежнюю (нарастающий итог хода), как в свёртке ядра.
        const lastByMessage = new Map();
        for (const l of lines) {
          if (l.kind === 'turn.usage')
            lastByMessage.set(`${l.data.sessionId}/${l.data.messageId}`, l.data);
        }
        const usage = [...lastByMessage.values()].reduce(
          (sum, d) => sum + d.input + d.cacheRead + d.cacheWrite + d.output,
          0,
        );
        const spend = finalView.spend.tokens;
        const viewTotal = spend.input + spend.cacheRead + spend.cacheWrite + spend.output;
        const shownTotal = Number(
          await page.locator('[data-core-tokens]').getAttribute('data-core-tokens'),
        );
        check(
          `расход: экран = view.spend = сумма turn.usage (${shownTotal})`,
          usage > 0 && shownTotal === viewTotal && viewTotal === usage,
          `экран ${shownTotal}, вид ${viewTotal}, журнал ${usage}`,
        );

        const signalLines = lines.filter((l) => l.kind === 'signal').length;
        const signalsShown = await page.locator('[data-core-signal]').count();
        check(
          `сигналы: все строки signal журнала (${signalLines})`,
          signalLines > 0 && signalsShown === signalLines,
          `показано ${signalsShown}`,
        );
        // Каждый сигнал настоящего ядра — из каталога (шаблон, не «вне каталога»), и ни один не
        // показывает деталь сырым JSON: прежде строка `preflight` выводила массив дорог дампом.
        const signalCards = page.locator('[data-signal-id]');
        const cardCount = await signalCards.count();
        const unknownIds = await page
          .locator('[data-signal-known="false"]')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-signal-id')));
        const dumps = await signalCards.evaluateAll(
          (els) => els.filter((e) => /[[{]\s*"[\w-]+"\s*:/.test(e.textContent ?? '')).length,
        );
        const jsonFacts = await page.locator('[data-signal-detail="facts"]').count();
        check(
          `сигналы: заголовок каталога у каждого, сырого JSON нет (${cardCount} строк, фактами ${jsonFacts})`,
          cardCount >= signalLines * 2 && unknownIds.length === 0 && dumps === 0 && jsonFacts > 0,
          `вне каталога: ${unknownIds.join(', ') || 'нет'}; с JSON: ${dumps}`,
        );

        const report = await stand.api(`/core/tasks/${taskId}/report`);
        const reportCard = page.locator(`[data-core-report="${finalView.report.sha256}"]`);
        await reportCard.waitFor({ timeout: 20_000 });
        if (report.status === 200) {
          const outcome = await reportCard
            .locator('[data-report-outcome]')
            .getAttribute('data-report-outcome', { timeout: 20_000 });
          check(
            `отчёт: исход как у ядра (${outcome})`,
            outcome === report.body?.report?.outcome,
            report.text.slice(0, 300),
          );
        } else {
          const code = await reportCard
            .locator('[data-report-failure]')
            .getAttribute('data-report-failure', { timeout: 20_000 });
          check(
            `отчёт: ядро ответило ${report.status} — карточка с этим кодом и отпечатком`,
            Number(code) === report.status &&
              (await reportCard.innerText()).includes(finalView.report.sha256.slice(0, 12)),
            `код на экране ${code}`,
          );
        }

        const recordId = checks.find((c) => c.recordId)?.recordId;
        if (recordId) {
          const link = page.locator(`[data-record-link="${recordId}"]`).first();
          await link.click();
          const peek = page.locator(`[data-record-peek="${recordId}"]`).first();
          const rec = await stand.api(
            `/core/records/${encodeURIComponent(recordId)}?task=${taskId}`,
          );
          if (rec.status === 200) {
            const verdict = await peek
              .locator('[data-record-verdict]')
              .getAttribute('data-record-verdict', { timeout: 20_000 });
            const want = rec.body?.record?.verdict;
            const text = await peek.locator('[data-record-verdict]').innerText();
            check(
              `запись проверки: вердикт как у ядра (${verdict}), строкой, не объектом`,
              verdict === want?.kind &&
                text.includes(want?.kind) &&
                !text.includes('[object') &&
                text.includes(rec.body.record.argv.join(' ')),
              `экран «${text}», ядро ${JSON.stringify(want)}`,
            );
          } else {
            const code = await peek
              .locator('[data-record-failure]')
              .getAttribute('data-record-failure', { timeout: 20_000 });
            check(
              `запись проверки: ядро ответило ${rec.status} — карточка с этим кодом`,
              Number(code) === rec.status,
              `код ${code}`,
            );
          }
        } else check('запись проверки есть у проверок вида', false, JSON.stringify(checks));
        await shoot(page, 'core-timeline-task');

        await page.reload();
        await until(
          'лента после перезагрузки',
          async () =>
            Number(
              await page
                .locator('[data-core-timeline]')
                .getAttribute('data-last-seq')
                .catch(() => 0),
            ) >= last,
          30,
        );
        const reloaded = await checkRows('после перезагрузки');
        check(
          'перезагрузка: те же строки, что до неё',
          JSON.stringify(reloaded) === JSON.stringify(liveSeqs),
          `${reloaded.length} против ${liveSeqs.length}`,
        );

        const en = await stand.api('/settings', { method: 'PATCH', body: { language: 'en' } });
        check('язык интерфейса переключён на en', en.status === 200, en.text);
        await page.reload();
        await page.waitForFunction(() => document.documentElement.lang === 'en', null, {
          timeout: 20_000,
        });
        await until(
          'лента на en',
          async () =>
            Number(
              await page
                .locator('[data-core-timeline]')
                .getAttribute('data-last-seq')
                .catch(() => 0),
            ) >= last,
          30,
        );
        await checkHeadlines(decisionsEn, 'en');
        await shoot(page, 'core-timeline-task-en');
        await stand.api('/settings', { method: 'PATCH', body: { language: 'ru' } });

        process.kill(stand.corePid());
        await wait(1500);
        await page.reload();
        const absent = page.locator('[data-core-refusal="core-absent"]');
        await absent.waitFor({ timeout: 20_000 });
        check('ядро убито — карточка «Ядро задач не запущено» на странице задачи', true);
        await shoot(page, 'core-timeline-absent');
        check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
      } finally {
        await browser.close();
      }
    },
  );
}
