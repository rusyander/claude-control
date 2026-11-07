/**
 * Единый чат `/chat` на ядре (этап 11, W3-17a; прежде этап 10, F2) — настоящая дорога: одноразовая
 * панель, своё ядро, настоящие CLI из PATH человека против `packages/stub-model` (модель —
 * единственное, что подменено): claude — сценарий `chatScript` по адресу модели из окружения
 * стенда, чужой CLI (`--foreign=`, по умолчанию qwen) — через одноразовый контур (стаб-контур
 * `stub-platform.mjs` за шлюзом ядра стенда), ключа вендора нет нигде. Браузер ходит через
 * прокладку панели; ответы ядра не перехватываются.
 *
 * Что видно:
 *   - прежний разговор claude в `/chat` продолжается задачей ядра на месте (`panelChat`: ходы,
 *     «на ходу», «Остановить», ход после остановки, правка вне проекта, основы чата);
 *   - «Новый чат» остаётся в `/chat` (не `/core/chat`), выбора CLI и «Продолжить через ядро» нет;
 *     ход нового чата при активном Claude — сеанс claude, ответ на экране;
 *   - активный провайдер — чужой CLI: новый чат в `/chat` отвечает через него (сеанс этого CLI в
 *     журнале ядра, запрос дошёл до контура, модель claude его не видела);
 *   - активный снова Claude: тот же чат продолжается своим CLI, а не Claude;
 *   - чужой CLI через контур, в настройках модель Claude из каталога контура: запертая шапка, `set-model`
 *     и запрос в контур несут её перевод картой контура, а не модель контура по умолчанию;
 *   - CLI без хука ядра (`--refused=`, по умолчанию aider,continue), контура нет: строка отказа ядра
 *     с кодом `no_core_hook` в ленте (суд совместимости `set-cli` раньше набора), композера нет,
 *     прежний исполнитель не позван, процесса CLI под панелью нет;
 *   - старый адрес `/core/chat?project=X&cli=…` приводит в `/chat?project=X` (CLI снят, вкладка
 *     проекта открыта), `/core/chat?id=<задача>` — в разговор этой задачи.
 *
 * Запуск: `node tools/qa/check-core-chat.mjs [--foreign=qwen] [--refused=aider,continue]
 * [--panel-chat=0]` (стенд свой, `pnpm dev` не нужен; CLI, которого нет в PATH, — его часть «не
 * проверено»). `SHOTS=<dir>` — кадры в обеих темах.
 * Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CIM_UTF8, parseCimJson } from '../../apps/server/src/lib/cim-json.ts';
import { basicsReply, basicsSteps, modelReached, pickModel } from './core-chat-basics-steps.mjs';

// ── Сценарий модели: этот же файл ядро грузит как модуль заглушки ─────────────────────────────

export const FILE_MARK = 'метка-файла-7731';

/** Текст содержимого сообщения любой формы (строка, блоки, результат инструмента). */
function flat(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b === 'string' ? b : (b?.text ?? flat(b?.content))))
    .filter(Boolean)
    .join('\n');
}

/**
 * Результат инструмента в сообщении: openai-chat — роль `tool`; anthropic — блоки `tool_result`;
 * openai-responses (Codex) — элементы `function_call_output` / `custom_tool_call_output`.
 */
function toolResultOf(m) {
  if (m?.role === 'tool') return flat(m.content);
  if (m?.type === 'function_call_output' || m?.type === 'custom_tool_call_output') {
    return typeof m.output === 'string' ? m.output : flat(m.output?.content ?? m.output);
  }
  if (m?.role !== 'user' || !Array.isArray(m.content)) return '';
  return flat(m.content.filter((b) => b?.type === 'tool_result'));
}

/** Сообщения запроса в любом диалекте: `messages` (anthropic, openai-chat) или `input` (responses). */
function messagesOf(body) {
  if (Array.isArray(body?.messages)) return body.messages;
  return Array.isArray(body?.input) ? body.input : [];
}

/**
 * Вызов чтения файла тем инструментом, что предложил CLI. Имя поля пути — из схемы: у Qwen оно
 * менялось между версиями (`absolute_path` → `file_path`), угаданное имя дало бы отказ инструмента.
 * У Codex чтения нет — команда оболочки (`shell_command` строкой, `shell` массивом, `exec_command`).
 */
function readCall(tools, file) {
  const reader = tools.find(
    (t) => t.name === 'Read' || t.name === 'read_file' || t.name === 'read',
  );
  const propsOf = (t) => Object.keys(t?.schema?.properties ?? {});
  if (reader) {
    const props = propsOf(reader);
    const key =
      ['file_path', 'absolute_path', 'filePath', 'path'].find((k) => props.includes(k)) ??
      'file_path';
    return { name: reader.name, args: { [key]: file } };
  }
  const win = process.platform === 'win32';
  // `type "<путь>"` понимают обе оболочки Windows: у Codex это PowerShell (`type` — его псевдоним
  // Get-Content), у Goose — cmd, где Get-Content нет и чтение кончалось кодом 1.
  const line = win ? `type "${file}"` : `cat '${file}'`;
  const shell = tools.find((t) => ['shell_command', 'exec_command', 'shell'].includes(t.name));
  if (!shell) return null;
  const props = propsOf(shell);
  if (props.includes('cmd')) return { name: shell.name, args: { cmd: line } };
  const asArray = shell.schema?.properties?.command?.type === 'array';
  const command = asArray
    ? win
      ? ['powershell.exe', '-NoProfile', '-Command', line]
      : ['cat', file]
    : line;
  return { name: shell.name, args: { command } };
}

/** Текст человека в сообщении без результатов инструментов. */
function wordsOf(m) {
  if (m?.role !== 'user') return '';
  return Array.isArray(m.content)
    ? flat(m.content.filter((b) => b?.type !== 'tool_result'))
    : flat(m.content);
}

/**
 * Чат-заглушка, одинаковая для диалектов Claude (anthropic-messages) и Qwen (openai-chat). Ход —
 * последнее сообщение человека с «ход-N» (CLI добавляют свои сообщения после него — напоминания,
 * контекст хуков, поэтому не «последнее сообщение»): после него уже есть результат инструмента →
 * ответ с его текстом; «покажи файл» → вызов чтения файла тем инструментом, что предложил CLI;
 * иначе «ответ на ход-N». Без хода (служебные запросы CLI) — короткий текст.
 */
export function chatScript({ file }) {
  return (ctx) => {
    const messages = messagesOf(ctx.request.body);
    let at = -1;
    messages.forEach((m, i) => {
      if (/ход-\d+/.test(wordsOf(m))) at = i;
    });
    const toolResult = messages
      .slice(at + 1)
      .map(toolResultOf)
      .filter(Boolean)
      .at(-1);
    const said = at >= 0 ? wordsOf(messages[at]) : '';
    // Основы чата `/chat` (два шага, вложения, переполненный контекст) — свои ответы.
    const basics =
      at >= 0
        ? basicsReply({
            said,
            after: messages.slice(at + 1),
            tools: ctx.info.tools,
            file,
            readCall,
          })
        : undefined;
    if (basics) return basics;
    if (at >= 0 && toolResult) return { text: `файл прочитан: ${toolResult.slice(0, 200)}` };
    // «долгий» — ответ придержан: ход, который человек останавливает посреди генерации.
    if (/долгий/.test(said)) return { text: 'ответ на долгий ход', holdMs: 120_000 };
    // «медленный» — ответ через 8 с: ход занят, человек успевает написать «на ходу».
    if (/медленный/.test(said)) {
      return { text: `ответ на ход-${/ход-(\d+)/.exec(said)?.[1]}`, holdMs: 8_000 };
    }
    // «запиши вне» — правка вне корня проекта: вне гранта чата ядро отказывает само (outside-copy).
    const writer = ctx.info.tools.find((t) => t.name === 'Write');
    if (/запиши вне/.test(said) && writer) {
      return {
        tool: {
          name: 'Write',
          args: {
            file_path: join(dirname(dirname(file)), 'outside.txt'),
            content: 'вне проекта\n',
          },
        },
      };
    }
    if (/покажи файл/.test(said)) {
      const call = readCall(ctx.info.tools, file);
      if (!call) return { text: `нет инструмента чтения: ${ctx.info.tools.map((t) => t.name)}` };
      return { tool: call };
    }
    const turn = /ход-(\d+)/.exec(said)?.[1];
    return { text: turn ? `ответ на ход-${turn}` : 'stub side reply' };
  };
}

// ── Проверка ──────────────────────────────────────────────────────────────────────────────────

const SELF = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase();
if (isMain) await main();

/** Таблица процессов — только чтение: номер → родитель, команда. */
function processTable() {
  const table = new Map();
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        CIM_UTF8 +
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    // Тот же разбор, что у сервера: вывод PowerShell кодовой страницей консоли превращал «•» в
    // чужой командной строке в сырой BEL, и JSON.parse ронял всю таблицу — прогон падал.
    for (const row of parseCimJson(out)) {
      table.set(row.ProcessId, { parent: row.ParentProcessId, command: row.CommandLine ?? '' });
    }
    return table;
  }
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) table.set(Number(m[1]), { parent: Number(m[2]), command: m[3] });
  }
  return table;
}

/** Цепочка предков процесса (сам, родитель, …) — до корня или петли. */
function ancestry(pid, table) {
  const chain = [];
  for (let at = pid; at && table.has(at) && !chain.includes(at); at = table.get(at).parent) {
    chain.push(at);
  }
  return chain;
}

async function main() {
  const { chromium } = await import('playwright');
  const { runOnStand, NotChecked, wait, freePort } = await import('./throwaway-stand.mjs');
  const { startStubPlatform } = await import('./stub-platform.mjs');
  const { openProjectChat, dismissAccess } = await import('./chat-walk.mjs');

  const SHOTS = process.env.SHOTS || '';
  const cliAt = (name) => {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
      encoding: 'utf8',
    });
    return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
  };
  const list = (v, dflt) =>
    (v ?? dflt)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  // Аргументы `--foreign=<cli> --refused=<…> --panel-chat=0` сильнее окружения: кейс блока «Тесты»
  // связывается с файлом и своими аргументами (`automation.testName`), а не с окружением.
  const arg = (name) => {
    const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? undefined : hit.slice(name.length + 3);
  };
  const FOREIGN = (arg('foreign') ?? process.env.FOREIGN ?? 'qwen').trim();
  // Выбор модели через контур (M-F1): имя Claude из каталога контура и его перевод картой контура.
  const CONTOUR_PICK = 'claude-sonnet-5-5';
  // Цель перевода — модель каталога контура: иную ядро отказывает судом совместимости (model_absent).
  const CONTOUR_PICKED = 'stub-reasoning';
  const PANEL_CHAT = (arg('panel-chat') ?? process.env.PANEL_CHAT) !== '0';
  const REFUSED = list(arg('refused') ?? process.env.REFUSED, 'aider,continue');
  const IMAGE = { continue: 'cn' };
  const found = Object.fromEntries(
    // Каталог claude — в PATH стенда всегда (сам claude заслоняет заглушка стенда): чат `/chat`
    // идёт через него, а предпроверка оценки ядра ищет CLI разрешённых маршрутов задачи.
    [...new Set([FOREIGN, ...REFUSED, 'claude'].filter(Boolean))].map((cli) => [
      cli,
      cliAt(IMAGE[cli] ?? cli),
    ]),
  );
  const extraPath = [
    ...new Set(
      Object.values(found)
        .filter(Boolean)
        .map((p) => dirname(p)),
    ),
  ];
  const git = (cwd, args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  let repo = '';
  let file = '';

  async function shoot(page, name) {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
        document.documentElement.style.colorScheme = t;
      }, theme);
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(SHOTS, `${name}-${theme}_AFTER.png`) });
    }
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
      document.documentElement.style.colorScheme = 'light';
    });
  }

  // Модель claude — заглушка по адресу из личного settings.json стенда (`seedClaudeEnv`): маршрут
  // задачи без контура — вход CLI, т.е. claude с этим адресом и ключом. Путь файла заглушка узнаёт
  // после засева стенда (`panelFile`).
  const { startStubModel } = await import('../../packages/stub-model/src/index.mjs');
  let panelFile = 'notes.txt';
  const panelTrace = [];
  // Тела запросов к модели чата `/chat` целиком: что дошло до модели (модель, усилие, байты
  // вложений, вызовы чтения) — свидетельство основ чата (`core-chat-basics-steps.mjs`).
  const panelBodies = [];
  const panelStub = await startStubModel({
    script: (ctx) => {
      const words = messagesOf(ctx.request.body).map(wordsOf).filter(Boolean);
      panelTrace.push(words.at(-1) ?? '');
      panelBodies.push({
        said: words.filter((w) => /ход-\d+/.test(w)).at(-1) ?? '',
        body: ctx.request.body,
      });
      return chatScript({ file: panelFile })(ctx);
    },
  });
  const stubEnv = { ANTHROPIC_BASE_URL: panelStub.baseUrl, ANTHROPIC_API_KEY: 'stand-stub-key' };
  // Контур чужого CLI: стаб-контур (`stub-platform.mjs`, сценарий `contour` общей заглушки) за
  // шлюзом ядра стенда на своём порту. Ключ — заглушка, собранная из кусков.
  const contour = await startStubPlatform({ port: 0 });
  const gatewayPort = await freePort();

  await runOnStand(
    {
      label: 'core-chat',
      extraPath,
      env: stubEnv,
      core: true,
      settings: { platformGateway: { enabled: true, port: gatewayPort, forceStream: true } },
      seed: ({ root }) => {
        repo = join(root, 'repo');
        file = join(repo, 'notes.txt');
        mkdirSync(repo, { recursive: true });
        git(repo, ['init', '-q', '-b', 'main']);
        git(repo, ['config', 'user.name', 'stand']);
        git(repo, ['config', 'user.email', 'stand@example.invalid']);
        writeFileSync(file, `${FILE_MARK}\n`);
        panelFile = file;
        git(repo, ['add', '.']);
        git(repo, ['commit', '-qm', 'init']);
      },
    },
    async (stand, check) => {
      const browser = await chromium.launch();
      try {
        if (!found.claude)
          throw new NotChecked('claude нет в PATH — чат /chat через ядро не проверен');
        seedClaudeEnv(stand);
        // Прежний разговор `/chat`: продолжение задачей ядра (этап 10, F2, проход 3).
        if (PANEL_CHAT) await panelChat(stand, check, browser);
        // Провал одной части не снимает строки остальных: каждая — свой вердикт.
        const part = (name, run) =>
          run().catch((error) =>
            check(`${name}: сценарий дошёл до конца`, false, error?.stack ?? String(error)),
          );
        const claudeChat = await part('новый чат claude', () =>
          newClaudeChat(stand, check, browser),
        );
        // CLI без хука ядра — БЕЗ контура (W3-17a): набор задачи тогда только маршруты входа CLI, и
        // `set-cli` судит переходник судом совместимости раньше набора — отказ по имени
        // (`no_core_hook`), а не «вне набора». Отказ не зависит от бинаря: ядро отказывает раньше
        // процесса.
        for (const cli of REFUSED)
          await part(`${cli}: отказ`, () => refusedChat(stand, check, browser, cli));
        // Контур «Чат» — маршрут чужого CLI без входа доводит до его сеанса контур.
        if (found[FOREIGN]) await part('контур «Чат»', () => activateContour(stand, check));
        if (found[FOREIGN]) await part(FOREIGN, () => foreignChat(stand, check, browser));
        if (found[FOREIGN])
          await part(`${FOREIGN}: выбор через контур`, () => contourPick(stand, check, browser));
        else console.log(`  ~ ${FOREIGN} не найден в PATH — чат чужого CLI не проверен`);
        await part('старый адрес /core/chat', () => oldAddress(stand, check, browser, claudeChat));
      } finally {
        await browser.close();
        await panelStub.close();
        await contour.close();
      }
    },
  );

  /**
   * Вход claude стенда — адрес и ключ в `env` личного settings.json, как у человека со своим
   * адресом модели: пин задачи ядра несёт только дом и CLAUDE_CONFIG_DIR, окружение стенда
   * (`stubEnv`) до CLI ядра не доходит, а личный слой ядро передаёт как есть.
   */
  function seedClaudeEnv(stand) {
    const settingsPath = join(stand.cfg, 'settings.json');
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ ...settings, env: { ...settings.env, ...stubEnv } }, null, 2)}\n`,
    );
  }

  /** Задачи ядра стенда — каталоги дома ядра. */
  function coreTasks(stand) {
    try {
      return readdirSync(join(stand.coreHome, 'tasks'));
    } catch {
      return [];
    }
  }

  /** Журнал задачи ядра строками. */
  function coreJournal(stand, taskId) {
    const dir = join(stand.coreHome, 'tasks', taskId);
    const name = readdirSync(dir).find((f) => f.endsWith('.jsonl'));
    return readFileSync(join(dir, name), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  /** Новые задачи ядра после `before` — ждёт до 90 с. */
  async function newTasks(stand, before) {
    for (let i = 0; i < 90; i++) {
      const fresh = coreTasks(stand).filter((t) => !before.includes(t));
      if (fresh.length > 0) return fresh;
      await wait(1000);
    }
    return [];
  }

  /**
   * Сеансы задачи по журналу ядра: CLI и каталог. Здесь и ниже — объявления функциями, не `const`:
   * сценарий стенда выше зовёт их до этих строк (иначе TDZ).
   */
  function sessionsOf(stand, taskId) {
    return coreJournal(stand, taskId)
      .filter((l) => l.kind === 'session.started')
      .map((l) => l.data ?? {});
  }

  /** Значения правок модели задачи (`override.set` поля `model`, их пишет `set-model`). */
  function modelOverrides(stand, taskId) {
    return coreJournal(stand, taskId)
      .filter((l) => l.kind === 'override.set' && l.data?.field === 'model')
      .map((l) => String(l.data?.value ?? ''));
  }

  /** Имя модели Claude — алиас выбора или `claude-*` (то же правило, что `core-run/model-fit.ts`). */
  function isClaudeModel(value) {
    const bare = String(value).trim();
    return /^(fable|opus|sonnet|haiku)(\[[^\]]*\])?$/i.test(bare) || /^claude-/i.test(bare);
  }

  /** Пункты выбора модели в шапке чата: значение и подпись. */
  async function modelOptions(page) {
    const select = page.locator('select[aria-label="Модель"]').first();
    await select.waitFor({ timeout: 30_000 }).catch(() => undefined);
    return select
      .locator('option')
      .evaluateAll((options) => options.map((o) => ({ value: o.value, label: o.textContent })))
      .catch(() => []);
  }

  /** Активный CLI раздела чата — настройка человека: правится из браузера, как переключателем. */
  function setProvider(page, provider) {
    return patchSettings(page, { provider });
  }

  /** Настройки панели — из браузера, как их правит человек. */
  async function patchSettings(page, change) {
    const patch = () =>
      page.evaluate(async (body) => {
        const res = await fetch('/api/settings', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return res.status;
      }, change);
    // Холодный Vite на первом заходе перезагружает страницу после оптимизации зависимостей —
    // fetch посреди перезагрузки обрывается «Failed to fetch». Повтор после загрузки, не больше трёх.
    const attempt = async (n) => {
      await page.waitForLoadState('load');
      try {
        return await patch();
      } catch (error) {
        if (n >= 3 || !/Failed to fetch|Execution context was destroyed/.test(String(error)))
          throw error;
        await wait(2000);
        return attempt(n + 1);
      }
    };
    const status = await attempt(1);
    if (status !== 200) throw new Error(`настройки ${JSON.stringify(change)}: ${status}`);
  }

  /** «Новый чат» боковой панели `/chat`. */
  async function clickNewChat(page) {
    await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
    await wait(1000);
  }

  /** Текст на экране в пределах срока. */
  function shownOn(page, text, seconds = 180) {
    return page
      .getByText(text)
      .first()
      .waitFor({ timeout: seconds * 1000 })
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Прежний чат `/chat` на ядре (этап 10, F2, проход 3). Старый разговор — транскрипт, который
   * настоящий claude записал сам (`claude -p --session-id`, как писал прежний исполнитель панели).
   * Что видно:
   *   - ход из `/chat` в этом разговоре = задача ядра на месте; CLI — потомок хоста сеанса ядра;
   *   - тот же файл транскрипта получает новый ход (разговор продолжен, а не начат заново);
   *   - второй ход — тем же шагом (`message-to-step`), новой задачи нет;
   *   - «Остановить» снимает задачу ядра (`task` кончилась отменой), CLI сеанса не жив;
   *   - ход после остановки — новая задача с продолжением того же транскрипта;
   *   - правка вне корня проекта — карточка права в `/chat`, «Разрешить» доходит до ядра ответом.
   */
  async function panelChat(stand, check, browser) {
    const { randomUUID } = await import('node:crypto');
    const tasks = () => coreTasks(stand);
    const journalOf = (taskId) => coreJournal(stand, taskId);
    const conv = randomUUID();
    const transcript = () => {
      const projects = join(stand.cfg, 'projects');
      for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
        const path = join(projects, dir, `${conv}.jsonl`);
        if (existsSync(path)) return readFileSync(path, 'utf8');
      }
      return '';
    };
    // Старый разговор: настоящий claude, окружение стенда, модель — заглушка.
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !/^(AGENTDECK|CLAUDE_CODE)/i.test(k)),
      ),
      HOME: stand.home,
      USERPROFILE: stand.home,
      CLAUDE_CONFIG_DIR: stand.cfg,
      ...stubEnv,
    };
    // Не `spawnSync`: заглушка модели живёт в этом же процессе, и замёрзший цикл событий
    // не ответил бы CLI, пока его не убьёт срок.
    const seeded = await new Promise((done) => {
      const child = spawn(
        'claude',
        ['-p', '"ход-4: старый разговор"', '--session-id', conv, '--output-format', 'json'],
        { cwd: repo, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => child.kill(), 180_000);
      child.on('close', (status) => {
        clearTimeout(timer);
        done({ status, stdout, stderr });
      });
    });
    const oldTurn = transcript();
    check(
      `/chat: старый разговор ${conv} записан самим claude (транскрипт ${oldTurn.length} байт)`,
      oldTurn.includes('ответ на ход-4'),
      `${seeded.status} ${seeded.stderr?.slice(0, 400)} ${seeded.stdout?.slice(0, 400)}`,
    );
    if (!oldTurn) return;

    const page = await openProjectChat(stand, browser, repo, 'repo');
    await page.goto(`${stand.webUrl}/chat?id=${conv}`);
    const input = page.locator('textarea[data-chat-input]');
    await input.waitFor({ timeout: 90_000 });
    const shown = (text, seconds = 180) => shownOn(page, text, seconds);
    check(
      '/chat: старый разговор открыт, прежний ответ на экране',
      await shown('ответ на ход-4', 60),
    );
    const say = async (text) => {
      await input.fill(text);
      await input.press('Enter');
    };
    const newTask = (before) => newTasks(stand, before);

    // Ход 5: задача ядра с продолжением разговора.
    const before5 = tasks();
    await say('ход-5: продолжаем через ядро');
    const fresh5 = await newTask(before5);
    check(`/chat: ход стал задачей ядра (${fresh5.join(',') || 'нет'})`, fresh5.length === 1);
    const answered5 = await shown('ответ на ход-5');
    // Почему нет ответа: хвост журнала задачи и последние слова, дошедшие до модели.
    const why = (id) =>
      `журнал: ${journalOf(id)
        .slice(-12)
        .map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 160)}`)
        .join('\n      ')}\n    модель: ${panelTrace
        .slice(-4)
        .map((t) => t.slice(-120).replace(/\s+/g, ' '))
        .join(' | ')}`;
    check(
      '/chat: ответ модели на ход через ядро на экране',
      answered5,
      fresh5[0] ? why(fresh5[0]) : '',
    );
    // `DUMP=<каталог>` — разбор провала: дом ядра и транскрипты стенда уезжают туда до уборки.
    if (!answered5 && process.env.DUMP) {
      const { cpSync } = await import('node:fs');
      cpSync(stand.coreHome, join(process.env.DUMP, 'core-home'), { recursive: true });
      cpSync(join(stand.cfg, 'projects'), join(process.env.DUMP, 'projects'), { recursive: true });
    }
    const taskId = fresh5[0];
    if (!taskId) return;
    const started = journalOf(taskId).find((l) => l.kind === 'session.started')?.data;
    check(
      `/chat: сеанс claude в корне проекта, на месте (cwd ${started?.cwd})`,
      started?.adapter === 'claude' &&
        resolve(started.cwd).toLowerCase() === resolve(repo).toLowerCase(),
      JSON.stringify(started),
    );
    if (started?.cliPid) {
      const chain = ancestry(started.cliPid, processTable());
      check(
        `/chat: CLI — потомок хоста сеанса ядра, не панели (${chain.join(' ← ')})`,
        chain.includes(started.hostPid) && !chain.includes(stand.serverPid()),
        `host ${started.hostPid}, panel ${stand.serverPid()}`,
      );
    } else check('/chat: номер процесса CLI в журнале ядра', false, JSON.stringify(started));
    const after5 = transcript();
    check(
      '/chat: тот же транскрипт продолжен (ход-4 и ход-5 в одном файле)',
      after5.includes('ответ на ход-4') && after5.includes('ответ на ход-5'),
    );

    // Ход 6: тот же шаг, новой задачи нет.
    const before6 = tasks();
    await say('ход-6: второй ход');
    const answered6 = await shown('ответ на ход-6');
    check('/chat: второй ход получил ответ', answered6, panelTrace.slice(-3).join(' | '));
    check(
      `/chat: второй ход — тем же шагом ядра, новой задачи нет (${tasks().length - before6.length})`,
      tasks().length === before6.length,
    );
    // Ход, доставленный ядром, лежит в транскрипте с шапкой доставки — в пузыре её нет.
    const feed = await page.locator('body').innerText();
    check(
      '/chat: в пузырях человека нет шапки доставки ядра',
      feed.includes('ход-6: второй ход') &&
        !/agentdeck:platform|agentdeck-from|human-origin/.test(feed),
    );
    await shoot(page, 'panel-chat-core-turns');

    // Слово «на ходу» (04.11): ход-9 занят заглушкой, ход-10 уходит посреди него (`steer`). Ядро
    // доставляет слово только на границе хода — новым ходом после хода-9. Прогон панели обязан
    // вести и этот ход: «Остановить» видна, пока он идёт, ответ течёт в ленту без F5. Прежде
    // прогон кончался на первом конце хода, и ход-10 шёл без ленты и без кнопки.
    const sends = [];
    const onSend = (req) => {
      if (req.method() !== 'POST' || !req.url().includes('/api/chat/send')) return;
      const body = req.postDataJSON?.() ?? {};
      sends.push({ steer: body.steer === true, prompt: String(body.prompt ?? '') });
    };
    page.on('request', onSend);
    const stopButton = page.getByRole('button', { name: 'Остановить' });
    const delivered = () => journalOf(taskId).filter((l) => l.kind === 'message.delivered').length;
    const before9 = tasks().length;
    const delivered9 = delivered();
    await say('ход-9: медленный ход');
    for (let i = 0; i < 60 && !panelTrace.some((t) => t.includes('ход-9')); i++) await wait(500);
    const busy9 = await stopButton
      .first()
      .waitFor({ timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    await say('ход-10: дописка на ходу, медленный ход');
    await wait(500);
    const steered = sends.find((s) => s.prompt.includes('ход-10'));
    check(
      '/chat: слово посреди хода ушло «на ходу» (steer), пока ход-9 шёл',
      busy9 && steered?.steer === true,
      JSON.stringify(sends),
    );
    const answered9 = await shown('ответ на ход-9', 60);
    let reached10 = false;
    for (let i = 0; i < 120 && !reached10; i++) {
      reached10 = panelTrace.some((t) => t.includes('ход-10'));
      if (!reached10) await wait(250);
    }
    // Ответ на ход-10 придержан на 8 с: через 2 с после запроса к модели ход ещё идёт.
    await wait(2000);
    const pending10 = (await page.getByText('ответ на ход-10').count()) === 0;
    const stopDuring10 = (await stopButton.count()) > 0;
    await shoot(page, 'panel-chat-core-steer');
    check(
      `/chat: ход по слову «на ходу» — тем же прогоном, «Остановить» видна (ход-9 ответил: ${answered9}, ход-10 у модели: ${reached10}, ответа ещё нет: ${pending10})`,
      answered9 && reached10 && pending10 && stopDuring10,
    );
    check(
      '/chat: ответ на слово «на ходу» течёт в ленту без перезагрузки',
      await shown('ответ на ход-10', 60),
    );
    let idle = false;
    for (let i = 0; i < 60 && !idle; i++) {
      idle = (await stopButton.count()) === 0;
      if (!idle) await wait(500);
    }
    check(
      `/chat: после ответа прогон кончился, задача та же, доставок ядра две (${delivered() - delivered9})`,
      idle && tasks().length === before9 && delivered() - delivered9 === 2,
    );
    page.off('request', onSend);

    // «Остановить»: задача ядра отменена, CLI сеанса снят.
    await say('ход-7: долгий ответ');
    const stop = page.getByRole('button', { name: 'Остановить' }).first();
    const stopShownAt = Date.now();
    const stoppable = await stop
      .waitFor({ timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    // Запрос дошёл до модели — ход идёт по-настоящему, а не стоит в очереди.
    for (let i = 0; i < 60 && !panelTrace.some((t) => t.includes('ход-7')); i++) await wait(500);
    let clicked = false;
    let blockedBy = '';
    let clickError = '';
    if (stoppable) {
      clicked = await stop
        .click({ timeout: 15_000 })
        .then(() => true)
        .catch((error) => {
          // Хвост журнала Playwright называет причину: перекрыта, не стабильна, выключена, пропала.
          clickError = error.message
            .split('\n')
            .filter((l) => l.trim())
            .slice(-2)
            .join(' | ');
          return false;
        });
    }
    if (!clicked) {
      // Кнопки нет или нажатие не прошло (04.11, только под `tests-cli`): признаки уходят в подробность
      // проверки — строкой «~» до истории блока «Тесты» они не доезжали, а дом стенда убирается.
      await shoot(page, 'panel-chat-core-stop-blocked');
      const diag = join(tmpdir(), 'cc-core-chat-diag');
      mkdirSync(diag, { recursive: true });
      await page.screenshot({ path: join(diag, `stop-blocked-${Date.now()}.png`) }).catch(() => {});
      const facts = [
        `ход-7 у модели: ${panelTrace.some((t) => t.includes('ход-7'))}`,
        `ответ на экране: ${await page.getByText('ответ на долгий ход').count()}`,
        `кнопок «Остановить»: ${await page.getByRole('button', { name: 'Остановить' }).count()}`,
        `с отправки ${Math.round((Date.now() - stopShownAt) / 1000)} с`,
        `хвост ядра: ${journalOf(taskId)
          .slice(-5)
          .map((l) => l.kind)
          .join(',')}`,
        `модели последним: ${(panelTrace.at(-1) ?? '').slice(-160)}`,
      ].join('; ');
      blockedBy = ` · ${facts}${clickError ? ` · ${clickError}` : ''}`.replace(/\s+/g, ' ');
    }
    let cancelled = false;
    for (let i = 0; i < 60 && !cancelled; i++) {
      cancelled = journalOf(taskId).some(
        (l) =>
          (l.kind === 'task.transition' && l.data?.to === 'cancelled') ||
          (l.kind === 'task.ended' && l.data?.outcome === 'cancelled'),
      );
      if (!cancelled) await wait(500);
    }
    check(
      `/chat: «Остановить» снял задачу ядра (${journalOf(taskId)
        .slice(-3)
        .map((l) => l.kind)
        .join(', ')})`,
      stoppable && clicked && cancelled,
      `кнопка ${stoppable ? 'видна' : 'не видна'}, нажата: ${clicked}${blockedBy}`,
    );
    if (started?.cliPid) {
      let alive = true;
      for (let i = 0; i < 30 && alive; i++) {
        alive = processTable().has(started.cliPid);
        if (alive) await wait(1000);
      }
      check(`/chat: CLI сеанса ${started.cliPid} после остановки не жив`, !alive);
    }

    // Ход после остановки: новая задача, тот же транскрипт. Модель и глубина шапки (chat-005)
    // уезжают в ядро только стартом задачи (`set-model`) — их выбор стоит перед этим ходом.
    await pickModel({ page, check, wait });
    const before8 = tasks();
    await say('ход-8: после остановки');
    const fresh8 = await newTask(before8);
    const answered8 = await shown('ответ на ход-8');
    check(
      `/chat: ход после остановки — новая задача ядра (${fresh8.join(',') || 'нет'}) с ответом`,
      fresh8.length === 1 && answered8,
      panelTrace.slice(-3).join(' | '),
    );
    modelReached({ check, bodies: panelBodies, mark: 'ход-8' });
    check(
      '/chat: после остановки разговор продолжен в том же транскрипте',
      transcript().includes('ответ на ход-8') && transcript().includes('ответ на ход-4'),
    );

    // Правка вне корня проекта: у чата на месте грант — корень проекта, вне его ядро отказывает
    // само (`outside-copy`, пункта человека нет) — прежнего «спросить перед правкой» здесь нет.
    // Модель получает отказ результатом инструмента, ход кончается ответом, файла нет.
    const outside = join(dirname(repo), 'outside.txt');
    await say('ход-9: запиши вне проекта');
    const refusedShown = await shown('файл прочитан');
    const permitDecision = fresh8[0]
      ? journalOf(fresh8[0]).find(
          (l) =>
            l.kind === 'decision' &&
            l.data?.class === 'permit' &&
            JSON.stringify(l.data).includes('outside-copy'),
        )
      : undefined;
    check(
      '/chat: правка вне проекта — отказ ядра (outside-copy) дошёл до модели, ход кончился ответом',
      refusedShown && Boolean(permitDecision),
      fresh8[0] ? why(fresh8[0]) : '',
    );
    check(`/chat: файла вне проекта нет (${outside})`, !existsSync(outside));
    check(
      '/chat: карточки права на отказ без пункта человека нет',
      (await page.getByText('Агент просит разрешение').count()) === 0,
    );
    await shoot(page, 'panel-chat-core-outside-refused');
    // Основы чата (chat-001, chat-003, chat-009) — тем же живым шагом ядра.
    await basicsSteps({
      stand,
      page,
      input,
      check,
      wait,
      bodies: panelBodies,
      conv,
      taskId: fresh8[0],
      shoot,
      dismissAccess,
    });
    await page.close();
  }

  /**
   * «Новый чат» при активном Claude: остаётся в `/chat`, выбора CLI и «Продолжить через ядро» нет,
   * ход — задача ядра с сеансом claude, ответ на экране. Возвращает разговор и задачу — по ним
   * проверяется старый адрес `/core/chat?id=`.
   */
  async function newClaudeChat(stand, check, browser) {
    const page = await openProjectChat(stand, browser, repo, 'repo');
    await clickNewChat(page);
    const url = new URL(page.url());
    check(
      `Claude: «Новый чат» остался в /chat (${url.pathname}${url.search})`,
      url.pathname === '/chat',
    );
    check(
      'в /chat нет выбора CLI и кнопки «Продолжить через ядро»',
      (await page.locator('[data-core-chat-cli], [data-chat-continue-in-core]').count()) === 0,
    );
    const input = page.locator('textarea[data-chat-input]');
    const before = coreTasks(stand);
    await input.fill('ход-21: новый чат');
    await input.press('Enter');
    const fresh = await newTasks(stand, before);
    const answered = await shownOn(page, 'ответ на ход-21');
    const sessions = fresh[0] ? sessionsOf(stand, fresh[0]) : [];
    check(
      `Claude: ход нового чата — задача ядра (${fresh.join(',') || 'нет'}) с сеансом claude, ответ на экране`,
      fresh.length === 1 && answered && sessions.some((s) => s.adapter === 'claude'),
      JSON.stringify(sessions).slice(0, 300),
    );
    // id разговора встаёт в адрес после первого ответа.
    let conv = null;
    for (let i = 0; i < 20 && !conv; i++) {
      conv = new URL(page.url()).searchParams.get('id');
      if (!conv) await wait(500);
    }
    await shoot(page, 'one-chat-claude-new');
    await page.close();
    return { conv, taskId: fresh[0] };
  }

  /**
   * CLI без хука ядра активным провайдером: новый чат в `/chat`, ход — ядро отказывает по имени.
   * В ленте строка отказа с кодом, композера нет, прежний исполнитель не зовётся, процесса CLI под
   * панелью нет.
   */
  async function refusedChat(stand, check, browser, cli) {
    const page = await openProjectChat(stand, browser, repo, 'repo');
    const legacyPosts = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/provider-chat/chats'))
        legacyPosts.push(request.url());
    });
    try {
      await setProvider(page, cli);
      await page.reload();
      await dismissAccess(page);
      await clickNewChat(page);
      const input = page.locator('textarea[data-chat-input]');
      await input.waitFor({ timeout: 60_000 });
      // Шапка нового чата предлагает модели CLI разговора (W3-17a), не алиасы Claude.
      const picked = await modelOptions(page);
      check(
        `${cli}: выбор модели без алиасов Claude, «по умолчанию» — модель CLI (${JSON.stringify(picked).slice(0, 200)})`,
        picked.length > 0 &&
          !picked.some((o) => isClaudeModel(o.value)) &&
          picked[0]?.label === 'как выберет CLI',
      );
      await input.fill('ход-31: привет');
      await input.press('Enter');
      const named = page.locator('[data-core-chat-launch-refused]');
      const seen = await named
        .waitFor({ timeout: 120_000 })
        .then(() => true)
        .catch(() => false);
      const text = seen ? await named.innerText() : '';
      check(
        `${cli}: ядро отказало по имени, лента называет отказ («${text.replace(/\s+/g, ' ').slice(0, 160)}»)`,
        seen &&
          text.includes('no_core_hook') &&
          (await named.getAttribute('data-core-chat-launch-refused')) === 'no_core_hook',
        seen
          ? ''
          : `панель: ${stand.log().slice(-1200)}\n    ядро: ${stand.coreLog().slice(-1200)}`,
      );
      check(
        `${cli}: композера нет — писать в отказанный чат нечего`,
        (await page.locator('textarea[data-chat-input]').count()) === 0,
      );
      check(
        `${cli}: прежний исполнитель не позван (POST /api/provider-chat/chats: ${legacyPosts.length})`,
        legacyPosts.length === 0,
        legacyPosts.join('\n    '),
      );
      const image = IMAGE[cli] ?? cli;
      const table = processTable();
      const underPanel = [...table].filter(
        ([pid, row]) =>
          new RegExp(`\\b${image}(\\.exe|\\.cmd)?\\b`, 'i').test(row.command) &&
          !/powershell/i.test(row.command) &&
          ancestry(pid, table).includes(stand.serverPid()),
      );
      check(
        `${cli}: процесса ${image} под сервером панели нет`,
        underPanel.length === 0,
        underPanel.map(([pid, row]) => `${pid}: ${row.command.slice(0, 120)}`).join('\n    '),
      );
      await shoot(page, `one-chat-${cli}-refused`);
    } finally {
      await setProvider(page, 'claude').catch(() => undefined);
      await page.close();
    }
  }

  /**
   * Одноразовый контур стенда с галочкой «Чат»: стаб-контур за шлюзом ядра стенда. У CLI без входа
   * (`cliLogin: false` — Qwen, а также aider и continue без хука ядра) иного маршрута нет: без
   * контура `set-cli` такого CLI ядро отказывает `outside-allowed-set` ещё до суда совместимости.
   */
  async function activateContour(stand, check) {
    const KEY = ['chat', 'stub', 'key'].join('-');
    const CONTOUR = 'one-chat';
    const saved = await stand.api(`/platforms/${CONTOUR}`, {
      method: 'PUT',
      body: {
        settings: {
          id: CONTOUR,
          title: 'Контур чата',
          driver: 'enterprise-platform',
          baseUrl: contour.url,
          enabled: true,
          mode: 'best-effort',
          budgetUsd: 0,
          budgetSince: '',
          capabilities: [],
          // Чужой CLI идёт через контур по своей галочке (`chatConsumerOf`), «Чат» — только Claude.
          consumers: ['chat', `foreign:${FOREIGN}`],
          targets: [],
          projectPaths: [],
          agents: [],
          caCertPath: '',
          toolShim: false,
          defaultModel: 'stub-chat',
          // Перевод выбора человека (M-F1): модель Claude из настроек — в модель контура.
          modelMap: { [CONTOUR_PICK]: CONTOUR_PICKED },
        },
        token: KEY,
      },
    });
    const activated = await stand.api(`/platforms/${CONTOUR}/activate?probe=skip`, {
      method: 'POST',
      body: {},
    });
    const restarted = await stand.api('/platforms/gateway/restart', { method: 'POST', body: {} });
    check(
      'контур стенда «Чат» сохранён, активен, шлюз на своём порту',
      saved.status === 200 &&
        activated.body?.activePlatformId === CONTOUR &&
        restarted.body?.status?.running === true,
      JSON.stringify([saved.body, activated.body, restarted.body?.status]).slice(0, 500),
    );
  }

  /**
   * Чужой CLI активным провайдером: новый чат в `/chat` отвечает через него — модель за контуром
   * стенда (галочка «чат» у контура), сеанс этого CLI в журнале ядра, модель claude хода не видела.
   * Потом активный снова Claude — тот же открытый чат продолжает свой CLI.
   */
  async function foreignChat(stand, check, browser) {
    const page = await openProjectChat(stand, browser, repo, 'repo');
    const contourCalls = () =>
      contour.calls.filter((call) => call.path.endsWith('/chat/completions')).length;
    try {
      await setProvider(page, FOREIGN);
      await page.reload();
      await dismissAccess(page);
      await clickNewChat(page);
      const input = page.locator('textarea[data-chat-input]');
      await input.waitFor({ timeout: 60_000 });
      const before = coreTasks(stand);
      const calls0 = contourCalls();
      await input.fill('ход-41: привет');
      await input.press('Enter');
      const fresh = await newTasks(stand, before);
      const answered = await shownOn(page, 'готов');
      const sessions = fresh[0] ? sessionsOf(stand, fresh[0]) : [];
      const tail = fresh[0]
        ? coreJournal(stand, fresh[0])
            .slice(-10)
            .map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 160)}`)
            .join('\n      ')
        : `панель: ${stand.log().slice(-1200)}`;
      check(
        `${FOREIGN}: новый чат в /chat — задача ядра (${fresh.join(',') || 'нет'}) с сеансом ${FOREIGN}, ответ контура на экране`,
        fresh.length === 1 && answered && sessions.some((s) => s.adapter === FOREIGN),
        `${JSON.stringify(sessions).slice(0, 300)}\n      ${tail}`,
      );
      check(
        `${FOREIGN}: запрос дошёл до контура (${contourCalls() - calls0}), модель claude хода не видела`,
        contourCalls() > calls0 && !panelTrace.some((t) => t.includes('ход-41')),
      );
      // Имя Claude другому CLI не уходит (W3-17a): ни одной правки модели с ним в журнале задачи.
      const models41 = fresh[0] ? modelOverrides(stand, fresh[0]) : [];
      check(
        `${FOREIGN}: правки модели задачи без имени Claude (${JSON.stringify(models41)})`,
        fresh.length === 1 && !models41.some(isClaudeModel),
      );
      await shoot(page, `one-chat-${FOREIGN}-new`);

      // Активный снова Claude — переключатель провайдера, страница та же: открытый чат
      // продолжает свой CLI.
      await setProvider(page, 'claude');
      // «готов» на экране — ещё не конец хода: qwen после ответа делает свой запрос к модели, и
      // слово, отправленное в это окно, уходит «на ходу» (steer), а не продолжением законченного хода.
      // Прежде шаг попадал туда через раз (контур +3 — хвост хода-41 в счёте, слово пропадало).
      // Здесь — продолжение ЗАКОНЧЕННОГО хода; слово «на ходу» проверяет шаг ход-44 ниже.
      const stopButton = page.getByRole('button', { name: 'Остановить' });
      const idle = async (seconds) => {
        for (let i = 0; i < seconds * 4; i++) {
          if ((await stopButton.count()) === 0) return true;
          await wait(250);
        }
        return false;
      };
      const idle41 = await idle(120);
      const before2 = coreTasks(stand);
      const calls1 = contourCalls();
      const answers1 = await page.getByText('готов', { exact: true }).count();
      await input.waitFor({ timeout: 60_000 });
      await input.fill('ход-42: дальше');
      await input.press('Enter');
      let reached = false;
      for (let i = 0; i < 180 && !reached; i++) {
        reached = contourCalls() > calls1;
        if (!reached) await wait(1000);
      }
      // Ответ на ход-N — реплика ленты ПОСЛЕ пузыря ход-N (тексты ответов контура одинаковы,
      // поэтому по порядку, а не по числу). Ответ идущего разговора чужого CLI стоит живой репликой
      // хода, а не строкой `[data-feed-message]` (прогон 6: в ленте только «ход-41», «ход-42»), —
      // ищется текстовый узел «готов» ниже пузыря ход-N в порядке документа.
      const answeredAfter = (word = 'ход-42') =>
        page.evaluate((said) => {
          const sent = [...document.querySelectorAll('[data-feed-message]')].find((el) =>
            el.textContent?.includes(said),
          );
          if (!sent) return false;
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.textContent?.trim() !== 'готов') continue;
            if (sent.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) return true;
          }
          return false;
        }, word);
      let answered2 = false;
      for (let i = 0; i < 60 && !answered2; i++) {
        answered2 = await answeredAfter();
        if (!answered2) await wait(1000);
      }
      const answers2 = await page.getByText('готов', { exact: true }).count();
      const later = coreTasks(stand).filter((t) => !before2.includes(t));
      const laterSessions = later.flatMap((t) => sessionsOf(stand, t));
      const models42 = later.flatMap((t) => modelOverrides(stand, t));
      check(
        `${FOREIGN}: продолжение при активном Claude — правки модели без имени Claude (${JSON.stringify(models42)})`,
        !models42.some(isClaudeModel),
      );
      check(
        `${FOREIGN}: при активном Claude тот же чат продолжен через ${FOREIGN} (ход-41 кончился: ${idle41}, контур: +${contourCalls() - calls1}, ответ после ход-42 на экране: ${answered2}, новых задач ${later.length})`,
        idle41 &&
          reached &&
          answered2 &&
          !panelTrace.some((t) => t.includes('ход-42')) &&
          laterSessions.every((s) => s.adapter === FOREIGN),
        `${JSON.stringify(laterSessions).slice(0, 300)}\n      лента: ${JSON.stringify(
          await page.locator('[data-feed-message]').allInnerTexts(),
        ).slice(0, 600)}\n      экран: ${(await page.locator('main').innerText()).slice(-600)}`,
      );
      // Известный пробел (отчёт W3-17a): транскрипта у чужого CLI панель не читает, и прежний ответ
      // разговора не CLI Claude из ленты уходит, когда начинается следующий ход. Печатается, не судится.
      console.log(
        `  ~ ${FOREIGN}: ответов «готов» на экране после двух ходов: ${answers1} → ${answers2}`,
      );
      await shoot(page, `one-chat-${FOREIGN}-continued`);

      // Слово «на ходу» у чата чужого CLI: ход-44 уходит, пока ход-43 ещё идёт (запрос хода-43 уже
      // у контура). Ядро доставит его новым ходом того же прогона. Транскрипта qwen панель не
      // читает: прежде слово пропадало с экрана по концу прогона, а ответ на него дописывался к
      // прежнему одним текстом («готовготов»). Судится экран ПОСЛЕ конца прогона.
      await idle(120);
      const sends = [];
      const onSend = (req) => {
        if (req.method() !== 'POST' || !req.url().includes('/api/chat/send')) return;
        const body = req.postDataJSON?.() ?? {};
        sends.push({ steer: body.steer === true, prompt: String(body.prompt ?? '') });
      };
      page.on('request', onSend);
      const calls3 = contourCalls();
      await input.fill('ход-43: ещё');
      await input.press('Enter');
      for (let i = 0; i < 1200 && contourCalls() === calls3; i++) await wait(50);
      await input.fill('ход-44: на ходу');
      await input.press('Enter');
      let answered44 = false;
      let idle44 = false;
      for (let i = 0; i < 90 && !(answered44 && idle44); i++) {
        idle44 = (await stopButton.count()) === 0;
        answered44 = await answeredAfter('ход-44');
        if (!(answered44 && idle44)) await wait(1000);
      }
      // Конец прогона снимал слово — суд после него, с запасом на перерисовку.
      await wait(1500);
      const feed44 = await page.locator('[data-feed-message]').allInnerTexts();
      answered44 = await answeredAfter('ход-44');
      const steered44 = sends.find((s) => s.prompt.includes('ход-44'))?.steer === true;
      page.off('request', onSend);
      check(
        `${FOREIGN}: слово «на ходу» (ход-44) и ответ на него на экране после конца прогона (ушло на ходу: ${steered44}, прогон кончился: ${idle44}, ответ после ход-44: ${answered44})`,
        steered44 &&
          idle44 &&
          answered44 &&
          feed44.some((t) => t.includes('ход-43')) &&
          feed44.some((t) => t.includes('ход-44')),
        `отправки: ${JSON.stringify(sends)}\n      лента: ${JSON.stringify(feed44).slice(0, 600)}\n      экран: ${(await page.locator('main').innerText()).slice(-600)}`,
      );
      await shoot(page, `one-chat-${FOREIGN}-steer`);
    } finally {
      await setProvider(page, 'claude').catch(() => undefined);
      await page.close();
    }
  }

  /**
   * Выбор модели через контур (ревью W3-17a, M-F1). У чата чужого CLI модель решает перевод контура,
   * а каталог контура один у любого CLI и несёт `claude-*`. Модель Claude из настроек (`chatModel`)
   * доходит до карты контура (`claude-sonnet-5-5` → `stub-reasoning`): её показывает запертая шапка, её
   * шлёт `set-model`, с ней запрос приходит в контур. Прежде шапка и сервер срезали имя Claude ДО
   * перевода — ход шёл на модели контура по умолчанию, выбор человека пропадал молча.
   */
  async function contourPick(stand, check, browser) {
    const page = await openProjectChat(stand, browser, repo, 'repo');
    const completions = (from) =>
      contour.calls
        .slice(from)
        .filter((call) => call.path.endsWith('/chat/completions'))
        .map((call) => {
          try {
            return String(JSON.parse(String(call.body ?? '{}')).model ?? '');
          } catch {
            return '?';
          }
        });
    try {
      await setProvider(page, FOREIGN);
      await patchSettings(page, { chatModel: CONTOUR_PICK });
      await page.reload();
      await dismissAccess(page);
      await clickNewChat(page);
      const input = page.locator('textarea[data-chat-input]');
      await input.waitFor({ timeout: 60_000 });
      // Запертая шапка — то, что уедет: перевод контура, а не модель контура по умолчанию.
      const header = page.locator('select[aria-label="Модель"]').first();
      await header.waitFor({ timeout: 30_000 });
      let shown = '';
      for (let i = 0; i < 30 && shown !== CONTOUR_PICKED; i++) {
        shown = await header.evaluate((el) => el.options[el.selectedIndex]?.text ?? '');
        if (shown !== CONTOUR_PICKED) await wait(1000);
      }
      const before = coreTasks(stand);
      const from = contour.calls.length;
      await input.fill('ход-43: выбор');
      await input.press('Enter');
      const fresh = await newTasks(stand, before);
      for (let i = 0; i < 180 && completions(from).length === 0; i++) await wait(1000);
      const answered = await shownOn(page, 'готов');
      const sent = completions(from);
      const overrides = fresh[0] ? modelOverrides(stand, fresh[0]) : [];
      check(
        `${FOREIGN} через контур: модель Claude из настроек переведена контуром — шапка «${shown}», set-model ${JSON.stringify(overrides)}, в контур ${JSON.stringify(sent)}`,
        fresh.length === 1 &&
          answered &&
          shown === CONTOUR_PICKED &&
          overrides.includes(CONTOUR_PICKED) &&
          sent.length > 0 &&
          sent.every((model) => model === CONTOUR_PICKED),
        fresh[0]
          ? coreJournal(stand, fresh[0])
              .slice(-12)
              .map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 200)}`)
              .join('\n      ')
          : `панель: ${stand.log().slice(-1200)}`,
      );
      await shoot(page, `one-chat-${FOREIGN}-contour-pick`);
    } finally {
      await patchSettings(page, { chatModel: '' }).catch(() => undefined);
      await setProvider(page, 'claude').catch(() => undefined);
      await page.close();
    }
  }

  /**
   * Старый адрес `/core/chat`: страницы нет, переход в `/chat`. `?project=` переходит (CLI снят),
   * вкладка проекта открыта; `?id=<задача>` — разговор этой задачи по книге чата.
   */
  async function oldAddress(stand, check, browser, claudeChat) {
    const page = await stand.newPage(browser);
    const seen = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) seen.push(frame.url());
    });
    try {
      await page.goto(
        `${stand.webUrl}/core/chat?project=${encodeURIComponent(repo)}&cli=${encodeURIComponent(FOREIGN || 'qwen')}`,
      );
      await page.waitForURL((u) => u.pathname === '/chat', { timeout: 60_000 });
      await dismissAccess(page);
      const landed = seen
        .map((u) => new URL(u))
        .find((u) => u.pathname === '/chat' && u.searchParams.get('project') === repo);
      check(
        `/core/chat?project=X&cli=… → /chat?project=X без cli (${landed ? landed.search : seen.join(' | ')})`,
        Boolean(landed) && !landed.searchParams.has('cli'),
      );
      const tabOpened = await shownOn(page, repo, 60);
      check(`вкладка проекта открыта по ?project= (${repo})`, tabOpened);
      await shoot(page, 'one-chat-old-address-project');

      if (claudeChat?.taskId && claudeChat.conv) {
        await page.goto(`${stand.webUrl}/core/chat?id=${encodeURIComponent(claudeChat.taskId)}`);
        await page.waitForURL((u) => u.pathname === '/chat', { timeout: 60_000 });
        const id = await page
          .waitForURL((u) => u.searchParams.get('id') === claudeChat.conv, { timeout: 30_000 })
          .then(() => claudeChat.conv)
          .catch(() => new URL(page.url()).searchParams.get('id'));
        check(
          `/core/chat?id=<задача> → разговор этой задачи в /chat (${id ?? '—'})`,
          id === claudeChat.conv,
        );
        await page.goto(`${stand.webUrl}/core/chat?id=no-such-task`);
        await page.waitForURL((u) => u.pathname === '/chat', { timeout: 60_000 });
        check(
          `/core/chat?id=<незнакомая задача> → /chat без разговора (${new URL(page.url()).search || 'пусто'})`,
          new URL(page.url()).searchParams.get('id') !== 'no-such-task',
        );
      } else check('/core/chat?id=: разговор нового чата claude известен', false);
    } finally {
      await page.close();
    }
  }
}
