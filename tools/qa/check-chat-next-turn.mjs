/**
 * Граница хода в чате чужого CLI на ядре (этап 11, волна 3, правки F-01/F-02/F-07): слово «на
 * ходу» ядро доставляет новым ходом того же прогона (`nextTurn`). Настоящая дорога: одноразовая
 * панель, своё ядро, настоящий qwen из PATH человека за одноразовым контуром — подменена только
 * модель (общая заглушка `packages/stub-model`, кадры контура — её сценарий `contour`).
 *
 * Что видно:
 *   - пока идёт ход слова «на ходу», ответ прошлого хода остаётся в ленте (F-02);
 *   - F5 посреди этого хода: каждое слово и каждый ответ — ровно раз и по порядку, ответ живого
 *     хода не встаёт дважды — из истории и из пузыря (F-01);
 *   - субагент qwen виден в «Плане агента» — других деревьев у чужого CLI нет (F-07);
 *   - два сообщения модели одного хода (ответ после вызова субагента и после его уведомления) не
 *     склеиваются в «готовготов» — ни вживую, ни после перезагрузки;
 *   - вызов субагента исполнен с первого ответа: контур получил запрос хода-5 ровно раз (без
 *     повтора qwen после «malformed tool call»). С `--shim=off` вызов едет родным `tool_calls`
 *     через маскирование DLP — заголовок вызова (id, имя) обязан дойти до CLI.
 *
 * Окно «посреди хода» делает заглушка: ответ на слово «на ходу» и следующий за ним запрос qwen
 * отдаются медленно (задержка перед каждым кадром), так что ход открыт, когда ответ уже записан.
 *
 * Запуск: `node tools/qa/check-chat-next-turn.mjs [--cli=qwen] [--shim=off]`.
 * `SHOTS=<dir>` — кадры в обеих темах, `SHOT_TAG=BEFORE|AFTER` — суффикс кадра.
 * Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const arg = (name) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};
const CLI = arg('cli') ?? 'qwen';
/**
 * `--shim=off` — контур без прослойки: вызов субагента приходит родным полем `tool_calls`
 * (кадры диалекта openai-chat общей заглушки), шлюз отдаёт их CLI как есть. Ходы F-01/F-02 от
 * прослойки не зависят — в этом режиме идут только ход-1 и вызов субагента.
 */
const SHIM = arg('shim') !== 'off';
const SHOTS = process.env.SHOTS || '';
const SHOT_TAG = process.env.SHOT_TAG || 'AFTER';
const ANSWER = 'готов';
/** Пауза перед каждым кадром ответа хода «на ходу»: окно, где лента держит прошлый ответ. */
const SLOW_MS = 1_000;
/** Пауза перед каждым кадром служебного запроса после ответа: ход открыт ~20 с — для F5. */
const OPEN_MS = 4_000;
const SUB_DESCRIPTION = 'проверка субагента';
/** Задание субагента: строку «Плана агента» у чужого CLI подписывает оно (выдержка ядра). */
const SUB_BRIEF = 'под-задача: ответь одним словом';

const { chromium } = await import('playwright');
const { runOnStand, NotChecked, wait, freePort } = await import('./throwaway-stand.mjs');
const { openProjectChat, dismissAccess } = await import('./chat-walk.mjs');
const { startStubModel } = await import('../../packages/stub-model/src/index.mjs');
const { contourRoute, MODELS } =
  await import('../../packages/stub-model/src/scenarios/contour.mjs');

const cliAt = (name) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
};
const cliPath = cliAt(CLI);
const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

/** Сообщения запроса чата (OpenAI-форма): роль и текст. */
function messagesOf(body) {
  const list = Array.isArray(body?.messages) ? body.messages : [];
  return list.map((m) => ({
    role: m?.role,
    text:
      typeof m?.content === 'string'
        ? m.content
        : (Array.isArray(m?.content) ? m.content : [])
            .filter((b) => b?.type === 'text')
            .map((b) => b.text)
            .join('\n'),
  }));
}
/** Последняя реплика человека несёт слово, и после неё ещё нет ни ответа, ни результата вызова. */
function asksFresh(body, word) {
  const list = messagesOf(body);
  const at = list.findLastIndex((m) => m.role === 'user' && m.text.trim());
  return at >= 0 && list[at].text.includes(word) && at === list.length - 1;
}
/**
 * Служебный запрос qwen после ответа на слово (память, итог): последнее «ход-N» в переписке —
 * это слово, за ним уже ответ, а последняя реплика «человека» — не слово.
 */
function sideAfter(body, word) {
  const list = messagesOf(body);
  const at = list.findLastIndex((m) => m.role === 'user' && /ход-\d+/.test(m.text));
  const last = list.findLastIndex((m) => m.role === 'user' && m.text.trim());
  return (
    at >= 0 &&
    last > at &&
    list[at].text.includes(word) &&
    list.slice(at + 1, last).some((m) => m.role === 'assistant')
  );
}

// Контур: кадры и каталог — сценарий `contour` общей заглушки. Своё здесь только два решения:
// какой ответ замедлить и когда отдать вызов субагента (его кадры пишет диалект заглушки).
const completions = [];
let agentGiven = false;
let debugTools = false;
const contourBase = contourRoute({ calls: [] });
const contour = await startStubModel({
  port: 0,
  models: MODELS.map((model) => model.id),
  route: (request) => {
    const body = request.body ?? {};
    if (request.path.endsWith('/chat/completions')) {
      completions.push(body);
      // Журнал запросов к контуру — по нему разбирается провал: чей это ход и что модель видела.
      if (process.env.NT_DEBUG) {
        const list = messagesOf(body);
        const tools = (Array.isArray(body.tools) ? body.tools : []).map((t) => t?.function?.name);
        console.log(
          `    · ${new Date().toISOString().slice(11, 23)} контур: ${list
            .slice(-3)
            .map((m) => `${m.role}:${m.text.slice(-40).replace(/\s+/g, ' ')}`)
            .join(
              ' | ',
            )} · инструментов ${tools.length}${tools.includes('agent') ? ' (agent)' : ''} · роли ${(
            body.messages ?? []
          )
            .map((m) => m?.role?.[0] ?? '?')
            .join('')}`,
        );
        if (!debugTools) {
          debugTools = true;
          console.log(`    · прослойка: ${JSON.stringify(body).includes('<tool_call>')}`);
        }
      }
    }
    if (request.path.endsWith('/chat/completions') && !agentGiven && asksFresh(body, 'ход-5')) {
      agentGiven = true;
      return undefined;
    }
    const out = contourBase(request);
    // Ответ хода-2 медленный: слово «на ходу» уходит, пока он пишется, — переписку после этого
    // ответа никто не перечитывал (F-02). Ответ хода-3 медленный — окно, где лента обязана
    // держать прошлый ответ; служебный запрос qwen после него ещё медленнее — ответ уже в
    // истории, ход открыт: окно для F5 (F-01). Задержка — перед каждым кадром.
    const wait =
      !request.path.endsWith('/chat/completions') || !out?.sse
        ? 0
        : asksFresh(body, 'ход-2') || asksFresh(body, 'ход-3')
          ? SLOW_MS
          : sideAfter(body, 'ход-3')
            ? OPEN_MS
            : 0;
    return wait ? { ...out, sse: { ...out.sse, delayMs: wait } } : out;
  },
  // Вызов субагента — текстом протокола прослойки: контур компании инструменты полем не
  // принимает, вызов из текста собирает шлюз ядра (как у настоящей установки). Без прослойки —
  // родным `tool_calls` (кадры диалекта заглушки: id, имя, аргументы по тому же `index`).
  script: () => {
    const args = {
      description: SUB_DESCRIPTION,
      prompt: SUB_BRIEF,
      subagent_type: 'general-purpose',
    };
    return SHIM
      ? { text: `<tool_call>${JSON.stringify({ name: 'agent', arguments: args })}</tool_call>` }
      : { tool: { name: 'agent', args } };
  },
});
const contourCalls = () => completions.length;
const gatewayPort = await freePort();
let repo = '';

async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}_${SHOT_TAG}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.colorScheme = 'light';
  });
}

async function patchSettings(page, change) {
  for (let n = 1; ; n++) {
    await page.waitForLoadState('load');
    try {
      const status = await page.evaluate(async (body) => {
        const res = await fetch('/api/settings', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return res.status;
      }, change);
      if (status !== 200) throw new Error(`настройки ${JSON.stringify(change)}: ${status}`);
      return;
    } catch (error) {
      if (n >= 3 || !/Failed to fetch|Execution context was destroyed/.test(String(error)))
        throw error;
      await wait(2000);
    }
  }
}

/**
 * Лента в порядке документа: слова человека («ход-N» в `[data-feed-message]`) и КАЖДЫЙ ответ
 * отдельно — подряд идущие ответы не склеиваются: двойной ответ и есть то, что ищем (F-01).
 */
function feedOrder(page) {
  return page.evaluate((answer) => {
    const word = /ход-\d+/;
    const bubbles = new Set(
      [...document.querySelectorAll('[data-feed-message]')].filter(
        (el) => word.test(el.textContent ?? '') && !(el.textContent ?? '').includes(answer),
      ),
    );
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 1 && bubbles.has(node)) out.push(`U:${word.exec(node.textContent)[0]}`);
      else if (node.nodeType === 3 && node.textContent?.trim() === answer) out.push('A');
    }
    return out;
  }, ANSWER);
}

/** Ровно эти слова по порядку, и за каждым — ровно один ответ. */
function eachOnce(order, words) {
  const expected = words.flatMap((w) => [`U:${w}`, 'A']);
  return order.join(' ') === expected.join(' ');
}

async function activateContour(stand, check) {
  const ID = 'next-turn';
  const saved = await stand.api(`/platforms/${ID}`, {
    method: 'PUT',
    body: {
      settings: {
        id: ID,
        title: 'Контур чата',
        driver: 'enterprise-platform',
        baseUrl: contour.baseUrl,
        enabled: true,
        mode: 'best-effort',
        budgetUsd: 0,
        budgetSince: '',
        capabilities: [],
        // Чужой CLI идёт через контур по своей галочке (`chatConsumerOf`), «Чат» — только Claude.
        consumers: ['chat', `foreign:${CLI}`],
        targets: [],
        projectPaths: [],
        agents: [],
        caCertPath: '',
        toolShim: SHIM,
        defaultModel: 'stub-chat',
        modelMap: {},
      },
      token: ['chat', 'stub', 'key'].join('-'),
    },
  });
  const activated = await stand.api(`/platforms/${ID}/activate?probe=skip`, {
    method: 'POST',
    body: {},
  });
  const restarted = await stand.api('/platforms/gateway/restart', { method: 'POST', body: {} });
  check(
    'контур стенда сохранён, активен, шлюз на своём порту',
    saved.status === 200 &&
      activated.body?.activePlatformId === ID &&
      restarted.body?.status?.running === true,
    JSON.stringify([saved.body, activated.body, restarted.body?.status]).slice(0, 500),
  );
}

async function scenario(stand, check, browser) {
  const page = await openProjectChat(stand, browser, repo, 'repo');
  const input = page.locator('textarea[data-chat-input]');
  const stop = page.getByRole('button', { name: 'Остановить' });
  const idle = async (seconds) => {
    for (let i = 0; i < seconds * 4; i++) {
      if ((await stop.count()) === 0) return true;
      await wait(250);
    }
    return false;
  };
  const send = async (text) => {
    await input.waitFor({ timeout: 60_000 });
    await input.fill(text);
    await input.press('Enter');
  };
  // Разрешение на вызов (субагент, чтение) — дать, если ядро спросило.
  const allowAsked = async () => {
    const allow = page.getByRole('button', { name: /^Разрешить/ });
    if ((await allow.count()) > 0)
      await allow
        .first()
        .click()
        .catch(() => undefined);
  };
  try {
    await patchSettings(page, { provider: CLI });
    await page.reload();
    await dismissAccess(page);
    await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
    await wait(1000);

    // Ход-1 — обычный, до конца.
    await send('ход-1: начни');
    for (let i = 0; i < 180; i++) {
      const order = await feedOrder(page);
      if (order.join(' ') === 'U:ход-1 A' && (await idle(1))) break;
      await wait(1000);
    }
    await idle(60);
    await wait(2000);

    // Без прослойки граница хода не проверяется: она от прослойки не зависит (см. `--shim`).
    if (SHIM) {
      // Ход-2, и пока его запрос у контура — ход-3 «на ходу»: ядро доставит его новым ходом.
      const sends = [];
      const onSend = (req) => {
        if (req.method() !== 'POST' || !req.url().includes('/api/chat/send')) return;
        const body = req.postDataJSON?.() ?? {};
        sends.push({ steer: body.steer === true, prompt: String(body.prompt ?? '') });
      };
      page.on('request', onSend);
      // Кто и когда перечитал переписку — по журналу видно, чем закрыт прошлый ответ (F-02).
      if (process.env.NT_DEBUG)
        page.on('request', (req) => {
          if (/\/api\/chats\/[^/]+\/messages/.test(req.url()))
            console.log(`    · ${new Date().toISOString().slice(11, 23)} ← переписка перечитана`);
        });
      const calls2 = contourCalls();
      await send('ход-2: ещё');
      for (let i = 0; i < 1200 && contourCalls() === calls2; i++) await wait(50);
      await send('ход-3: на ходу');
      // Ход-3 начался (его медленный запрос у контура) — ответ хода-2 на экране (F-02).
      const calls3 = () => completions.filter((b) => asksFresh(b, 'ход-3')).length;
      for (let i = 0; i < 1200 && calls3() === 0; i++) await wait(50);
      for (let i = 0; i < 5; i++) {
        if (process.env.NT_DEBUG)
          console.log(
            `    · ${new Date().toISOString().slice(11, 23)} лента: ${(await feedOrder(page)).join(' ')} · идёт: ${(await stop.count()) > 0}`,
          );
        await wait(500);
      }
      const during = await feedOrder(page);
      const running3 = (await stop.count()) > 0;
      // Снимок — в ту же минуту, что и вывод: через несколько секунд ленту перечитает потеря связи.
      await shoot(page, `next-turn-${CLI}-during`);
      page.off('request', onSend);
      const steered = sends.find((s) => s.prompt.includes('ход-3'))?.steer === true;
      check(
        `${CLI} (F-02): пока идёт ход слова «на ходу», ответ прошлого хода в ленте (ушло на ходу: ${steered}, ход идёт: ${running3}, лента: ${during.join(' ')})`,
        steered && running3 && eachOnce(during.slice(0, 4), ['ход-1', 'ход-2']),
        `отправки: ${JSON.stringify(sends)}`,
      );

      // Ответ хода-3 уже записан, ход ещё открыт (следующий запрос qwen медленный) — F5.
      for (let i = 0; i < 400 && !completions.some((b) => sideAfter(b, 'ход-3')); i++)
        await wait(50);
      // Ответ хода в истории ядра оседает не сразу — дать ему записаться.
      await wait(1500);
      const openBeforeReload = (await stop.count()) > 0;
      await page.reload();
      await dismissAccess(page);
      let reloaded = [];
      const words = ['ход-1', 'ход-2', 'ход-3'];
      // Ход открыт ещё ~15 с: лента читается, пока он идёт, — иначе это проверка конца прогона.
      for (let i = 0; i < 8 && !eachOnce(reloaded, words); i++) {
        await wait(500);
        reloaded = await feedOrder(page);
      }
      const stillRunning = (await stop.count()) > 0;
      await shoot(page, `next-turn-${CLI}-reload`);
      check(
        `${CLI} (F-01): F5 посреди хода — каждое слово и ответ ровно раз, по порядку (ход открыт до F5: ${openBeforeReload}, после: ${stillRunning}; лента: ${reloaded.join(' ')})`,
        openBeforeReload && eachOnce(reloaded, words),
      );
      await idle(90);
      await wait(3000);
      const after = await feedOrder(page);
      check(
        `${CLI}: после конца прогона — те же три хода, каждый ответ раз (${after.join(' ')})`,
        eachOnce(after, words),
      );
    }

    // Субагент qwen — в «Плане агента» (F-07).
    await send('ход-5: позови агента');
    const conv = new URL(page.url()).searchParams.get('id') ?? '';
    // Склейка: два ответа модели одного хода (после результата вызова и после уведомления
    // qwen о конце фонового субагента) встали одним словом «готовготов» — и в пузыре идущего
    // хода, и в истории после него.
    const mainText = () =>
      page
        .locator('main')
        .innerText()
        .catch(() => '');
    let gluedLive = false;
    let subagent = false;
    for (let i = 0; i < 120 && !subagent; i++) {
      await allowAsked();
      const nodes = await page.evaluate(async (id) => {
        const res = await fetch(`/api/core/agents?conversationId=${encodeURIComponent(id)}`);
        return res.ok ? (await res.json()).nodes : [];
      }, conv);
      subagent = nodes.some((n) => n.kind === 'subagent');
      if ((await mainText()).includes(ANSWER.repeat(2))) gluedLive = true;
      if (!subagent) await wait(1000);
    }
    for (let i = 0; i < 480 && (await stop.count()) > 0; i++) {
      if ((await mainText()).includes(ANSWER.repeat(2))) gluedLive = true;
      await wait(250);
    }
    await idle(120);
    await wait(2000);
    const settled = await mainText();
    const agentTurn = (await feedOrder(page)).slice(
      (await feedOrder(page)).lastIndexOf('U:ход-5') + 1,
    );
    const broken = /malformed tool call|Агент остановился с ошибкой/.test(settled);
    // Вызов исполнен с первого ответа: отвергнутый ответ Qwen Code молча запрашивает заново
    // («Retrying provider attempt» в stderr), и второй запрос хода-5 — единственный след этого.
    const asks5 = completions.filter((b) => asksFresh(b, 'ход-5')).length;
    check(
      `${CLI}: вызов субагента ${SHIM ? 'текстом прослойки' : 'родным tool_calls'} исполнен с первого ответа (запросов хода-5 у контура: ${asks5}, узел субагента: ${subagent})`,
      asks5 === 1 && subagent,
    );
    check(
      `${CLI} (склейка): ответы хода с субагентом стоят раздельно — в идущем ходе и в истории (склейка в ходе: ${gluedLive}, после: ${settled.includes(ANSWER.repeat(2))}; ответов после ход-5: ${agentTurn.filter((x) => x === 'A').length}; ошибка хода: ${broken})`,
      !gluedLive &&
        !settled.includes(ANSWER.repeat(2)) &&
        agentTurn.filter((x) => x === 'A').length >= 1 &&
        !broken,
      `экран: ${settled.slice(-600)}`,
    );
    const head = page.locator('[data-chat-progress] > button').first();
    const sheet = (await head.count()) > 0;
    if (sheet && (await head.getAttribute('aria-expanded')) !== 'true') await head.click();
    const item = page.getByRole('treeitem').filter({ hasText: SUB_BRIEF });
    const listed = await item
      .first()
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    check(
      `${CLI} (F-07): субагент в «Плане агента» (узел ядра: ${subagent}, полоса: ${sheet}, строка «${SUB_BRIEF}»: ${listed})`,
      subagent && sheet && listed,
      `экран: ${(await page.locator('main').innerText()).slice(-600)}`,
    );
    await shoot(page, `next-turn-${CLI}-plan`);
  } finally {
    await patchSettings(page, { provider: 'claude' }).catch(() => undefined);
    await page.close();
  }
}

try {
  await runOnStand(
    {
      label: 'chat-next-turn',
      extraPath: cliPath ? [dirname(cliPath)] : [],
      core: true,
      // Наблюдение за файлами выключено: лента живёт опросом отпечатка и границей хода — тем
      // путём, который при выключенном тумблере у человека единственный (F-02).
      settings: {
        watchFiles: false,
        platformGateway: { enabled: true, port: gatewayPort, forceStream: true },
      },
      seed: ({ root }) => {
        repo = join(root, 'repo');
        mkdirSync(repo, { recursive: true });
        git(repo, ['init', '-q', '-b', 'main']);
        git(repo, ['config', 'user.name', 'stand']);
        git(repo, ['config', 'user.email', 'stand@example.invalid']);
        writeFileSync(join(repo, 'notes.txt'), 'заметки\n');
        git(repo, ['add', '.']);
        git(repo, ['commit', '-qm', 'init']);
      },
    },
    async (stand, check) => {
      if (!cliPath) throw new NotChecked(`${CLI} нет в PATH — граница хода не проверена`);
      const browser = await chromium.launch();
      try {
        await activateContour(stand, check);
        await scenario(stand, check, browser);
      } finally {
        await browser.close();
      }
    },
  );
} finally {
  await contour.close();
}
