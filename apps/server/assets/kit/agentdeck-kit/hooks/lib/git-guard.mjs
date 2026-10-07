// Git guard (PreToolUse on Bash/PowerShell): a mutating git command runs only when the user's own
// words authorise it. Read-only git (status/diff/log/show) passes untouched.
//
// Verdict is `deny`, never `ask` — `ask` is dropped in permissive session modes, which made this
// guard a no-op precisely when nobody was watching. How consent is obtained instead: see
// `consent.mjs` (door A = the user named the op this turn, door B = the user replied after our
// refusal). Reasons are English: a deny reason is read by the model, not by the user.
//
// `tag\s+\S` was dead: the group's trailing \b demands a word boundary right after that ONE
// character, so only a single-letter tag name ever matched and `git tag v1.2.0` walked through.
// \S+ is greedy and backtracks to end on a word character, so quoted names still match.
// Bare `git tag` and `git tag -l/--list` are reads and stay free.
//
// Door C — the ticket grant. Handing a ticket to the `agentdeck-kit:ticket-delivery` conveyor
// authorises the git ops it runs by itself: branch, commit, push, and the rebase that clears a
// conflict. Without it the flow the user asked to be autonomous stops for a permission question at
// every stage, which is the one thing it exists to avoid.
// Narrow on three axes at once, because a standing grant is exactly the kind of rule that rots:
// THIS session must write an open run ledger (`.agent/tickets/<KEY>.agent.md`, see ticket-run.mjs),
// the USER'S OWN words in this window must carry that key (a compaction that erased them leaves the
// ledger alone as the record), and only ops that stay inside the feature branch qualify.
// Merge, force-push, branch deletion, reset --hard, tag and stash drop keep their old doors.
// A push whose destination is main/master never rides Door C, whatever its source.
//
// Door C′ — the split branch (live split run). The agentdeck panel's split runs each group in
// `<repo>-worktrees/<dir>` on a branch named after its tickets; resumes, stage prompts, compactions
// and card answers carry no ticket key, so a words-based grant kept dropping and every group stopped
// on a card for its OWN branch. The checked-out branch is the grant (`split-worktree.mjs`):
// commit, cherry-pick, rebase that stays on it, and a push — `--force-with-lease` included — whose
// every destination is that branch. `--force`/`-f`/`+refspec`, wide pushes (--all/--mirror/--delete),
// another branch, `-C`/`cd` into another repo or another group's worktree (the grant is bound to
// the session's own cwd): the ordinary doors.
//
// Attribution trailers: the harness asks for `Co-Authored-By` / "Generated with Claude
// Code", the published-text rule forbids both, and that rule is delivered only WITH the commit call —
// too late, the message is written. A commit / PR command carrying one is refused before any door.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { consentGate, ASK_THE_USER } from './consent.mjs';
import { readTail, sinceLastCompact, currentUserPrompt, userSpeech, deny } from './transcript.mjs';
import { executedText, commandText } from './shell-text.mjs';
import { liveTicketRuns, branchLedgers } from './ticket-run.mjs';
import {
  gitCall,
  ownSplitAt,
  repoAt,
  pushTargets,
  rebaseStaysOn,
  pullStaysOn,
  isProtectedBranch,
  slash,
} from './split-worktree.mjs';

// `stash push` saves work, it publishes nothing (5 denials in a replay of retained refusals).
// `merge --abort/--quit` backs out of a conflicted merge — the opposite of merging.
const MUTATING_GIT =
  /\bgit\b[^\n|;&]*\b(commit|(?<!stash\s+)push|rebase|merge(?!-(?:base|tree|file)\b)(?!\s+--(?:abort|quit)\b)|cherry-pick|revert|reset\s+--hard|checkout\s+-b|switch\s+-c|branch\s+-(D|d|m)|tag\s+(?!-l\b|--list\b)\S+|stash\s+(drop|clear|pop)|filter-branch)\b/;

// "all git operations are allowed" — the user naming git ops as a class, this turn.
// Covers only ops that stay recoverable inside a branch; merge, force-push, reset --hard, branch
// deletion, tag and stash drop/pop keep their own doors.
const GIT_CLASS =
  /(?<![а-яё])(?:гит|git)[\s-]*(?:операц|команд|действ)[а-яё]*|\bgit\s+(?:ops|operations|commands)\b/i;
const CLASS_OPS = new Set([
  'commit',
  'push',
  'rebase',
  'checkout',
  'switch',
  'cherry-pick',
  'revert',
]);
const withClass = (intent) => new RegExp(`${intent.source}|${GIT_CLASS.source}`, 'i');

// `--force-with-lease` refuses to clobber work it has not seen, so it stays an ordinary push;
// `--force-if-includes` (git's recommended companion) only narrows it further.
const FORCE_PUSH = /--force(?!-with-lease|-if-includes)\b|(?<![\w-])-f(?![\w-])/;

const BRANCH_INTENT = /(?<![а-яё])(?:ветк|бранч|переключ)[а-яё]*|\b(?:branch|checkout|switch)\b/i;

// One entry per operation class. `reconfirm` = door A is closed: the op is irreversible on state
// other people share, so even a direct request costs one explicit answer. `forbidden` = no door.
// Users dictate by voice, so door A hears a transcriber's misspellings of commit/push too (Russian
// forms below) — each was missed at least once in a replay.
const OPS = {
  commit: {
    intent: /(?<![а-яё])(?:за)?к[оа]мм?[иеэ][тч][а-яё]*|(?<![а-яё])зафиксир[а-яё]*|\bcomm?it\b/i,
    why: 'creates a commit',
  },
  // "force-with-lease" names a push on its own: the card option "Rebase + force-with-lease
  // (Recommended)" opened the rebase and left the push shut.
  push: {
    intent:
      /(?<![а-яё])(?:за)?пуш[а-яё]*|(?<![а-яё])пошь?(?![а-яё])|\bpush\b|\bforce[\s-]?with[\s-]?lease\b/i,
    why: 'publishes commits to a remote',
  },
  rebase: {
    intent: /(?<![а-яё])(?:реб[еэ]йз|перебаз)[а-яё]*|\brebase\b/i,
    why: 'rewrites local history',
  },
  merge: {
    forbidden: true,
    why: 'merges branches — merging is forbidden outright (kit safety rule). No answer opens this gate: tell the user the merge is theirs to run',
  },
  'cherry-pick': {
    intent: /(?<![а-яё])черри[а-яё-]*|\bcherry[\s-]?pick\b/i,
    why: 'copies a commit onto this branch',
  },
  revert: {
    intent: /(?<![а-яё])(?:откат|отмен|реверт)[а-яё]*|\brevert\b/i,
    why: 'creates an undo commit',
  },
  reset: {
    intent: /(?<![а-яё])(?:сброс|откат|ресет)[а-яё]*|\breset\b/i,
    why: 'reset --hard discards uncommitted work irrecoverably',
  },
  checkout: { intent: BRANCH_INTENT, why: 'creates a branch' },
  switch: { intent: BRANCH_INTENT, why: 'creates a branch' },
  branch: { intent: BRANCH_INTENT, why: 'deletes or renames a branch' },
  tag: { intent: /(?<![а-яё])т[еэ]г[а-яё]*|\btag\b/i, why: 'creates a tag' },
  stash: {
    intent: /(?<![а-яё])(?:ст[еэ]ш|заначк)[а-яё]*|\bstash\b/i,
    why: 'drops or pops stashed work',
  },
  'filter-branch': {
    reconfirm: true,
    asked: /filter-branch|(?<![а-яё])перепис[а-яё]*\s+истори[а-яё]*/i,
    why: 'rewrites the whole repository history',
  },
};
/** Door B′/D for a force push: my question must have said "force", not merely "push". */
const FORCE_ASKED = /(?<![а-яё])форс[а-яё]*|--force\b|\bforce[\s-]?push/i;

/** Ops the ticket conveyor runs on its own. Everything outside this set keeps doors A and B only.
 *  cherry-pick: pulling a fix into the own branch is the same kind of step as a commit. */
const TICKET_OPS = new Set(['commit', 'push', 'rebase', 'checkout', 'switch', 'cherry-pick']);
/** What Door C′ (the split branch) covers: only ops that write the checked-out branch itself. */
const SPLIT_OPS = new Set(['commit', 'push', 'rebase', 'cherry-pick']);

/** Door C′: the op writes only the split group's own branch, in the session's own worktree. */
function splitGrant(call, op, forced, input) {
  if (forced || !SPLIT_OPS.has(op) || !call?.dir) return false;
  const own = ownSplitAt(call.dir, input?.cwd);
  if (!own) return false;
  if (op === 'push') {
    const to = pushTargets(call.args, own.branch);
    return Boolean(to) && to.every((b) => b === own.branch);
  }
  // `pull --rebase` rebases the checked-out branch onto what it fetched; its args are a remote + refspecs.
  if (op === 'rebase')
    return call.sub === 'pull' ? pullStaysOn(call.args) : rebaseStaysOn(call.args, own.branch);
  return true;
}

/** A push landing on main/master — Door C never covers it, whatever the ticket. */
function pushesProtected(call) {
  if (!call) return true; // a push inside interpreter code: its target cannot be read
  const current = (call.dir && repoAt(call.dir)?.branch) || '';
  const to = pushTargets(call.args, current);
  return !to || to.some(isProtectedBranch);
}

function ticketGrant(input, op, forced, call) {
  if (forced || !TICKET_OPS.has(op)) return false;
  if (op === 'push' && pushesProtected(call)) return false;
  // The run's own ledger, written by THIS session and still open — nothing else is a grant.
  const live = liveTicketRuns(input);
  if (!live.length) return false;
  const named = (text) =>
    live.some((key) => new RegExp(`(?<![A-Za-z0-9])${key}(?!\\d)`, 'i').test(String(text ?? '')));
  // The cheap source first: `record-prompt` cached this turn's prompt, so the usual case — the user
  // handed the ticket over and the whole conveyor runs inside that one turn — costs no file scan.
  if (named(currentUserPrompt(input, []))) return true;
  // Multi-turn run ("continue"): the ticket was named earlier, pay for the transcript only here.
  const speech = userSpeech(sinceLastCompact(readTail(input?.transcript_path)));
  if (speech.some((s) => named(s.text))) return true;
  // A compaction erases the handover but not the run: with no typed words left in the window, the
  // open ledger this session writes to is the record that survives.
  return speech.length === 0;
}

export default function gitGuard(input) {
  // Only what executes is judged: a here-doc body written to a file, a quoted string no shell runs,
  // interpreter code that cannot start a process — all text, see `shell-text.mjs`.
  const raw = input?.tool_input?.command;
  const command = executedText(raw, { code: 'spawn' });
  if (!command) return null;
  // Same length as `command`: an index into one is an index into the other, quotes left readable.
  const original = commandText(raw);
  const matches = [...command.matchAll(new RegExp(MUTATING_GIT.source, 'g'))];
  const trailer = attribution(input, String(raw), command, original, matches);
  if (trailer) return trailer;
  // EVERY op in the command is judged, not the first: `git commit … && git push` authorised for the
  // commit used to carry the push through unasked. Two pushes to different branches are two ops.
  const seen = new Set();
  for (const m of matches) {
    const op = (String(m[1]).match(/^[a-z-]+/) || ['git'])[0];
    const simple = command.slice(m.index).match(/^[^\n|;&]*/)[0];
    // Flags may follow the op word, so "forced" is read over the whole simple command. A `+refspec`
    // is a force push spelled without the flag.
    const forced = op === 'push' && (FORCE_PUSH.test(simple) || /\s\+[^\s+]/.test(simple));
    const call = safeCall(original, m.index, input?.cwd);
    const key = `${op}${forced}${original.slice(m.index, m.index + simple.length)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const verdict = judge(input, op, forced, call);
    if (verdict) return verdict;
  }
  return null;
}

function safeCall(text, at, cwd) {
  try {
    return gitCall(text, at, cwd);
  } catch {
    return null;
  }
}

// A trailer LINE, not a mention: «docs: explain why Co-Authored-By trailers are stripped» is a message.
const TRAILER =
  /(?:^|\n|\\n|["'])[ \t]*Co-Authored-By:[ \t]*\S|Generated with \[?Claude Code\b|🤖[ \t]*Generated\b/i;
const PUBLISH_CLI = /\b(?:gh\s+pr|glab\s+mr)\s+(?:create|edit|update)\b/;

/** Deny a commit / PR command whose message carries an attribution trailer. */
function attribution(input, raw, command, original, matches) {
  const commits = matches.filter((m) => /^commit\b/.test(m[1]));
  if (!commits.length && !PUBLISH_CLI.test(command)) return null;
  let text = raw;
  for (const m of commits) {
    const call = safeCall(original, m.index, input?.cwd);
    const args = call?.args ?? [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const file =
        a === '-F' || a === '--file'
          ? args[i + 1]
          : a.startsWith('--file=')
            ? a.slice(7)
            : /^-F./.test(a)
              ? a.slice(2)
              : null;
      if (!file || file === '-' || !call.dir) continue;
      try {
        text += '\n' + readFileSync(path.resolve(call.dir, slash(file)), 'utf8').slice(0, 20000);
      } catch {
        /* unreadable message file: nothing to judge */
      }
    }
  }
  if (!TRAILER.test(text)) return null;
  return deny(
    'git-guard(attribution) The message carries an attribution trailer (Co-Authored-By / "Generated with Claude Code"). ' +
      'The published-text rule forbids any authorship line and overrides the harness attribution reminder. ' +
      'Drop the trailer and run the command again — no answer from the user is needed for that.',
  );
}

/**
 * Door-independent: a push of a branch whose ledger's LATEST `06-gates` row is red.
 * Red gates block every push; `Docs-Impact`/`Tests-Impact` are gate INPUTS, so the way out is the
 * gate rerun green — or a `06-gates skip` row naming the user's decision.
 */
function redGatesPush(call, input) {
  const repo = repoAt(call?.dir || input?.cwd);
  if (!repo) return null;
  const branches = (call && pushTargets(call.args, repo.branch)) || [repo.branch];
  const red = branchLedgers(repo.root, [repo.branch, ...branches].join(' ')).filter(
    (l) => l.stages['06-gates'] === 'red',
  );
  if (!red.length) return null;
  const keys = red.map((l) => l.key).join(', ');
  return deny(
    `git-guard(gates-red) ${keys}: the latest 06-gates row in the ledger is red, and red blocks every push. ` +
      'Fix it and rerun gate-run until it writes ok (a Docs-Impact/Tests-Impact line goes into the commit BEFORE the rerun — the gate reads it). ' +
      `If the user decided to push anyway: \`ticket-ledger add ${red[0].key} 06-gates skip "<their words>"\`, then push.`,
  );
}

function judge(input, op, forced, call) {
  const rule = OPS[op] ?? { reconfirm: true, why: 'mutates the repository' };
  if (rule.forbidden) return deny(`git-guard(${op}) \`git ${op}\` — ${rule.why}.`);
  if (op === 'push') {
    const red = redGatesPush(call, input);
    if (red) return red;
  }
  if (
    !rule.reconfirm &&
    (splitGrant(call, op, forced, input) || ticketGrant(input, op, forced, call))
  )
    return null;

  const intent = rule.intent && CLASS_OPS.has(op) && !forced ? withClass(rule.intent) : rule.intent;
  return consentGate(input, {
    marker: `git-guard(${forced ? 'force-push' : op})`,
    intent,
    asked: forced ? FORCE_ASKED : (rule.asked ?? rule.intent),
    // A force push can destroy a colleague's work on the remote, so it never rides in on door A.
    reconfirm: rule.reconfirm || forced,
    reason: `\`git ${op}\` ${forced ? 'with --force ' : ''}— ${rule.why}. The user has not authorised it in this turn. ${ASK_THE_USER}`,
  });
}
