'use strict';
/**
 * Preload журнала проверок: `NODE_OPTIONS=--require "<этот файл>"`, ставит
 * панель всем, кого запускает (`.agent/tmp/verify-ledger-design.agent.md` §2
 * «Enforcement»). Работает в процессе, без участия модели — значит, у любого
 * CLI, локального и контурного запуска, лишь бы он не вычищал окружение.
 *
 * Процесс-проверка (см. `checks.cjs`): отпечаток дерева в начале и в конце,
 * вывод копится, на выходе — запись. При совпадении ключа с прошлым зелёным:
 * в режиме `on` — повтор вывода и кода без прогона, в тени (по умолчанию) —
 * прогон как есть и строка «повторил бы» в ленту, а на выходе сверка: код
 * прогона обязан совпасть с записанным, иначе это расхождение.
 *
 * Любой сбой здесь — тишина: preload грузится в каждый node, включая сам CLI,
 * и упавший preload уронил бы всё. Рабочие потоки (worker_threads) он тоже
 * получает — там он ничего не делает.
 */
try {
  main();
} catch {
  /* журнал экономит, но никогда не мешает проверке */
}

function main() {
  if (!require('node:worker_threads').isMainThread) return;
  // Два пути подключения (окружение панели и `settings.json` CLI) не дают двойной записи.
  const LOADED = Symbol.for('agentdeck.verify-ledger');
  if (globalThis[LOADED]) return;
  globalThis[LOADED] = true;
  const { recognize } = require('./checks.cjs');
  const cwd = process.cwd();
  const match = recognize(process.argv, cwd);
  if (!match) return;
  const L = require('./ledger.cjs');
  L.heartbeat();
  const startedAt = Date.now();
  const repo = L.repoOf(cwd);
  if (repo.off) return L.appendEvent({ kind: 'off', reason: repo.off, check: match.id });
  let start;
  try {
    start = L.snapshot(repo);
  } catch (error) {
    // Молчаливый сбой снимка 19.10 спрятал от журнала все прогоны групп: причина — в ленту.
    const reason = `snapshot-failed: ${String(error?.message ?? error)
      .split('\n')[0]
      .slice(0, 160)}`;
    return L.appendEvent({ kind: 'off', reason, check: match.id, repo: repo.top });
  }
  if (start.off)
    return L.appendEvent({ kind: 'off', reason: start.off, check: match.id, repo: repo.top });
  const parts = L.keyParts({ repo, match, cwd, tree: start.tree });
  const key = L.keyOf(parts);
  const checkId = L.checkIdOf(parts);
  const mode = L.modeOf();
  const decision = L.decide(repo, key, {
    now: startedAt,
    flaky: L.isFlaky(repo, checkId, startedAt),
  });
  const hit = decision.hit && !match.noSkip ? decision.hit : null;
  const base = {
    key,
    checkId,
    check: match.id,
    parts,
    startedAt,
    provider: process.env.AGENTDECK_VERIFY_LEDGER_CLI ?? null,
    session: process.env.AGENTDECK_VERIFY_LEDGER_SESSION ?? null,
    pid: process.pid,
    by: 'preload',
    scope: 'whole',
  };
  const event = { check: match.id, repo: repo.top, key: key.slice(0, 12) };

  if (hit && mode === 'on') {
    const bodies = L.replayBodies(repo, hit);
    writeAll(1, bodies.stdout);
    writeAll(2, bodies.stderr);
    const at = new Date(hit.startedAt).toISOString();
    writeAll(
      2,
      Buffer.from(
        `[verify-ledger] reused green ${hit.runId} from ${at} (key ${key.slice(0, 8)}); AGENTDECK_VERIFY_LEDGER=off forces a run\n`,
      ),
    );
    const empty = Buffer.alloc(0);
    L.writeRecord(
      repo,
      { ...base, exit: hit.exit, ms: Date.now() - startedAt, reusedFrom: hit.runId },
      {
        stdout: empty,
        stderr: empty,
        complete: false,
      },
    );
    L.appendEvent({ ...event, kind: 'hit', savedMs: hit.ms });
    process.exit(hit.exit);
  }
  if (hit)
    L.appendEvent({ ...event, kind: 'would-skip', recordedExit: hit.exit, savedMs: hit.ms, mode });
  else L.appendEvent({ ...event, kind: 'miss', reason: match.noSkip ?? decision.reason, mode });

  const D = require('./delta.cjs');
  const delta =
    !hit && mode === 'on' && decision.reason === 'no-record'
      ? D.plan({ repo, parts, match, cwd, tree: start.tree, now: startedAt })
      : null;
  if (delta?.files) narrow(L, D, { repo, delta, base, event, startedAt });

  const capture = startCapture();
  process.on('exit', (code) => {
    try {
      const record = finish(L, { repo, match, start, base, event, hit, mode, capture, code });
      if (code === 0 && record)
        rememberGreen(D, { repo, match, parts, cwd, start, delta, base, runId: record.runId });
    } catch {
      /* сбой записи — прогона просто нет в журнале */
    }
  });
}

/**
 * Сужение от последнего зелёного (`delta.cjs`): argv становится `vitest related <Δ>`.
 * Внутри пакета не изменилось ничего видимого тестам — повтор зелёного G, как при
 * совпадении ключа. Строка о сужении печатается всегда: прогон уже не тот, что набран.
 */
function narrow(L, D, { repo, delta, base, event, startedAt }) {
  const { last } = delta;
  const at = new Date(last.at).toISOString();
  if (delta.files.length === 0) {
    const green = L.records(repo, last.key).find((r) => r.runId === last.runId);
    if (!green) return;
    const bodies = L.replayBodies(repo, green);
    writeAll(1, bodies.stdout);
    writeAll(2, bodies.stderr);
    writeAll(
      2,
      Buffer.from(
        `[verify-ledger] nothing the tests can see changed since green ${last.runId} from ${at}; reused. AGENTDECK_VERIFY_LEDGER_DELTA=off forces a run\n`,
      ),
    );
    const empty = Buffer.alloc(0);
    L.writeRecord(
      repo,
      {
        ...base,
        exit: 0,
        ms: Date.now() - startedAt,
        reusedFrom: last.runId,
        scope: `delta:${last.tree.slice(0, 12)}`,
      },
      { stdout: empty, stderr: empty, complete: false },
    );
    L.appendEvent({ ...event, kind: 'hit', savedMs: green.ms, delta: 0 });
    process.exit(0);
  }
  process.argv = [process.argv[0], process.argv[1], ...D.narrowedArgs(delta.shape, delta.files)];
  base.scope = `delta:${last.tree.slice(0, 12)}`;
  base.chain = (last.chain ?? 0) + 1;
  writeAll(
    2,
    Buffer.from(
      `[verify-ledger] delta since green ${last.runId} from ${at}: vitest related on ${delta.files.length} changed file(s) (${delta.files.slice(0, 5).join(', ')}${delta.files.length > 5 ? ', …' : ''}); AGENTDECK_VERIFY_LEDGER_DELTA=off runs the whole set\n`,
    ),
  );
  L.appendEvent({ ...event, kind: 'delta', files: delta.files.length, chain: base.chain });
}

/** Зелёный прогон — новая точка отсчёта для сужения того же семейства. */
function rememberGreen(D, { repo, match, parts, cwd, start, delta, base, runId }) {
  if (match.id !== 'vitest' || match.noSkip) return;
  const shape = delta?.shape ?? D.vitestShape(match.args);
  if (!shape) return;
  const family = delta?.family ?? D.familyOf(parts, shape);
  const narrowed = Boolean(delta?.files);
  const prev = narrowed ? delta.last : null;
  const files = D.claimFiles(shape, cwd);
  D.writeLast(repo, family, {
    key: base.key,
    runId,
    tree: start.tree,
    at: base.startedAt,
    files: files ? [...new Set([...(prev?.files ?? []), ...files])] : null,
    chain: narrowed ? base.chain : 0,
    fullAt: narrowed ? prev.fullAt : base.startedAt,
  });
}

/**
 * Конец прогона. Запись — только если дерево не менялось ни по содержимому, ни
 * по mtime (правка с откатом посреди прогона), вывод уместился и весь прошёл
 * через нас. Убитый процесс (SIGKILL, TaskStop, таймаут Bash) сюда не доходит —
 * и записи нет: недоделанный прогон не вердикт.
 */
function finish(L, { repo, match, start, base, event, hit, mode, capture, code }) {
  const ms = Date.now() - base.startedAt;
  if (hit && mode !== 'on') {
    const same = code === hit.exit;
    L.appendEvent({
      ...event,
      kind: same ? 'shadow-ok' : 'mismatch',
      recordedExit: hit.exit,
      exit: code,
      ms,
    });
  }
  if (capture.over) return L.appendEvent({ ...event, kind: 'off', reason: 'output-cap' });
  const end = L.snapshot(repo);
  if (end.off || end.tree !== start.tree || end.stat !== start.stat) {
    return L.appendEvent({ ...event, kind: 'off', reason: 'tree-changed' });
  }
  const record = L.writeRecord(
    repo,
    { ...base, exit: code, ms, reusedFrom: null },
    {
      stdout: Buffer.concat(capture.out),
      stderr: Buffer.concat(capture.err),
      complete: !capture.inherit,
    },
    match.entry?.artifacts ?? [],
  );
  L.appendEvent({ ...event, kind: 'record', exit: code, ms });
  return record;
}

/**
 * Копия всего, что процесс пишет в stdout/stderr, — для повтора. Ребёнок со
 * `stdio: 'inherit'` пишет мимо нас: такой вывод неполон, и повторять его нельзя.
 */
function startCapture() {
  const { OUT_CAP } = require('./ledger.cjs');
  const capture = { out: [], err: [], size: 0, over: false, inherit: false };
  const tee = (stream, sink) => {
    const original = stream.write.bind(stream);
    stream.write = function write(chunk, encoding, cb) {
      try {
        if (!capture.over) {
          const buf = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(
                chunk instanceof Uint8Array ? chunk : String(chunk),
                typeof encoding === 'string' ? encoding : 'utf8',
              );
          capture.size += buf.length;
          if (capture.size > OUT_CAP * 2) capture.over = true;
          else sink.push(Buffer.from(buf));
        }
      } catch {
        capture.over = true;
      }
      return original(chunk, encoding, cb);
    };
  };
  tee(process.stdout, capture.out);
  tee(process.stderr, capture.err);
  watchInherit(capture);
  return capture;
}

function inherits(options, forkDefault) {
  if (!options || typeof options !== 'object') return forkDefault;
  const s = options.stdio;
  if (s === undefined) return forkDefault && !options.silent;
  if (s === 'inherit') return true;
  if (!Array.isArray(s)) return false;
  return [s[1], s[2]].some(
    (x) => x === 'inherit' || x === 1 || x === 2 || x === process.stdout || x === process.stderr,
  );
}

/**
 * Служба esbuild (её поднимает каждый vite и vitest) стартует со stderr `inherit`,
 * но пишет туда только о собственном падении — а упавший esbuild роняет и прогон.
 * Считать её «пишущей мимо» значило не повторять ни одного прогона vitest: так
 * журнал 19.10 за неделю не сэкономил ни минуты.
 */
const QUIET_CHILD = /(^|[\\/])esbuild(\.exe)?$/i;

/** Обёртка над child_process: заметить ребёнка, пишущего прямо в наш stdout. */
function watchInherit(capture) {
  const cp = require('node:child_process');
  const wrap = (name, forkDefault, stderrDefault) => {
    const original = cp[name];
    if (typeof original !== 'function') return;
    cp[name] = function patched(...args) {
      try {
        if (QUIET_CHILD.test(String(args[0] ?? ''))) return original.apply(this, args);
        const options = args.find(
          (a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a),
        );
        if (inherits(options, forkDefault) || (stderrDefault && !options?.stdio))
          capture.inherit = true;
      } catch {
        /* не узнали — считаем полным: хуже не станет, тень покажет */
      }
      return original.apply(this, args);
    };
  };
  wrap('spawn', false, false);
  wrap('spawnSync', false, false);
  wrap('fork', true, false);
  // execSync/execFileSync по умолчанию отдают stderr ребёнка прямо родителю.
  wrap('execSync', false, true);
  wrap('execFileSync', false, true);
  require('node:module').syncBuiltinESMExports();
}

/** Синхронная запись целиком: повтор идёт до main и до выхода. */
function writeAll(fd, buf) {
  const fs = require('node:fs');
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      if (e.code !== 'EAGAIN') throw e;
    }
  }
}
