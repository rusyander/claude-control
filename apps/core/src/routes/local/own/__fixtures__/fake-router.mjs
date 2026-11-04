// Подставной llama-server в режиме маршрутизатора: те же аргументы (`--models-preset`,
// `--port`, `--host`), те же пути (`/health`, `GET /models`, `POST /models/load|unload`) и та
// же форма ответов, что у сборки 11193 (замер 28.10). Загрузка поднимает ДОЧЕРНИЙ процесс-раннер
// (`fake-runner.mjs`), модельные пути `/v1/*` проксируются к нему — дерево процессов как у
// настоящего. Режим — FAKE_ROUTER_MODE: `normal`, `orphan-runner` (раннер отвязан и без метки),
// `fail-load` (раннер падает при старте).
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (name) => argv[argv.indexOf(name) + 1];
const port = Number(arg('--port'));
const host = arg('--host') ?? '127.0.0.1';
const mode = process.env.FAKE_ROUTER_MODE ?? 'normal';
const RUNNER = fileURLToPath(new URL('./fake-runner.mjs', import.meta.url));

/** `[id]\nmodel = path` → Map id → path. */
const presets = new Map();
let section;
for (const line of readFileSync(arg('--models-preset'), 'utf8').split('\n')) {
  const head = /^\[(.+)\]$/.exec(line.trim());
  // Как сборка 11583 (замер 02.11): метка после двоеточия — заглавными (`qwen3.8:27b` →
  // `qwen3.8:27B`), дальше имя ищется точно — `/models/load` с исходным именем получает отказ.
  if (head) section = head[1].replace(/:([^:]+)$/, (_, tag) => `:${tag.toUpperCase()}`);
  const model = /^model\s*=\s*(.+)$/.exec(line.trim());
  if (model && section) presets.set(section, model[1]);
}

/** id → { state, child?, port?, failed?, exitCode? } */
const models = new Map([...presets.keys()].map((id) => [id, { state: 'unloaded' }]));

function load(id) {
  const entry = models.get(id);
  entry.state = 'loading';
  entry.failed = false;
  // Занятая память раннера: FAKE_VRAM_BYTES (тест задаёт ощутимое против допуска), иначе размер файла.
  const bytes = Number(process.env.FAKE_VRAM_BYTES ?? statSync(presets.get(id)).size);
  const lead = mode === 'orphan-runner' ? ['--orphan'] : [];
  const child = spawn(
    process.execPath,
    mode === 'fail-load' ? ['-e', 'process.exit(3)'] : [RUNNER, ...lead, id, String(bytes)],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  );
  entry.child = child;
  let seen = '';
  child.stdout.on('data', (chunk) => {
    seen += chunk;
    const ready = /READY (\d+)/.exec(seen);
    if (ready && entry.state === 'loading') {
      entry.port = Number(ready[1]);
      entry.state = 'loaded';
    }
  });
  child.on('exit', (code) => {
    if (entry.state === 'loading') {
      entry.state = 'unloaded';
      entry.failed = true;
      entry.exitCode = code ?? -1;
    } else if (mode !== 'orphan-runner' && entry.child === child) {
      // Раннер ушёл сам — модели больше нет (в режиме сироты посредник выходит всегда).
      entry.state = 'unloaded';
    }
  });
}

function unload(id) {
  const entry = models.get(id);
  entry.child?.kill();
  entry.child = undefined;
  entry.port = undefined;
  entry.state = 'unloaded';
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/health') return json(res, 200, { status: 'ok' });
    if (req.method === 'GET' && path === '/models')
      return json(res, 200, {
        object: 'list',
        data: [...models].map(([id, entry]) => ({
          id,
          status: {
            value: entry.state,
            ...(entry.failed ? { failed: true, exit_code: entry.exitCode } : {}),
          },
        })),
      });
    if (req.method === 'POST' && (path === '/models/load' || path === '/models/unload')) {
      const id = JSON.parse(raw || '{}').model;
      if (!models.has(id)) return json(res, 400, { error: { message: `model ${id} not found` } });
      // Журнал управляющих вызовов: тест видит, что маршрут ПРОСИЛ выгрузку, а не только то,
      // что остановка дерева всё равно убрала раннера.
      appendFileSync(join(process.env.FAKE_VRAM_DIR, 'router-calls.log'), `${path} ${id}\n`);
      if (path === '/models/load') load(id);
      else unload(id);
      return json(res, 200, { success: true });
    }
    if (path.startsWith('/v1/')) {
      const id = JSON.parse(raw || '{}').model;
      const entry = models.get(id);
      if (!entry || entry.state !== 'loaded')
        return json(res, 400, { error: { message: `model ${id} is not loaded` } });
      const upstream = request(
        {
          host: '127.0.0.1',
          port: entry.port,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on('error', (error) => json(res, 502, { error: { message: String(error) } }));
      upstream.end(raw);
      return undefined;
    }
    return json(res, 404, { error: { message: 'not found' } });
  });
});
server.listen(port, host);
process.on('SIGTERM', () => process.exit(0));
