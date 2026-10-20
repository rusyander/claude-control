// mustfail-graph-reporter — a vitest reporter that dumps, after ONE run, which test files reach each
// mustfail target through the module graph, and which test files failed (with their error text).
// mustfail's graph mode turns that into per-file verdicts from a single all-files-reverted run instead
// of one `vitest related {file}` spawn per file (measured: 118–177 s each, 22 files ≈ 45 min).
// The walk is the one vitest's own watcher uses to pick tests to rerun: target module → importers → …
// → a test file of this run. Env in: MUSTFAIL_TARGETS (JSON array of absolute paths), MUSTFAIL_GRAPH_OUT.
import { realpathSync, writeFileSync } from 'node:fs';

// Case folds only where the disk ignores it: on Linux `App.ts` and `app.ts` are two modules.
const caseless = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p) => {
  const slashed = String(p).replace(/\\/g, '/');
  return caseless ? slashed.toLowerCase() : slashed;
};
// git names the target by its long path, vite the module by the cwd's spelling — an 8.3 short name
// (`C:/Users/RUSYAN~1/…`) survives lower-casing, so only the OS can say both are one file.
const canon = (p) => {
  try {
    return norm(realpathSync.native(p));
  } catch {
    return norm(p);
  }
};

function environments(vitest) {
  const out = [];
  for (const p of vitest?.projects ?? []) {
    try {
      if (typeof p._getViteEnvironments === 'function') out.push(...p._getViteEnvironments());
      else for (const s of [p.vite, p.server, p.browser?.vite]) if (s?.moduleGraph) out.push(s);
    } catch {
      /* a project without a server contributes nothing */
    }
  }
  if (!out.length) for (const s of [vitest?.vite, vitest?.server]) if (s?.moduleGraph) out.push(s);
  return out;
}

function related(vitest, targets, tests) {
  const envs = environments(vitest);
  const result = {};
  for (const target of targets) {
    const hit = new Set();
    const seen = new Set();
    const queue = [];
    for (const { moduleGraph } of envs) {
      let mods = moduleGraph.getModulesByFile?.(target.replace(/\\/g, '/'));
      // Drive-letter case or an 8.3 short name between git's path and vite's: compare real paths.
      if (!mods?.size && moduleGraph.fileToModulesMap) {
        const want = canon(target);
        for (const [file, set] of moduleGraph.fileToModulesMap)
          if (norm(file) === norm(target) || canon(file) === want) mods = set;
      }
      for (const m of mods ?? []) queue.push(m);
    }
    while (queue.length) {
      const m = queue.pop();
      if (!m || seen.has(m)) continue;
      seen.add(m);
      if (m.file && tests.has(norm(m.file))) hit.add(tests.get(norm(m.file)));
      for (const i of m.importers ?? []) queue.push(i);
    }
    result[target] = [...hit];
  }
  return result;
}

const messages = (errors) =>
  (errors ?? [])
    .map((e) => `${e?.name ?? ''}: ${e?.message ?? ''}`)
    .join('\n')
    .slice(0, 4000);

export default class MustfailGraphReporter {
  onInit(vitest) {
    this.vitest = vitest;
  }

  write(entries) {
    const out = process.env.MUSTFAIL_GRAPH_OUT;
    if (!out) return;
    const targets = JSON.parse(process.env.MUSTFAIL_TARGETS || '[]');
    const tests = new Map(entries.map((e) => [norm(e.file), e.file]));
    writeFileSync(
      out,
      JSON.stringify({ tests: entries, related: related(this.vitest, targets, tests) }),
    );
  }

  // vitest ≥3: authoritative, overwrites whatever onFinished wrote.
  onTestRunEnd(modules) {
    this.done = true;
    this.write(
      modules.map((m) => {
        let text = messages(m.errors?.());
        try {
          for (const t of m.children.allTests()) text += `\n${messages(t.result()?.errors)}`;
        } catch {
          /* collection failed: the module errors above are all there is */
        }
        return { file: m.moduleId, failed: m.state() === 'failed', text: text.slice(0, 8000) };
      }),
    );
  }

  // vitest 1–2 only call this one.
  onFinished(files) {
    if (this.done) return;
    this.write(
      (files ?? []).map((f) => ({
        file: f.filepath,
        failed: f.result?.state === 'fail',
        text: messages([
          ...(f.result?.errors ?? []),
          ...collect(f).flatMap((t) => t.result?.errors ?? []),
        ]),
      })),
    );
  }
}

function collect(task) {
  return task.tasks ? task.tasks.flatMap(collect) : [task];
}
