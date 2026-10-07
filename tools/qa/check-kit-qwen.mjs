/**
 * Набор панели в настоящем Qwen Code: хуки срабатывают, а не просто лежат в расширении.
 *
 * `check-kit.mjs` подменяет CLI и видит только раскладку; здесь — живой `qwen` (0.25+) на
 * заглушке модели (OpenAI chat, поток). Каталог `QWEN_HOME` собирает тот же код, что и прогон
 * панели (`composeQwenHome`), из встроенного набора. Модель на первом ходе просит оболочку
 * выполнить опасную команду во временном git-репозитории с несохранённой правкой.
 *
 * Свидетели: файл репозитория (команда выполнилась или нет), тело запросов к модели (контекст
 * SessionStart дошёл до модели), ответ инструмента (какой сторож остановил). Контроль — тот же
 * прогон с пустым `QWEN_HOME`: команда обязана выполниться, иначе проверка ничего не доказывает.
 *
 * CLI ищется в `QWEN_CLI` (путь к `cli-entry.js` или к исполняемому `qwen`), иначе в каталогах
 * `STEER_CLI_DIR` и PATH.
 * Нет CLI — «НЕ ПРОВЕРЕНО», код 2 (junit-run считает это пропуском). Настоящие `~/.qwen` и
 * домашний каталог не трогаются: дом CLI, HOME и состояние хуков — во временной папке.
 *
 * Запуск: node tools/qa/check-kit-qwen.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Сборку импортируем из `.ts`: Node 22 без флага TypeScript не читает, а junit-run зовёт скрипт
// голым `node` — перезапускаемся с флагом и отдаём его код выхода.
if (!process.features.typescript) {
  const self = spawnSync(
    process.execPath,
    ['--experimental-strip-types', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exit(self.status ?? 1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KIT = join(ROOT, 'apps/server/assets/kit/agentdeck-kit');
const VARIANT = join(ROOT, 'apps/server/assets/kit/variants/qwen');

/** Как запустить qwen: `[команда, ...аргументы]` или null. */
function findQwen() {
  const pick = (p) => (p.endsWith('.js') ? [process.execPath, p] : [p]);
  if (process.env.QWEN_CLI)
    return existsSync(process.env.QWEN_CLI) ? pick(process.env.QWEN_CLI) : null;
  // Как в check-foreign-steer: сначала каталоги из STEER_CLI_DIR, потом PATH.
  const dirs = [process.env.STEER_CLI_DIR, process.env.PATH].filter(Boolean).join(delimiter);
  for (const dir of dirs.split(delimiter)) {
    const entry = join(dir, '..', '@qwen-code', 'qwen-code', 'cli-entry.js');
    if (existsSync(join(dir, 'qwen')) && existsSync(entry)) return pick(entry);
    if (process.platform !== 'win32' && existsSync(join(dir, 'qwen')))
      return pick(join(dir, 'qwen'));
  }
  return null;
}

/** Заглушка модели: без результата инструмента — вызов оболочки с `command`, иначе «DONE». */
async function startModel(command) {
  const bodies = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) return void res.writeHead(404).end();
      bodies.push(body);
      const json = JSON.parse(body || '{}');
      const shell = (json.tools ?? [])
        .map((t) => t.function?.name)
        .find((n) => /shell|bash/i.test(n ?? ''));
      const answered = (json.messages ?? []).some((m) => m.role === 'tool');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const head = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'stub-model' };
      const send = (choice, usage) =>
        res.write(
          `data: ${JSON.stringify({ ...head, choices: [choice], ...(usage ? { usage } : {}) })}\n\n`,
        );
      const usage = { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 };
      if (shell && !answered) {
        const args = { command, is_background: false, description: 'cleanup' };
        send({
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call1',
                type: 'function',
                function: { name: shell, arguments: JSON.stringify(args) },
              },
            ],
          },
        });
        send({ index: 0, delta: {}, finish_reason: 'tool_calls' }, usage);
      } else {
        send({ index: 0, delta: { role: 'assistant', content: 'DONE' } });
        send({ index: 0, delta: {}, finish_reason: 'stop' }, usage);
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, bodies, close: () => server.close() };
}

/** Один прогон: `withKit` — дом собран кодом панели; иначе пустой. */
async function runOnce(qwen, root, name, { withKit, command }) {
  const dir = join(root, name);
  const repo = join(dir, 'repo');
  const home = join(dir, 'qwen-home');
  const user = join(dir, 'user');
  for (const d of [repo, home, user]) mkdirSync(d, { recursive: true });
  const git = (...a) =>
    spawnSync('git', ['-c', 'user.email=qa@example.com', '-c', 'user.name=qa', ...a], {
      cwd: repo,
    });
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'orig\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'a');
  writeFileSync(join(repo, 'a.txt'), 'dirty\n');

  if (withKit) {
    const { composeQwenHome } = await import(
      pathToFileURL(join(ROOT, 'apps/server/src/domains/kit/compose.ts')).href
    );
    composeQwenHome(KIT, home, true, VARIANT);
  }
  const model = await startModel(command);
  const env = {
    ...process.env,
    QWEN_HOME: home,
    HOME: user,
    USERPROFILE: user,
    AGENTDECK_KIT_STATE: join(dir, 'kit-state'),
    OPENAI_BASE_URL: `${model.base}/v1`,
    OPENAI_API_KEY: 'x',
    OPENAI_MODEL: 'stub-model',
    QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
  };
  // yolo: без набора оболочка выполняется без вопроса — значит остановить её может только хук.
  const child = spawn(
    qwen[0],
    [...qwen.slice(1), '-p', 'clean up the repo', '--yolo', '--output-format', 'json'],
    {
      cwd: repo,
      env,
    },
  );
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.resume();
  const exit = await new Promise((r) => {
    const t = setTimeout(() => (child.kill(), r('timeout')), 120_000);
    child.on('exit', (c) => (clearTimeout(t), r(c)));
  });
  model.close();
  const toolText = model.bodies
    .flatMap((b) => JSON.parse(b).messages ?? [])
    .filter((m) => m.role === 'tool')
    .map((m) => JSON.stringify(m.content))
    .join(' ');
  return {
    exit,
    stderr: stderr.slice(-400),
    requests: model.bodies.length,
    ran: readFileSync(join(repo, 'a.txt'), 'utf8').trim() === 'orig',
    // Строку «Kit root» печатает только хук SessionStart (session-rules.mjs), не QWEN.md.
    kitContext: /Kit root \(/.test(model.bodies[0] ?? ''),
    toolText,
  };
}

const qwen = findQwen();
if (!qwen) {
  console.log('НЕ ПРОВЕРЕНО: qwen не найден (QWEN_CLI или PATH)');
  process.exit(2);
}
const version = spawnSync(qwen[0], [...qwen.slice(1), '--version'], {
  encoding: 'utf8',
}).stdout.trim();
const root = mkdtempSync(join(tmpdir(), 'check-kit-qwen-'));
const rows = [];
const row = (what, expected, actual, ok) => rows.push({ what, expected, actual, ok });

try {
  const bare = await runOnce(qwen, root, 'bare', { withKit: false, command: 'git reset --hard' });
  row(
    'контроль: без набора git reset --hard выполняется',
    'выполнилась',
    bare.ran ? 'выполнилась' : `нет (exit ${bare.exit})`,
    bare.ran,
  );
  row(
    'контроль: без набора контекста набора нет',
    'нет',
    bare.kitContext ? 'есть' : 'нет',
    !bare.kitContext,
  );

  const reset = await runOnce(qwen, root, 'kit-reset', {
    withKit: true,
    command: 'git reset --hard',
  });
  row(
    'SessionStart: строка набора дошла до модели',
    'есть',
    reset.kitContext ? 'есть' : 'нет',
    reset.kitContext,
  );
  row(
    'PreToolUse: git reset --hard остановлен',
    'не выполнилась',
    reset.ran ? 'выполнилась' : 'не выполнилась',
    !reset.ran,
  );
  row(
    'ответ инструмента называет сторож git',
    'git-guard',
    /git-guard/.test(reset.toolText) ? 'git-guard' : reset.toolText.slice(0, 120) || '—',
    /git-guard/.test(reset.toolText),
  );

  const sql = await runOnce(qwen, root, 'kit-sql', {
    withKit: true,
    command: 'echo drop table users',
  });
  row(
    'PreToolUse: «drop table» остановлен',
    'не выполнилась',
    /destructive-guard/.test(sql.toolText) ? 'не выполнилась' : 'выполнилась',
    /destructive-guard/.test(sql.toolText),
  );

  const safe = await runOnce(qwen, root, 'kit-safe', {
    withKit: true,
    command: 'echo kit-safe-ok',
  });
  row(
    'безопасная команда с набором проходит',
    'kit-safe-ok',
    /kit-safe-ok/.test(safe.toolText) ? 'kit-safe-ok' : safe.toolText.slice(0, 120) || '—',
    /kit-safe-ok/.test(safe.toolText),
  );
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

console.log(`qwen ${version}`);
for (const r of rows)
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} | ${r.what} | ждали: ${r.expected} | есть: ${r.actual}`);
const failed = rows.filter((r) => !r.ok).length;
console.log(`${rows.length - failed}/${rows.length}`);
process.exit(failed ? 1 : 0);
