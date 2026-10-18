// A review comment may not be written against a stale read of the thread list.
//
// Incident: the discussions call returned only system notes, two humans had already reviewed, and
// three of their findings went out again forty minutes later under the agent's name.
// Re-raising what a colleague already posted costs more trust than the findings were worth, and no
// amount of care prevents it — the list simply goes stale while a review is being written.
//
// So the re-read is a gate, not a habit: a write into an MR requires a discussions read of THAT MR
// within FRESH_MS, and a positional (inline) note additionally requires the version shas, since a
// position built on remembered shas lands on the wrong line or is rejected outright.
//
// No repeat hatch. The convention of the other guards — repeat the identical call
// and it goes through — turned this one into a formality: the second attempt passed with nothing
// re-read, and the test suite pinned that as intended. What opens the gate now is evidence, in two lines:
//   1. the exact key — a read that named the MR the way the write names it;
//   2. after a refusal only — a read that FOLLOWED it and names the same iid in another shape (numeric
//      project id vs path), or names no MR at all. Looser evidence is accepted only as a deliberate
//      answer to the refusal, never as something that happened to be lying around.
// A thread list that cannot be read at all is the user's call: AGENTDECK_KIT_REVIEW_GUARD=0 (or
// CLAUDE_REVIEW_GUARD=0) in the CLI's environment, which no tool call can set.
//
// Two surfaces, one gate. A GitLab MCP server (whatever name it is attached under) and the forge CLIs
// over the user's own login: `glab mr note`, `gh pr comment|review`, and their `api` forms. A CLI
// call names the MR/PR by number only, so its key is `cli#<iid>` on both the read and the write side.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stateDir } from './kit-paths.mjs';
import { readTail } from './transcript.mjs';

const CACHE = stateDir('review') ?? '';
const FRESH_MS = 15 * 60 * 1000;

// Writes that publish review content into a merge request. `update_*` is deliberately absent: editing
// your own note back is not a new claim against the thread list.
const GITLAB = 'mcp__[^_]*gitlab[^_]*__';
const REVIEW_WRITE = new RegExp(
  `^${GITLAB}(create_merge_request_thread|create_draft_note|create_merge_request_note|create_merge_request_discussion_note|bulk_publish_draft_notes)$`,
  'i',
);
const POSITIONAL = new RegExp(`^${GITLAB}(create_merge_request_thread|create_draft_note)$`, 'i');
const DISCUSSIONS_READ = new RegExp(
  `^${GITLAB}(mr_discussions|list_merge_request_discussions|get_merge_request_discussion)$`,
  'i',
);
const VERSIONS_READ = new RegExp(
  `^${GITLAB}(list_merge_request_versions|get_merge_request_version)$`,
  'i',
);
const GITLAB_TOOL = new RegExp(`^${GITLAB}`, 'i');

// Forge CLIs. The number is the first bare integer after the subcommand, or the one in a pasted URL.
const NUM = String.raw`(?:[^\n;&|]*?(?:\/(?:pull|merge_requests)\/|\s!?#?)(\d+)\b)`;
const CLI_WRITE = [
  new RegExp(String.raw`\bglab\s+mr\s+(?:note|comment)\b(?:\s+create\b)?${NUM}`),
  new RegExp(String.raw`\bgh\s+pr\s+comment\b${NUM}`),
  new RegExp(
    String.raw`\bgh\s+pr\s+review\b(?=[^\n;&|]*\s(?:-b|--body|-c|--comment|-r|--request-changes)\b)${NUM}`,
  ),
  new RegExp(
    String.raw`\b(?:glab|gh)\s+api\b(?=[^\n;&|]*(?:-X\s*POST|--method\s+POST|\s-f\s|\s-F\s|--field|--raw-field))[^\n;&|]*?\/(?:merge_requests|pulls|issues)\/(\d+)\/(?:discussions|notes|comments|reviews)`,
    'i',
  ),
];
const CLI_READ = [
  new RegExp(String.raw`\b(?:glab\s+mr|gh\s+pr)\s+view\b(?=[^\n;&|]*\s(?:-c|--comments)\b)${NUM}`),
  new RegExp(
    String.raw`\b(?:glab|gh)\s+api\b(?![^\n;&|]*(?:-X\s*POST|--method\s+POST))[^\n;&|]*?\/(?:merge_requests|pulls|issues)\/(\d+)\/(?:discussions|notes|comments|reviews)`,
    'i',
  ),
];

/** `{iid}` of a forge-CLI review write / thread read in a Bash command, or null. */
function cliMatch(input, patterns) {
  if (!/^(Bash|PowerShell)$/.test(String(input?.tool_name ?? ''))) return null;
  const cmd = String(input?.tool_input?.command ?? '');
  for (const re of patterns) {
    const m = re.exec(cmd);
    if (m?.[1]) return { iid: m[1] };
  }
  return null;
}

/** A CLI call reshaped as the MCP input the key functions read. */
const asCli = (input, iid) => ({
  ...input,
  tool_input: { project_id: 'cli', merge_request_iid: iid },
});

const sessionKey = (session) => String(session ?? 'x').slice(0, 12);

/** The iid a call is about, as a string; null when the input does not name one. */
function iidOf(input) {
  const i = input?.tool_input ?? {};
  const iid = i.merge_request_iid ?? i.mergeRequestIid ?? i.iid;
  return iid === undefined || iid === null || iid === '' ? null : String(iid);
}

/** The MR a call is about, as a cache-safe key; null when the input does not name one. */
function mrKey(input, session) {
  const i = input?.tool_input ?? {};
  const iid = iidOf(input);
  const project = i.project_id ?? i.projectId ?? i.id ?? i.namespace ?? '';
  if (iid === null) return null;
  const safe = `${project}#${iid}`.replace(/[^\w.#@-]/g, '_').slice(0, 60);
  return join(CACHE, `review-${sessionKey(session)}-${safe}.json`);
}

/** Session-wide record of reads the exact key cannot see: `{ d: {iid: ts}, v: {iid: ts}, dAny, vAny }`. */
const sessionPath = (session) => join(CACHE, `review-${sessionKey(session)}-_session.json`);

function load(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

function save(path, patch) {
  try {
    writeFileSync(path, JSON.stringify({ ...load(path), ...patch }));
  } catch {
    /* an unwritable cache must never break a tool call; the guard then asks once more, which is safe */
  }
}

// Shape gates. A «quick» review once skipped the skill, read the diff without the docs, reported clean
// over two docs blockers and posted one-line items. So a review write needs deep-review loaded in this
// session; a new thread must be a finding card; a summary note claiming "no blocking" must carry the
// coverage line. Replies inside an existing thread are exempt from all three. "Loaded" is CLI-agnostic:
// a Skill/skill call, a read of deep-review/SKILL.md (Read or a shell `cat`, which is how Codex loads
// a skill), or `/deep-review` typed by the user (seen in the transcript).
const DEEP_REVIEW = /(?:^|:)deep-review$/;
const SKILL_FILE = /deep-review[\\/]+SKILL\.md\b/;
const isReply = (tool, i) =>
  /create_merge_request_discussion_note$/i.test(tool) ||
  Boolean(i?.discussion_id ?? i?.in_reply_to_discussion_id ?? i?.in_reply_to_id);
// A plain note is review content only when it reads like one — a pipeline or release note is not.
const REVIEW_TEXT =
  /[🔴🟡❓🟢]|(?<![\w-])F-\d+|\breview|\bblocking\b|\bfinding|ревью|замечани|блокер/iu;
const CARD = [
  [/^\s*(?:🔴|🟡|❓|🟢)/u, 'severity marker first (🔴/🟡/❓/🟢)'],
  [/(?<![\w-])F-\d+/, 'id `F-NN`'],
  [/^[^\n]*\*\*[^*\n]+\*\*/, 'bold one-line thesis on the first line'],
  [/[^\s`(]+\.\w+:\d+(?:-\d+)?/, 'the location as `path:start-end`'],
];
/** The opening of a review summary (gitlab-publish.md §5): a heading or a verdict line, no severity marker. */
const SUMMARY_HEAD = /^\s*(?:#{1,3}\s*(?:Review|Summary|Ревью|Итог|Сводка)|\*\*(?:Summary|Итог))/iu;
const CLEAN_CLAIM =
  /\bno\s+(?:blocking|blockers|findings|issues|remarks)\b|\bLGTM\b|(?:блокер[а-яё]*|замечани[а-яё]*|находок)\s+нет|нет\s+(?:ни\s+)?(?:блокер|замечани)|(?<![а-яё])чисто(?![а-яё])/iu;
const COVERAGE = /\*\*(?:Ledger|Coverage|Журнал|Покрытие):\*\*/i;

/** This call loads deep-review, in any CLI's shape. */
function loadsDeepReview(input) {
  const tool = String(input?.tool_name ?? '');
  const i = input?.tool_input ?? {};
  if (/^skill$/i.test(tool)) return DEEP_REVIEW.test(String(i.skill ?? i.name ?? '').trim());
  if (tool === 'Read') return SKILL_FILE.test(String(i.file_path ?? i.path ?? ''));
  if (/^(Bash|PowerShell)$/.test(tool)) return SKILL_FILE.test(String(i.command ?? ''));
  return false;
}

/** deep-review loaded in this session: a recorded load, or `/deep-review` typed by the user. */
function deepReviewLoaded(input) {
  if (load(sessionPath(input?.session_id)).skill) return true;
  const typed = /<command-name>\/(?:[\w-]+:)?deep-review<\/command-name>/;
  return readTail(String(input?.transcript_path ?? '')).some(
    (r) => r.type === 'user' && typed.test(JSON.stringify(r.message?.content ?? '')),
  );
}

// --- People named in published text -------------------------------------------------------------------
// An index note once said «треды Андрея» (Andrew's threads) — the data held one username, the first name
// was invented. A published note speaks to a live team: a name comes from the MR/PR data
// (`author.name` / `username`, harvested from this session's reads), else the username, else the
// sentence goes impersonal. Judged only when the session has read some names; code spans are text, not
// mentions. `@x` pings a real person — an unknown handle pings a stranger. The Russian pattern is the
// shape the original incident had; English: "<Name>'s threads", "thanks <Name>".
const PERSON_REF =
  /(?<![а-яёА-ЯЁ])(?:[Тт]ред[а-яё]*|[Зз]амечани[а-яё]*|[Кк]омментари[а-яё]*|[Рр]евью|[Вв]опрос[а-яё]*|[Нн]аходк[а-яё]*|[Рр]евьюер[а-яё]*|[Рр]ецензент[а-яё]*|[Аа]втор[а-яё]*|[Кк]оллег[а-яё]*|[Сс]пасибо)[ \t]+([А-ЯЁ][а-яё]{2,})(?![а-яё])/gu;
const PERSON_REF_EN =
  /(?:\b[Tt]hanks(?: to)?|\b[Tt]hank you|\b[Rr]eviewer|\b[Aa]uthor)[ \t]+([A-Z][a-z]{2,})\b|\b([A-Z][a-z]{2,})['’]s[ \t]+(?:threads?|comments?|review|findings?|remarks?)\b/g;
const MENTION = /(?<![\w@./-])@([A-Za-z0-9][\w.-]*[A-Za-z0-9])/g;

function strayNames(body, namesList) {
  if (!namesList?.length) return [];
  const known = new Set(namesList);
  const text = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const out = [];
  for (const m of text.matchAll(MENTION)) {
    if (!known.has(m[1].toLowerCase())) out.push(`@${m[1]}`);
  }
  const cut = (s) => s.slice(0, Math.max(3, s.length - 2));
  const unknown = (word) => {
    const w = word.toLowerCase();
    return ![...known].some((k) => k.startsWith(cut(w)) || w.startsWith(cut(k)));
  };
  for (const m of text.matchAll(PERSON_REF)) if (unknown(m[1])) out.push(m[1]);
  for (const m of text.matchAll(PERSON_REF_EN)) {
    const word = m[1] ?? m[2];
    if (unknown(word)) out.push(word);
  }
  return [...new Set(out)];
}

// --- Inline anchor = the card's location line --------------------------------------------------------
// Threads were once pinned to ONE line with the range only named in the text. A finding on lines 10-14 is
// an inline thread on 10-14: GitLab `position.line_range {start,end}` (end = the position's own
// new_line), GitHub `start_line` + `line`. The guard compares what the card says with what the call
// anchors.
const LOCATION =
  /\*\*(?:Где|Where|Location):\*\*\s*`?([^\s`]+?):(\d+)(?:[-–](\d+))?|([^\s`(]+\.\w+):(\d+)(?:[-–](\d+))?/;

function anchorOf(i) {
  let pos = i.position;
  if (typeof pos === 'string') {
    try {
      pos = JSON.parse(pos);
    } catch {
      pos = null;
    }
  }
  const src = pos && typeof pos === 'object' ? pos : i;
  const nums = (x) => [x?.new_line, x?.old_line, x?.line].map(asNumber).filter((n) => n !== null);
  let end = nums(src);
  let start = end;
  if (src.line_range && typeof src.line_range === 'object') {
    start = nums(src.line_range.start);
    end = nums(src.line_range.end);
  } else if (asNumber(src.start_line) !== null) start = [asNumber(src.start_line)];
  if (!end.length) return null;
  return { path: src.new_path ?? src.old_path ?? src.path ?? null, start, end };
}

function anchorRefusal(i, body) {
  const loc = LOCATION.exec(body);
  const anchor = loc && anchorOf(i);
  if (!anchor) return null;
  const file = loc[1] ?? loc[4];
  const start = Number(loc[2] ?? loc[5]);
  const end = (loc[3] ?? loc[6]) ? Number(loc[3] ?? loc[6]) : start;
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  const a = anchor.path ? norm(anchor.path) : null;
  const f = norm(file);
  if (a && a !== f && !a.endsWith(`/${f}`) && !f.endsWith(`/${a}`)) {
    return `the card says ${file} but the position anchors ${anchor.path}. The thread must sit on the file the finding names.`;
  }
  const fits =
    start === end
      ? anchor.end.includes(end)
      : anchor.start.includes(start) && anchor.end.includes(end);
  if (fits) return null;
  const anchored = anchor.start.join('/');
  const anchoredEnd = anchor.end.join('/');
  return (
    `the card says ${file}:${start}${end > start ? `-${end}` : ''} but the position anchors ` +
    `${anchored}${anchoredEnd === anchored ? '' : `..${anchoredEnd}`}. ` +
    (end > start
      ? 'A multi-line finding is an inline thread on the RANGE, not on one line with the range in the text: GitLab position.line_range ' +
        `{start:{line_code,type,new_line:${start}}, end:{line_code,type,new_line:${end}}} with position.new_line = ${end}; GitHub start_line ${start} + line ${end}. ` +
        `Build it: node <kit>/tools/review-position.mjs --base <sha> --start <sha> --head <sha> --file <path> --lines ${start}-${end} (references/gitlab-publish.md §3).`
      : `A single-line finding anchors exactly line ${end}.`)
  );
}

/** Shape gates; a deny object or null. */
function shapeRefusal(tool, input, cli) {
  const i = input?.tool_input ?? {};
  const body = String(i.body ?? i.note ?? '');
  const stray = cli ? [] : strayNames(body, load(sessionPath(input?.session_id)).names);
  if (stray.length) {
    return {
      decision: 'deny',
      reason:
        `Published text names ${stray.map((s) => `«${s}»`).join(', ')}, which no MR/PR data read in this session contains. ` +
        'A person is named only as the API gives it (author.name / username from the reads), else by username, else the sentence goes ' +
        'impersonal. Never infer a first name, never @-mention a handle that was not read. Rule: skill agentdeck-kit:situational-rules → published-text.',
    };
  }
  if (!cli && isReply(tool, i)) return null;
  const thread = !cli && POSITIONAL.test(tool);
  const bulk = /bulk_publish_draft_notes$/i.test(tool);
  if (!cli && !thread && !bulk && !REVIEW_TEXT.test(body)) return null;

  if (!deepReviewLoaded(input)) {
    return {
      decision: 'deny',
      reason:
        'Review write blocked: skill `agentdeck-kit:deep-review` was not loaded in this session. A review ' +
        'published into an MR/PR goes through the skill — its depth may be quick, its presence is not ' +
        'optional. Load it, run it, then publish.',
    };
  }
  if (thread) {
    const missing = CARD.filter(([re]) => !re.test(body)).map(([, what]) => what);
    // A summary sent as a thread because the note tool was not loaded yet: «not a finding card» sent the
    // model to rewrite a summary into a card (18.10.2026).
    if (missing.length && SUMMARY_HEAD.test(body)) {
      return {
        decision: 'deny',
        reason:
          'This body is the review SUMMARY, not a finding: it goes out as a non-positional note via ' +
          '`create_merge_request_note` — not loaded → `discover_tools` category `merge_requests` first. ' +
          'Threads carry finding cards only (gitlab-publish.md §2, §5).',
      };
    }
    if (missing.length) {
      return {
        decision: 'deny',
        reason:
          `Review thread blocked: the body is not a finding card. Needed: ${missing.join(', ')}. ` +
          'Template: <kit>/skills/deep-review/references/finding-card.md.',
      };
    }
    const off = anchorRefusal(i, body);
    if (off) return { decision: 'deny', reason: `Review thread blocked: ${off}` };
  } else if (!cli && !bulk && CLEAN_CLAIM.test(body) && !COVERAGE.test(body)) {
    return {
      decision: 'deny',
      reason:
        'Summary note blocked: it claims "no blocking / no findings" without a coverage line. Add ' +
        '`**Ledger:**` naming what was read and what stayed uncovered — a clean verdict is earned only ' +
        'by a ledger with no unread zone.',
    };
  }
  return null;
}

// --- Was the thread list actually READ? ---------------------------------------------------------------
// The GitLab MCP discussions response is `{items:[…], pagination:{x_total,…}}`. A jmespath that started
// one level too low (`[].notes[]`) answered `null` and was taken for «no discussions» on an MR that had 27
// — the review would have re-posted every human finding. A call that merely HAPPENED is no evidence:
// null, an empty projection result, an error, `items: []` while `x_total` says otherwise, or the first
// page of several are failed reads. Only a read that returned the list (or proved it empty with
// `x_total: 0`) stamps `discussions`. The same verdict judges a forge-CLI read (`glab api`, `gh api`).
const PROJECTION = /^(?:jmespath|jq|projection|select|fields)$/i;
const CLI_PROJECTION = /\s(?:--jq|--template)\b|\sapi\b[^\n;&|]*\s-q\b/;

/** Every text piece of a tool result: plain strings, `{type:'text',text}` blocks, nested content. */
function responseTexts(response, out = []) {
  if (typeof response === 'string') out.push(response);
  else if (Array.isArray(response)) response.forEach((v) => responseTexts(v, out));
  else if (response && typeof response === 'object') {
    if (typeof response.text === 'string') out.push(response.text);
    else Object.values(response).forEach((v) => responseTexts(v, out));
  }
  return out;
}

const asNumber = (v) =>
  v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);

/** One parsed payload → `{ok, why?, total?, pages?, page?}`. */
function judgePayload(p, projected) {
  const hint =
    ' — a jmespath/jq that returns nothing on a non-empty answer is a wrong projection (the shape is {items:[…], pagination}: start at items[])';
  if (p === null || p === undefined) return { ok: false, why: `returned null${hint}` };
  if (Array.isArray(p)) {
    return p.length || !projected
      ? { ok: true }
      : { ok: false, why: `returned an empty list from a projection${hint}` };
  }
  if (typeof p === 'object') {
    const pg = p.pagination ?? p.meta ?? {};
    const total = asNumber(pg.x_total ?? pg.total);
    if (Array.isArray(p.items)) {
      if (p.items.length) {
        return {
          ok: true,
          total,
          pages: asNumber(pg.x_total_pages ?? pg.total_pages ?? pg.pages),
          page: asNumber(pg.x_page ?? pg.page),
        };
      }
      return total === 0
        ? { ok: true, total }
        : {
            ok: false,
            why: `returned items: [] with ${total === null ? 'no pagination.x_total' : `x_total ${total}`} — empty is proved only by x_total: 0`,
          };
    }
    if ('pagination' in p || 'meta' in p)
      return { ok: false, why: 'returned pagination without items' };
    if (!Object.keys(p).length) return { ok: false, why: 'returned an empty object' };
    return { ok: true }; // a single discussion or a shape we do not know: not ours to judge
  }
  return projected
    ? { ok: false, why: `returned a bare ${typeof p} from a projection${hint}` }
    : { ok: true };
}

/**
 * Did this discussions call return the thread list? `{ok:true,…}` or `{ok:false, why}`. No
 * `tool_response` at all (a CLI whose hook does not send one) is unjudgeable and passes — the guard must
 * not block on evidence it never gets.
 */
export function discussionsVerdict(input) {
  const resp = input?.tool_response;
  if (resp === undefined) return { ok: true };
  if (resp === null) return { ok: false, why: 'returned nothing (null)' };
  if (resp?.isError === true || resp?.is_error === true)
    return { ok: false, why: 'returned an error' };
  const projected =
    Object.keys(input?.tool_input ?? {}).some((k) => PROJECTION.test(k)) ||
    CLI_PROJECTION.test(String(input?.tool_input?.command ?? ''));
  const texts = responseTexts(resp).filter((t) => t.trim() !== '');
  if (!texts.length) return { ok: false, why: 'returned an empty result' };
  let first = null;
  for (const raw of texts) {
    const s = raw.trim();
    let v;
    try {
      v = JSON.parse(s);
    } catch {
      if (/^(?:error|failed|unauthori[sz]ed|forbidden|not found|\d{3}\b)/i.test(s)) {
        first ??= { ok: false, why: `returned an error text («${s.slice(0, 60)}»)` };
        continue;
      }
      return { ok: true }; // prose or markdown: not ours to parse
    }
    const r = judgePayload(v, projected);
    if (r.ok) return r;
    first ??= r;
  }
  return first ?? { ok: false, why: 'returned nothing usable' };
}

/** Names a person goes by in MR/PR data: every `{username|login, name}` object. Lower-case tokens. */
function harvestNames(response) {
  const out = new Set();
  const add = (s) => {
    for (const t of String(s ?? '')
      .toLowerCase()
      .split(/[\s,]+/)) {
      if (t.length >= 3) out.add(t);
    }
  };
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const handle = typeof v.username === 'string' ? v.username : v.login;
      if (typeof handle === 'string') {
        add(handle);
        add(v.name);
      }
      Object.values(v).forEach(walk);
    }
  };
  for (const raw of responseTexts(response)) {
    try {
      walk(JSON.parse(raw));
    } catch {
      /* prose — no names to take */
    }
  }
  return out;
}

/**
 * PostToolUse module: remember that this MR's thread list (or its shas) was actually read.
 * Always silent — it records, it never speaks.
 */
export function recordReviewRead(input) {
  if (!CACHE) return null;
  if (loadsDeepReview(input)) {
    save(sessionPath(input?.session_id), { skill: Date.now() });
    return null;
  }
  const original = input;
  const cli = cliMatch(input, CLI_READ);
  if (cli) input = asCli(input, cli.iid);
  const tool = String(input?.tool_name ?? '');
  const now = Date.now();
  const sess = sessionPath(input?.session_id);

  // People named in MR data — the only names a published note may carry (see `strayNames`).
  if (GITLAB_TOOL.test(tool) && original?.tool_response !== undefined) {
    const found = harvestNames(original.tool_response);
    if (found.size) {
      save(sess, { names: [...new Set([...(load(sess).names ?? []), ...found])].slice(-600) });
    }
  }
  const discussions = Boolean(cli) || DISCUSSIONS_READ.test(tool);
  if (!discussions && !VERSIONS_READ.test(tool)) return null;

  const path = mrKey(input, input?.session_id);
  let complete = true;
  if (discussions) {
    const v = discussionsVerdict(original);
    if (!v.ok) {
      if (path) save(path, { bad: { at: now, why: v.why } });
      return null;
    }
    // Several pages: the dedup needs ALL of them — the first twenty of 27 miss the rest.
    const total = v.pages ?? 1;
    if (path && total > 1) {
      const state = load(path);
      const seen = state.pagesTotal === total ? (state.pages ?? {}) : {};
      seen[v.page ?? asNumber(original?.tool_input?.page) ?? 1] = now;
      const fresh = (n) => Number(seen[n] ?? 0) > now - FRESH_MS;
      complete = Array.from({ length: total }, (_, k) => k + 1).every(fresh);
      save(path, {
        pages: seen,
        pagesTotal: total,
        partial: complete
          ? null
          : {
              total,
              have: Object.keys(seen)
                .map(Number)
                .sort((a, b) => a - b),
            },
      });
    } else if (path) save(path, { pages: null, pagesTotal: null, partial: null });
  }
  if (!complete) return null; // some pages still unread: neither the key nor the session record opens the gate
  if (path) save(path, discussions ? { discussions: now, bad: null } : { versions: now });

  const iid = iidOf(input);
  if (iid === null) save(sess, discussions ? { dAny: now } : { vAny: now });
  else {
    const slot = discussions ? 'd' : 'v';
    save(sess, { [slot]: { ...(load(sess)[slot] ?? {}), [iid]: now } });
  }
  return null;
}

/** PreToolUse module: block a review write built on a stale or absent read. */
export default function reviewPublishGuard(input) {
  if (process.env.AGENTDECK_KIT_REVIEW_GUARD === '0' || process.env.CLAUDE_REVIEW_GUARD === '0')
    return null;
  if (!CACHE) return null;
  const cli = cliMatch(input, CLI_WRITE);
  if (cli) input = asCli(input, cli.iid);
  const tool = String(input?.tool_name ?? '');
  if (!cli && !REVIEW_WRITE.test(tool)) return null;

  const shape = shapeRefusal(tool, input, Boolean(cli));
  if (shape) return shape;

  const path = mrKey(input, input?.session_id);
  // bulk_publish_draft_notes and friends may not name the MR in a shape we recognise. A guard that
  // cannot identify its subject says nothing rather than blocking an unrelated call.
  if (!path) return null;

  const now = Date.now();
  const state = load(path);
  const positional = !cli && POSITIONAL.test(tool);

  // Line 1 — the exact key.
  const exactD = Number(state.discussions ?? 0);
  let discussionsOk = exactD > now - FRESH_MS;
  let versionsOk = !positional || Boolean(state.versions);

  // Line 2 — after a refusal only: evidence that FOLLOWED it, matched by iid or not keyed at all.
  const deniedAt = Number(state.deniedAt ?? 0);
  if (deniedAt && !(discussionsOk && versionsOk)) {
    const sess = load(sessionPath(input?.session_id));
    const iid = iidOf(input);
    const after = (byIid, any) => {
      const t = Math.max(Number(byIid?.[iid] ?? 0), Number(any ?? 0));
      return t > deniedAt ? t : 0;
    };
    discussionsOk ||= after(sess.d, sess.dAny) > now - FRESH_MS;
    versionsOk ||= after(sess.v, sess.vAny) > 0;
  }
  if (discussionsOk && versionsOk) return null;

  const missing = [];
  let why = '';
  if (!discussionsOk) {
    const failed = state.bad && Number(state.bad.at) > exactD ? state.bad : null;
    const partial = state.partial?.total ? state.partial : null;
    if (failed) {
      missing.push(`a successful thread-list read (the last one ${failed.why})`);
      why =
        ' A read that returned null/empty/an error is a FAILED read, never "no discussions": re-read without the projection (or start it at items[]) and check pagination.x_total.';
    } else if (partial) {
      const left = Array.from({ length: partial.total }, (_, k) => k + 1).filter(
        (n) => !partial.have.includes(n),
      );
      missing.push(`mr_discussions page(s) ${left.join(', ')} of ${partial.total}`);
      why = ' The list has several pages — the dedup needs all of them.';
    } else {
      missing.push(
        `${cli ? 'the thread list (glab mr view -c / gh pr view --comments)' : 'mr_discussions'}${exactD ? ' (read is older than 15 min)' : ''}`,
      );
    }
  }
  if (!versionsOk) {
    missing.push('list_merge_request_versions');
    why +=
      ' Versions belong to the START of a review (right after the MR is read); a tool category that is opt-in (merge_requests) must be activated first — run discover_tools if the tool is absent.';
  }

  const fingerprint = createHash('sha1')
    .update(tool)
    .update(JSON.stringify(input?.tool_input ?? {}))
    .digest('hex')
    .slice(0, 16);
  const repeated = state.retry === fingerprint;
  // The FIRST refusal is the mark evidence has to follow. A later one must not move it past a re-read
  // that already happened: discussions re-read, versions still owed → that re-read stays valid.
  save(path, { retry: fingerprint, deniedAt: deniedAt || now });

  return {
    decision: 'deny',
    reason:
      (repeated ? 'Repeating the call does not open this gate — only the read does. ' : '') +
      `Review write blocked: ${missing.join(' + ')} not read for this MR in this session. ` +
      'Threads arrive while a review is being written — re-read the list, drop anything a human already ' +
      'raised, check the head sha has not moved, then send the write. A list that cannot be read at all → ' +
      `stop and tell the user, never publish blind.${why} Rule: skill agentdeck-kit:situational-rules → review-depth.`,
  };
}
