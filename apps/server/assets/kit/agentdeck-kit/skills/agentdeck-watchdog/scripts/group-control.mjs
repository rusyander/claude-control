#!/usr/bin/env node
// Pause / resume ONE AgentDeck split group, or print its status from state.json — the token is read here and
// never printed (every output line is redacted against it). Restart / relaunch / cancel stay human-only; continue
// (a group that stopped unfinished) is an agent action in the panel since 25.10 (capability split_control).
//   node group-control.mjs pause  --group <parent>:<i> [--base http://127.0.0.1:5178] [--token-file <f>]
//        [--s1 "<reason>"] [--config-root <dir>]   refused while the group is busy (turn running, call open) unless --s1
//   node group-control.mjs resume --group <parent>:<i> [--force] [--note "<why paused>"] [--first "<do first>"]
//        the note reaches the group prompt as «Paused because: … / Do first: …» — without it the group guesses and
//        re-runs the check the pause killed (g5 25.10, N2); always pass it after a pause the watch made.
//        [--panel-repo <R>] [--answer <file>]: first runs `R/tools/tests-cli.mjs delivery --project <copy>` (read-only,
//        R = --panel-repo or --repo): gaps go into the note; a note claiming no work left is refused unless exit 0 (F1)
//   node group-control.mjs continue --group <parent>:<i>    (failed/stopped group; same hold/inbox guard as resume)
//   node group-control.mjs status --group <parent>:<i> [--app-data <dir>]
//   node group-control.mjs hold --reason "<owner's words>" [--repo <R>]   ·   release --owner "<owner's command>"
// pause STOPS the running turn (the CLI is killed) — call it at a safe point or on S1 only.
// resume is refused, with no request sent, while R/.agent/live-watch/hold.json exists or the inbox has an
// open/fixing row not named in --allow-open (misses M-12: a group resumed mid-fix). R = --repo or the cwd.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Watcher, loadState, nativePath } from '../../watchdog/scripts/lib/core.mjs';
import { discoverAppData, panelBase, panelTokenFile } from './lib/panel.mjs';

// The panel address and credential file resolve per call (lib/panel.mjs: flags, AGENTDECK_URL, PORT, the
// pre-rename credential home) — a fixed 127.0.0.1:5178 missed a panel on another port.

export function parseGroup(spec) {
  const i = String(spec ?? '').lastIndexOf(':');
  if (i <= 0) return null;
  const parent = spec.slice(0, i);
  const index = Number(spec.slice(i + 1));
  return Number.isInteger(index) && index >= 0 ? { parent, index } : null;
}
const redact = (text, token) => (token ? String(text).split(token).join('***') : String(text));

export async function control({ action, parent, index, force = false, note = '', base = panelBase(), tokenFile = panelTokenFile() }) {
  const route = { pause: 'pause', resume: 'resume-paused', continue: 'continue-group' }[action] ?? null;
  if (!route) return { code: 0, body: `unknown action ${action} — pause | resume | continue only (restart/relaunch/cancel are human-only)` };
  let token = '';
  try {
    token = fs.readFileSync(nativePath(tokenFile), 'utf8').trim();
  } catch {
    /* the panel may run without the remote gate */
  }
  const body = action === 'resume' ? { index, force, ...(note ? { note } : {}) } : { index };
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/chat/split/${encodeURIComponent(parent)}/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    return { code: res.status, body: redact(text, token).slice(0, 400) };
  } catch (e) {
    return { code: 0, body: redact(`request failed: ${e.message}`, token) };
  }
}

/** The resume note: why the group stood + the first step, in the form the panel splits on «Do first:». */
export function resumeNote(why, first) {
  const parts = [why ? String(why).trim() : '', first ? `Do first: ${String(first).trim()}` : ''].filter(Boolean);
  return parts.join(' ');
}

/**
 * A note that tells the group there is no work left (g1 audit 26.10, F1: «Do first: Confirm the MR pipeline is green
 * once and finish; nothing to edit» — the panel's delivery check then named two task rows; one wasted turn + 65 s).
 */
export const NOTHING_LEFT = /nothing (?:left )?to (?:edit|fix|change|do)|no (?:edits?|changes?|fixes?) (?:needed|required|left)|just (?:confirm|finish)/i;

/**
 * The panel's own delivery check of the group's copy, read-only, before a resume note is written (F1): the same code
 * the panel runs after the turn (`tests-cli delivery`). `null` — not run (no copy, no tests-cli in the panel repo).
 * `{ code, gaps, out }` — exit code, the `- ` gap lines, the whole output.
 */
export function deliveryPrecheck({ panelRepo, copy, configRoot, answer }) {
  const cli = path.join(panelRepo, 'tools', 'tests-cli.mjs');
  if (!copy || !fs.existsSync(cli) || !fs.existsSync(copy)) return null;
  const args = [cli, 'delivery', '--project', copy, ...(answer ? ['--answer', answer] : [])];
  const r = spawnSync(process.execPath, args, {
    cwd: copy,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
    encoding: 'utf8',
    timeout: 180_000,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const gaps = out.split('\n').filter((l) => /^- \S/.test(l)).map((l) => l.slice(2).trim());
  return { code: r.status ?? -1, gaps, out };
}

/**
 * The resume note after the precheck: gaps are appended, so the group closes them in ONE turn; a note claiming no
 * work left is refused unless the check exited 0. `{ refuse }` or `{ note, said }`.
 */
export function precheckedNote(note, check) {
  const claims = NOTHING_LEFT.test(note);
  if (!check) return claims ? { refuse: 'the note says no work is left, but the delivery check could not run (no copy or no tests-cli) — drop that claim or pass --panel-repo' } : { note, said: 'delivery precheck skipped (no copy or no tests-cli)' };
  if (check.code === 0) return { note, said: 'delivery precheck: exit 0, nothing left' };
  if (check.code !== 1 || check.gaps.length === 0) {
    const why = `delivery precheck failed to run (exit ${check.code}): ${check.out.trim().split('\n').at(-1) ?? ''}`;
    return claims ? { refuse: `${why} — the note says no work is left, which only exit 0 proves` } : { note, said: why };
  }
  const listed = check.gaps.map((g) => `- ${g}`).join('\n');
  if (claims) return { refuse: `the note says no work is left, but the panel's delivery check names ${check.gaps.length} gap(s):\n${listed}` };
  const gaps = `The panel's delivery check before this resume (tests-cli delivery, exit 1) names: ${check.gaps.join('; ')}`;
  const full = `${note ? `${note} ` : ''}${gaps.length > 1500 ? `${gaps.slice(0, 1499)}…` : gaps}`;
  return { note: full, said: `delivery precheck: ${check.gaps.length} gap(s) added to the note` };
}

const watchDir = (repo) => path.join(repo, '.agent', 'live-watch');

/** Why resume must not run now, or null. Read before any request, so a refusal costs nothing. */
export function resumeBlock(repo, allowOpen = []) {
  const hold = path.join(watchDir(repo), 'hold.json');
  if (fs.existsSync(hold)) {
    const h = JSON.parse(fs.readFileSync(hold, 'utf8'));
    return `HOLD since ${h.at}: ${h.reason} — groups start on the owner's command only; then: release --owner "<the owner's words>"`;
  }
  let inbox = '';
  try {
    inbox = fs.readFileSync(path.join(watchDir(repo), 'inbox.agent.md'), 'utf8');
  } catch {
    /* no watch log in this repo */
  }
  const open = [...inbox.matchAll(/^- (I-\d+) · [^·\n]+ · (?:open|fixing) ·/gm)].map((m) => m[1]).filter((id) => !allowOpen.includes(id));
  return open.length ? `open inbox rows ${open.join(', ')} — finish them, or name each one that cannot touch this group: --allow-open ${open.join(',')}` : null;
}

export function setHold(repo, reason) {
  fs.mkdirSync(watchDir(repo), { recursive: true });
  fs.writeFileSync(path.join(watchDir(repo), 'hold.json'), `${JSON.stringify({ at: new Date().toISOString(), reason })}\n`);
}

export function releaseHold(repo) {
  const hold = path.join(watchDir(repo), 'hold.json');
  const was = fs.existsSync(hold);
  fs.rmSync(hold, { force: true });
  return was;
}

export function readGroup(appData, parent, index) {
  const s = JSON.parse(fs.readFileSync(path.join(appData, 'state.json'), 'utf8'));
  const plans = s.splitPlans ?? {};
  const key = plans[parent] ? parent : Object.keys(plans).find((k) => parent.length >= 8 && k.startsWith(parent));
  const plan = key ? plans[key] : null;
  const group = plan?.groups?.find((g) => g.index === index) ?? null;
  return { s, key, plan, group };
}

/**
 * Why the group is busy right now (its turn runs, a call / bg task / subagent is open), or null when it is at a
 * safe point or cannot be judged (no state.json, no such group, no transcript). Read from the copy's transcripts
 * the way the watch reads them: a pause mid-turn kills the in-flight call (g5 25.10: paused mid-turn by hand).
 */
export function busyOf(appData, g, opts = {}) {
  let group;
  try {
    ({ group } = readGroup(appData, g.parent, g.index));
  } catch {
    return null;
  }
  if (!group?.path) return null;
  const s = loadState(path.join(os.tmpdir(), `agentdeck-busy-${process.pid}-none`));
  s.units.g = { kind: 'cwd', target: group.path };
  const w = new Watcher(s, { ...opts, from: 'end' });
  w.pass(new Set(['g']));
  const st = w.status('g');
  return st.safe === false ? st.reasons.join('; ') || 'turn running' : null;
}

async function main(argv) {
  const action = argv[0];
  const val = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const repo = path.resolve(nativePath(val('repo') ?? '') || process.cwd());
  if (action === 'hold' || action === 'release') {
    const words = val(action === 'hold' ? 'reason' : 'owner');
    if (!words) {
      console.log(`usage: group-control.mjs ${action} ${action === 'hold' ? '--reason "<owner\'s words>"' : '--owner "<owner\'s command>"'} [--repo R]`);
      return 2;
    }
    if (action === 'hold') {
      setHold(repo, words);
      console.log(`HOLD set: ${words}`);
    } else console.log(releaseHold(repo) ? `released by the owner: ${words}` : 'no hold was set');
    return 0;
  }
  const g = parseGroup(val('group'));
  if (!['pause', 'resume', 'continue', 'status'].includes(action) || !g) {
    console.log('usage: group-control.mjs pause|resume|continue|status --group <parent>:<index> [--force] [--base url] [--token-file f] [--app-data dir]');
    return 2;
  }
  const configRoot = nativePath(val('config-root') ?? '') || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const base = panelBase({ base: val('base') });
  const tokenFile = panelTokenFile({ 'token-file': val('token-file') });
  // --app-data, else --config-root/agentdeck, else the panel's own answer, else the stock dir (lib/panel.mjs).
  const appData = (await discoverAppData({ 'app-data': val('app-data'), 'config-root': val('config-root'), base, 'token-file': tokenFile })).dir;
  if (action === 'status') {
    const { key, group } = readGroup(appData, g.parent, g.index);
    if (!group) {
      console.log(`no group ${g.index} under split ${g.parent} in ${appData}/state.json`);
      return 2;
    }
    const st = group.stageTrace?.at(-1)?.stage ?? '?';
    console.log(`${key}:${g.index} ${group.status}${group.waitingFor ? `(${group.waitingFor})` : ''} · stage ${st} · nudges ${group.deliveryNudges ?? 0} · missing ${group.deliveryMissing?.length ?? 0} · mr ${group.mr ?? '-'} · chat ${group.chatId ?? '-'} · copy ${group.path ?? '-'}`);
    return 0;
  }
  // continue starts the group like resume does: the same mid-fix guard (M-12).
  if (action === 'resume' || action === 'continue') {
    const block = resumeBlock(repo, String(val('allow-open') ?? '').split(',').filter(Boolean));
    if (block) {
      console.log(`REFUSED ${block}`);
      return 1;
    }
  }
  // A pause kills the running turn: a busy group is paused by hand only on S1, named in --s1; otherwise the watch
  // pauses it at its next safe point.
  if (action === 'pause' && !val('s1')) {
    const busy = busyOf(appData, g, { 'config-root': configRoot });
    if (busy) {
      const WATCH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'watch-groups.mjs').replace(/\\/g, '/');
      console.log(`REFUSED busy: ${busy} — a pause now kills the in-flight call; on S1 only, say why: --s1 "<reason>"; otherwise node ${WATCH} --state <dir> --pause-at-safe ${g.parent}:${g.index}`);
      return 1;
    }
  }
  // 25.10: status resolved the short split id, pause/resume sent it raw → 409 «не на паузе» on a paused group.
  let parent = g.parent;
  try {
    parent = readGroup(appData, g.parent, g.index).key ?? g.parent;
  } catch {
    /* no state.json here (remote panel): the id goes as given */
  }
  let note = resumeNote(val('note'), val('first'));
  // F1 (g1 26.10): the panel's delivery check runs before the note is sent — its gaps go into the note (one turn,
  // not two), and a note claiming no work left goes only with exit 0. Refused here, no request sent.
  if (action === 'resume') {
    let copy = null;
    try {
      copy = readGroup(appData, g.parent, g.index).group?.path ?? null;
    } catch {
      /* no state.json here (remote panel): no copy to check */
    }
    const panelRepo = path.resolve(nativePath(val('panel-repo') ?? '') || repo);
    const checked = precheckedNote(note, deliveryPrecheck({ panelRepo, copy, configRoot, answer: val('answer') }));
    if (checked.refuse) {
      console.log(`REFUSED ${checked.refuse}`);
      return 1;
    }
    console.log(checked.said);
    note = checked.note;
  }
  const r = await control({ action, parent, index: g.index, force: argv.includes('--force'), note, base, tokenFile });
  console.log(`HTTP ${r.code} ${r.body}`);
  return r.code >= 200 && r.code < 300 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
