// Push sieves (PreToolUse on the agent's Bash/PowerShell tool — NOT a git `pre-push` hook: a push from
// a terminal, an IDE or the panel's server never passes here): before `git push`, `gh pr create|new`
// or `glab mr create|new` the branch is checked against a FRESHLY fetched main, by git alone — no
// model, no report to trust. "Main" is the MR's target when one is named (`--base` / `--target-branch`,
// or the `gh-merge-base` gh remembered for the branch). Ported from agentdeck's
// `project-git/sieve-facts.ts`, not imported: hooks are plain node with no build
// step and no dependency on any one project.
//
// 1. Conflict: `git merge-tree --write-tree <main> <branch>` — writes objects only, never the work
//    tree or a ref. Exit 1 = conflicts → deny with the file list. Only `# sieve-ack: conflict` opens
//    it: publishing a branch that does not merge is a deliberate act (a backup, a forge-UI resolve).
// 2. Foreign removal: lines the branch deletes that reached main AFTER the task began — someone
//    else's work, typically lost to a rebase or to a file rewritten from a stale copy (the failure
//    the parallel split runs kept producing). Blame at the merge-base; a blamed commit that is not
//    an ancestor of main-as-of-task-start is foreign. Deleting code that predates the task is an
//    ordinary edit and never flagged. Deny unless the command names EVERY flagged file on a
//    `# sieve-ack: <file> …` comment line — a deliberate removal costs one visible line, not a
//    conversation.
//
// 3. Content (push-sieves-scan.mjs, from the panel's `sieve-scan.ts`): secrets, debug leftovers,
//    committed artifacts, manifest without its lockfile, env vars nothing declares, removed names
//    still referenced — deny unless every flagged item is named on `# sieve-ack:`. Code with no
//    test, destructive migration, high-risk paths — notes in context only.
//
// Task start = the earlier of the session's first transcript timestamp and the oldest author date
// on the branch (author dates survive a rebase; a task continued after /clear still has its commits).
// Main-at-start is the OLDEST of: the branch's creation point (its reflog), the tracking ref's reflog
// at that time, and main's last commit dated before it — see `mainAtStart`.
//
// Network: exactly one `git fetch` of the main branch, `--no-tags --no-write-fetch-head`, bounded
// by a timeout. Everything else is local. Fetch failed → sieve against the local tracking ref and
// say so. Anything that cannot be checked (git < 2.38 has no `merge-tree --write-tree`, no remote,
// no main, unrelated histories, time budget) fails OPEN with a one-line note in context — a sieve
// that blocks on its own blindness would be switched off within a day.
//
// Cost when the command is not a publish: one regex over the raw command, no process spawned.
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { executedText, commandText } from './shell-text.mjs';
import { gitCall, repoAt, shellWords, slash } from './split-worktree.mjs';
import { deny } from './transcript.mjs';
import { scanBranch } from './push-sieves-scan.mjs';

// `new` is the documented alias of `create` in both CLIs.
const TRIGGER = /\bpush\b|\b(?:pr|mr)\s+(?:create|new)\b/;
const PUBLISH_CLI = /\b(gh\s+pr|glab\s+mr)\s+(create|new)\b/g;
const GIT_WORD = /\bgit\b/g;
const MIN_GIT = [2, 38];
const BUDGET_MS = 40000;
const FETCH_MS = 20000;
const READ_MS = 10000;
const REFS_MAX = 3;
const FILES_MAX = 60;
const LIST_MAX = 12;
const ACK = /(?:^|\s)#\s*sieve-ack:\s*([^\n]*)/g;

let pending = null;
/** The fail-open note of the last run (null when all checks ran) — the dispatcher puts it in context. */
export function takeNote() {
  const n = pending;
  pending = null;
  return n;
}

/** `git version 2.55.0.windows.3` → true when older than 2.38; unparseable → false (merge-tree reports). */
export function gitTooOld(versionText) {
  const m = String(versionText ?? '').match(/(\d+)\.(\d+)/);
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj < MIN_GIT[0] || (maj === MIN_GIT[0] && min < MIN_GIT[1]);
}

/** Files named on `# sieve-ack:` comment lines of the raw command. */
export function ackedFiles(raw) {
  const out = new Set();
  for (const m of String(raw ?? '').matchAll(ACK)) {
    for (const f of m[1].split(/[\s,]+/)) if (f) out.add(slash(f).replace(/^\.\//, ''));
  }
  return out;
}

/** `git diff -U0` → removed hunks `{path, start, count}` (line numbers on the old side). */
export function removedHunks(diff) {
  const out = [];
  let file = null;
  let header = false;
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('diff --git ')) {
      header = true;
      file = null;
      continue;
    }
    // `--- ` names the file only in the header: inside a hunk it is a removed line whose text starts
    // with `-- ` (an SQL/Lua comment), and reading it as a header lost every later hunk of the file.
    if (header && line.startsWith('--- ')) {
      const name = line.slice(4).trim();
      file = name === '/dev/null' ? null : name.replace(/^a\//, '');
      continue;
    }
    if (line.startsWith('@@')) header = false;
    const head = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (head && file) {
      const count = head[2] === undefined ? 1 : Number(head[2]);
      if (count > 0) out.push({ path: file, start: Number(head[1]), count });
    }
  }
  return out;
}

const PUSH_VALUE_OPTS = /^(?:-o|--push-option|--repo|--receive-pack|--exec)$/;
const PUSH_DELETE = /^(?:--delete|-d)$/;

/** What a `git push` publishes: `{remote, refs}`; refs `[]` = nothing to sieve (delete, tags only). */
export function pushSources(args) {
  const cut = args.findIndex((a) => a.startsWith('#'));
  const words = cut >= 0 ? args.slice(0, cut) : args;
  const pos = [];
  let tagsOnly = false;
  for (let i = 0; i < words.length; i++) {
    const a = words[i];
    if (PUSH_VALUE_OPTS.test(a)) i++;
    else if (PUSH_DELETE.test(a)) return { remote: null, refs: [] };
    else if (a === '--tags') tagsOnly = true;
    else if (!a.startsWith('-')) pos.push(a);
  }
  const specs = pos.slice(1);
  if (!specs.length) return { remote: pos[0] ?? null, refs: tagsOnly ? [] : ['HEAD'] };
  const refs = [];
  for (const spec of specs) {
    const src = spec.replace(/^\+/, '').split(':')[0];
    if (!src) continue; // `:branch` deletes it
    refs.push(src === 'HEAD' || src === '@' ? 'HEAD' : src.replace(/^refs\/heads\//, ''));
  }
  return { remote: pos[0] ?? null, refs };
}

const CD =
  /(?:^|[;&|(\n]\s*)(?:cd|pushd|Set-Location)\s+("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|()"']+)/g;
/** Directory a command starting at `at` runs in: session cwd, then every `cd` before it. */
function dirAt(text, at, cwd) {
  let dir = slash(cwd || process.cwd());
  for (const m of text.slice(0, at).matchAll(CD)) {
    const w = shellWords(m[1])[0];
    if (!w || /[$`]/.test(w)) return null;
    dir = slash(path.resolve(dir, slash(w)));
  }
  return dir;
}

/** `--flag value` or `--flag=value` among `words`, for any of `names`. */
function optValue(words, names) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (names.includes(w)) return words[i + 1] ?? null;
    const eq = w.indexOf('=');
    if (eq > 0 && names.includes(w.slice(0, eq))) return w.slice(eq + 1) || null;
  }
  return null;
}
// Per CLI: which flag names the source branch and which the target. gh `-b` is `--body` and glab
// `-H` is `--head` (a repository), so the two tables must not be merged.
const CLI_FLAGS = {
  gh: { source: ['--head', '-H'], target: ['--base', '-B'] },
  glab: { source: ['--source-branch', '-s'], target: ['--target-branch', '-b'] },
};

/** Every publish in the command: `{dir, remote, ref, target, label}`; target null = main. */
export function publishTargets(raw, cwd) {
  const executed = executedText(raw, { code: 'spawn' });
  const original = commandText(raw);
  const out = [];
  for (const m of executed.matchAll(GIT_WORD)) {
    let call = null;
    try {
      call = gitCall(original, m.index, cwd);
    } catch {
      /* unparseable → not ours to judge */
    }
    if (call?.sub !== 'push' || !call.dir) continue;
    const { remote, refs } = pushSources(call.args);
    for (const ref of refs)
      out.push({
        dir: call.dir,
        remote,
        ref,
        target: null,
        label: ['git push', remote, ref === 'HEAD' ? null : ref].filter(Boolean).join(' '),
      });
  }
  for (const m of executed.matchAll(PUBLISH_CLI)) {
    const dir = dirAt(original, m.index, cwd);
    if (!dir) continue;
    const words = shellWords(original.slice(m.index).match(/^[^\n|;&)]*/)[0]);
    const flags = CLI_FLAGS[m[1].startsWith('gh') ? 'gh' : 'glab'];
    const ref = optValue(words, flags.source) || 'HEAD';
    const target = optValue(words, flags.target);
    out.push({
      dir,
      remote: null,
      ref,
      target,
      label: `${m[1].replace(/\s+/, ' ')} ${m[2]}${target ? ` → ${target}` : ''}`,
    });
  }
  return out;
}

// --- git ------------------------------------------------------------------------------------------

const LONG = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
const GIT_ENV = (() => {
  const e = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete e[k];
  return e;
})();
function runner(deadline) {
  return (cwd, args, timeout = READ_MS) => {
    const left = deadline - Date.now();
    if (left <= 0) return { code: -2, stdout: '', stderr: 'time budget spent' };
    const r = spawnSync('git', [...LONG, '-c', 'core.quotePath=false', ...args], {
      cwd,
      env: GIT_ENV,
      encoding: 'utf8',
      timeout: Math.min(timeout, left),
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error)
      return {
        code: -1,
        stdout: '',
        stderr: r.error.code === 'ETIMEDOUT' ? 'timed out' : String(r.error.message),
      };
    return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
}

/** The line of git's stderr that names the failure (`fatal:`/`error:`), else its first line. */
const firstLine = (s) => {
  const lines = String(s)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines.find((l) => /^(?:fatal|error):/.test(l)) ?? lines[0] ?? '').slice(0, 160);
};

/**
 * Fresh `refs/remotes/<remote>/<target>`. No target: the remote HEAD pointer, then main, then master.
 * A named target (a stacked MR, a release branch) is the only candidate — main is irrelevant to it.
 */
function freshMain(git, cwd, remote, target) {
  const sym = target
    ? ''
    : git(cwd, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]).stdout.trim();
  const names = target
    ? [target]
    : [
        ...new Set([
          sym.startsWith(`${remote}/`) ? sym.slice(remote.length + 1) : '',
          'main',
          'master',
        ]),
      ].filter(Boolean);
  const local = names.find(
    (n) =>
      git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${n}^{commit}`])
        .code === 0,
  );
  const order = local ? [local, ...names.filter((n) => n !== local)] : names;
  let why = '';
  for (const n of order) {
    const ref = `refs/remotes/${remote}/${n}`;
    const f = git(
      cwd,
      [
        '-c',
        'gc.auto=0',
        '-c',
        'maintenance.auto=false',
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        remote,
        `+refs/heads/${n}:${ref}`,
      ],
      FETCH_MS,
    );
    if (f.code === 0) return { ref, short: `${remote}/${n}`, fresh: true };
    why = firstLine(f.stderr) || `fetch exit ${f.code}`;
    if (!/couldn't find remote ref|no such ref|not our ref/i.test(f.stderr)) break; // network/auth: one try
  }
  if (local)
    return {
      ref: `refs/remotes/${remote}/${local}`,
      short: `${remote}/${local}`,
      fresh: false,
      why,
    };
  return {
    why: why || (target ? `no \`${target}\` on the remote` : 'no main/master on the remote'),
  };
}

/** First timestamp of the session transcript, as ms — the session's start. */
function sessionStart(transcriptPath) {
  if (!transcriptPath) return null;
  let fd = null;
  try {
    fd = openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const m = buf.toString('utf8', 0, n).match(/"timestamp"\s*:\s*"([^"]+)"/);
    const t = m ? Date.parse(m[1]) : NaN;
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** One branch against fresh main → `{conflicts, foreign, notes, main, since, startSha}`. */
function sieve(git, t, input) {
  const res = { conflicts: [], foreign: [], notes: [], label: t.label };
  const cwd = t.dir;
  const remotes = git(cwd, ['remote'])
    .stdout.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!remotes.length) return (res.notes.push('no git remote — nothing to fetch main from'), res);
  const remote =
    t.remote && remotes.includes(t.remote)
      ? t.remote
      : remotes.includes('origin')
        ? 'origin'
        : remotes.sort()[0];
  const ref = t.ref === 'HEAD' ? 'HEAD' : `refs/heads/${t.ref}`;
  if (git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).code !== 0) {
    return (res.notes.push(`\`${t.ref}\` is not a local branch — not sieved`), res);
  }
  // The MR's target: named on the command, else the one `gh pr create --base` remembered for the branch.
  const branch =
    t.ref === 'HEAD'
      ? git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim()
      : t.ref;
  const target =
    t.target ||
    (branch ? git(cwd, ['config', '--get', `branch.${branch}.gh-merge-base`]).stdout.trim() : '') ||
    null;
  const main = freshMain(git, cwd, remote, target);
  if (!main.ref)
    return (
      res.notes.push(
        `${target ? `target \`${target}\`` : 'main'} of \`${remote}\` unavailable (${main.why})`,
      ),
      res
    );
  res.mainShort = main.short;
  res.main = main.fresh
    ? `freshly fetched ${main.short}`
    : `${main.short} (local copy, fetch failed)`;
  if (!main.fresh)
    res.notes.push(`fetch of ${main.short} failed (${main.why}); sieved against the local copy`);

  const tree = git(cwd, [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '--no-messages',
    main.ref,
    ref,
  ]);
  if (tree.code === 1)
    res.conflicts = [
      ...new Set(
        tree.stdout
          .split('\n')
          .slice(1)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
  else if (tree.code !== 0)
    res.notes.push(`merge-tree failed: ${firstLine(tree.stderr) || 'exit ' + tree.code}`);

  const base = git(cwd, ['merge-base', main.ref, ref]).stdout.trim();
  if (!base) return (res.notes.push('no merge-base with main — foreign removals not checked'), res);
  res.scan = { cwd, base, ref };
  const authored = git(cwd, ['log', '--format=%at', `${base}..${ref}`])
    .stdout.split('\n')
    .map(Number)
    .filter((n) => n > 0);
  const starts = [
    sessionStart(input?.transcript_path),
    authored.length ? Math.min(...authored) * 1000 : null,
  ].filter(Boolean);
  if (!authored.length) return res; // nothing of its own on the branch, nothing it could remove
  const since = new Date(Math.min(...starts)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  res.since = since;
  const startSha = mainAtStart(git, cwd, main.ref, branch, since);
  if (!startSha)
    return (
      res.notes.push(
        `main has no commit before the task start ${since} — foreign removals not checked`,
      ),
      res
    );
  res.startSha = startSha.slice(0, 10);
  // The fork is no newer than main-at-start: nothing landed under the branch since, nothing foreign.
  if (git(cwd, ['merge-base', '--is-ancestor', base, startSha]).code === 0) return res;
  const late = new Set(
    git(cwd, ['rev-list', `${startSha}..${base}`])
      .stdout.split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (!late.size) return res;

  const byFile = new Map();
  // `-M`: a moved file loses no line; with renames off a pure `git mv` read as a whole-file removal.
  for (const h of removedHunks(
    git(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', '-M', base, ref]).stdout,
  )) {
    if (!byFile.has(h.path)) byFile.set(h.path, []);
    byFile.get(h.path).push(h);
  }
  let seen = 0;
  const unblamed = [];
  for (const [file, hunks] of byFile) {
    if (++seen > FILES_MAX) {
      res.notes.push(`only the first ${FILES_MAX} files with removals were blamed`);
      break;
    }
    const ranges = hunks.flatMap((h) => ['-L', `${h.start},+${h.count}`]);
    // `--no-ignore-revs-file`: a configured ignore list re-attributes lines to OLDER commits — exactly
    // what hides a late one — and a list file this repo lacks fails every blame (no `-c` resets it).
    const blame = git(cwd, [
      'blame',
      '--porcelain',
      '--no-ignore-revs-file',
      ...ranges,
      base,
      '--',
      file,
    ]);
    if (blame.code !== 0) {
      if (blame.code === -2)
        return (res.notes.push('time budget spent — foreign removals partly checked'), res);
      unblamed.push({ file, why: firstLine(blame.stderr) || `exit ${blame.code}` });
      continue;
    }
    for (const m of blame.stdout.matchAll(/^([0-9a-f]{40}) \d+ \d+/gm)) {
      if (late.has(m[1])) {
        res.foreign.push(file);
        break;
      }
    }
  }
  if (unblamed.length) {
    // Blame is blind here; the file history still says whether a late commit touched it at all.
    const touched = unblamed.filter((u) =>
      git(cwd, ['rev-list', '-1', `${startSha}..${base}`, '--', u.file]).stdout.trim(),
    );
    res.notes.push(
      `blame failed (${unblamed[0].why}) — not checked: ${list(unblamed.map((u) => u.file))}` +
        (touched.length
          ? `; touched by a commit that landed after the task began, so a foreign removal is possible: ${list(touched.map((u) => u.file))}`
          : ''),
    );
  }
  return res;
}

/**
 * Main as the task knew it — the OLDEST of what the repository recorded, never a commit date alone.
 * A colleague's commit made before the task and fast-forwarded to main after it keeps its old date, so
 * the date walk put it inside "main at start" and let its removal through. The branch reflog's
 * creation entry is the copy the work was actually cut from (a days-stale local main included); the
 * tracking ref's reflog is what the last fetch before the task had seen; the date walk is the fallback.
 */
function mainAtStart(git, cwd, mainRef, branch, since) {
  const found = [];
  const byDate = git(cwd, [
    'rev-list',
    '-1',
    '--first-parent',
    `--before=${since}`,
    mainRef,
  ]).stdout.trim();
  if (byDate) found.push(byDate);
  // Past its oldest entry git answers `@{date}` with that entry and a warning — too new, so it is dropped.
  const seen = git(cwd, ['rev-parse', '--verify', '--quiet', `${mainRef}@{${since}}`]);
  if (seen.code === 0 && seen.stdout.trim() && !/only goes back/i.test(seen.stderr))
    found.push(seen.stdout.trim());
  if (branch) {
    const log = git(cwd, ['reflog', 'show', '--format=%H %gs', `refs/heads/${branch}`, '--'])
      .stdout.trim()
      .split('\n');
    const created = /^([0-9a-f]{40}) branch: Created from /.exec(log[log.length - 1] ?? '');
    const fork = created && git(cwd, ['merge-base', created[1], mainRef]).stdout.trim();
    if (fork) found.push(fork);
  }
  if (found.length < 2) return found[0] ?? '';
  return git(cwd, ['merge-base', '--octopus', ...found]).stdout.trim() || byDate;
}

const list = (files) =>
  files.slice(0, LIST_MAX).join(', ') +
  (files.length > LIST_MAX ? ` (+${files.length - LIST_MAX} more)` : '');

export default function pushSieves(input) {
  pending = null;
  const raw = input?.tool_input?.command;
  if (typeof raw !== 'string' || !TRIGGER.test(raw)) return null;
  const seen = new Set();
  const targets = publishTargets(raw, input?.cwd).filter((t) => {
    const root = repoAt(t.dir)?.root;
    if (!root) return false;
    const key = `${root.toLowerCase()}|${t.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!targets.length) return null;

  const git = runner(Date.now() + BUDGET_MS);
  const version = git(targets[0].dir, ['--version']);
  if (version.code !== 0 || gitTooOld(version.stdout)) {
    pending = `[push-sieves] not checked: ${version.code !== 0 ? 'git did not run' : `${version.stdout.trim()} is older than 2.38 (no merge-tree --write-tree)`} — the push goes ahead unsieved.`;
    return null;
  }

  const acked = ackedFiles(raw);
  const results = targets.slice(0, REFS_MAX).map((t) => sieve(git, t, input));
  const conflicts = results.filter((r) => r.conflicts.length);
  if (conflicts.length && !acked.has('conflict')) {
    return deny(
      'push-sieves(conflict) ' +
        conflicts
          .map(
            (r) =>
              `\`${r.label}\` does not merge cleanly into ${r.main} (git merge-tree): ${list(r.conflicts)}.`,
          )
          .join(' ') +
        ' Bring the target in and resolve the conflicts before publishing. Not the MR target? Name it (`--base`/`--target-branch`). ' +
        'Publishing the conflict on purpose (a backup push, resolving in the forge UI): add a comment line `# sieve-ack: conflict` and run it again.',
    );
  }
  const foreign = results
    .map((r) => ({ ...r, open: r.foreign.filter((f) => !acked.has(f)) }))
    .filter((r) => r.open.length);
  if (foreign.length) {
    const r0 = foreign[0];
    return deny(
      'push-sieves(foreign-removal) ' +
        foreign
          .map(
            (r) =>
              `\`${r.label}\` deletes lines that reached ${r.main} after this task began (${r.since}) — someone else's work: ${list(r.open)}.`,
          )
          .join(' ') +
        ` Usually lost to a rebase or a file rewritten from a stale copy; \`git log -p ${r0.startSha}..${r0.mainShort} -- <file>\` shows what landed. Restore what was not yours to remove. ` +
        'A removal that IS intended: name every such file on a comment line of the command, `# sieve-ack: <file> <file>`, and run it again.',
    );
  }
  // 3. Content sieves over what the branch adds (push-sieves-scan.mjs). A thrown scan is a note, never a deny.
  const blocked = [];
  const advisories = [];
  for (const r of results) {
    if (!r.scan) continue;
    let scan;
    try {
      scan = scanBranch(git, r.scan);
    } catch (e) {
      r.notes.push(`content sieves failed (${String(e?.message ?? e).slice(0, 80)})`);
      continue;
    }
    r.notes.push(...scan.notes);
    advisories.push(...scan.advisories.map((a) => `${r.label}: ${a}`));
    for (const b of scan.blocks) {
      const open = b.items.filter((i) => !acked.has(i));
      if (open.length) blocked.push({ label: r.label, ...b, open });
    }
  }
  if (blocked.length) {
    return deny(
      `push-sieves(${[...new Set(blocked.map((b) => b.id))].join(',')}) ` +
        blocked
          .map((b) => `\`${b.label}\` ${b.id}: ${list(b.shown ?? b.open)} — ${b.why}.`)
          .join(' ') +
        ' Fix it in a commit and publish again. Flagged on purpose (a fake fixture, a deliberate file): name every flagged file or name on a comment line, `# sieve-ack: <item> <item>`, and run it again.',
    );
  }
  const notes = results.flatMap((r) => r.notes.map((n) => `${r.label}: ${n}`));
  if (targets.length > REFS_MAX)
    notes.push(`only the first ${REFS_MAX} pushed branches were sieved`);
  const parts = [];
  if (advisories.length)
    parts.push(`[push-sieves] not blocking, answer each in the MR — ${advisories.join('; ')}.`);
  if (notes.length)
    parts.push(
      `[push-sieves] unchecked — ${notes.join('; ')}. The publish is not blocked for that.`,
    );
  if (parts.length) pending = parts.join(' ');
  return null;
}
