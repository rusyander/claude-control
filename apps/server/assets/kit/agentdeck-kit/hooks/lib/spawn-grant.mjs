// Time-boxed spawn grant that only the HUMAN can give (24.10.2026). The owner told the agent in chat
// «агенты сам, не спрашивай, на 8 часов»; the agent kept that in its own memory, the spawn guard never
// saw it, and every subagent spawn still asked. The grant now lives where the guard reads it.
//
// Source = the UserPromptSubmit prompt only — what the user typed. The prompt dispatcher hands over ''
// for synthetic turns (task notifications, compaction continuations, a message relayed from another
// session), so none of those can grant. Tool results and assistant text never reach this module.
// Quoted and fenced blocks are pasted DATA (a ticket body, a log), not the user speaking: stripped.
//
// Grammar, ru + en, per sentence (an ellipsis glues, the owner writes «агенты… сам… на 8 часов»):
//   grant  = an agents word + an allowing word + a duration, no negation, in one sentence or two
//            adjacent ones. Duration: «на N час(ов)/минут», «N ч», «на полчаса», «на час», «до HH:MM»,
//            number words один..двенадцать / one..twelve, «на (одни) сутки», «на день», «for a day».
//            Capped at 24 h (owner 24.10 evening: a grant for a whole day, typed once).
//   revoke = a negation or revocation beside an agents/permission word anywhere in the prompt; it ends
//            the grant and beats a grant in the same prompt (the safe reading wins).
// The canonical phrase GRANT_PHRASE always works; the guard's ask names it, so the user learns it.
//
// Store: stateDir('grants')/spawn-<session>.json {from, until, text≤200} — per session, so another
// session (a parallel chat, a split group) never rides on it.
// A split-group session (AGENTDECK_SPLIT_CHILD=1) neither records nor reads a grant: its «user» prompt
// is written by the panel, not typed by the human.
// The guard trusts the store file, so a model that writes it grants itself: `grantStoreWrite` refuses
// any model write into the kit state dir (called first by secret-guard, hard deny, no repeat escape).
// The grant is honoured only while that guard is in the composed kit: secret-guard switched off in the
// panel would leave the store writable, so the spawn guard then asks as without a grant.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT, logSessionEvent, sessionKey, STATE_DIR, stateDir } from './kit-paths.mjs';

export const GRANT_CAP_MS = 24 * 3600e3;
export const GRANT_PHRASE = {
  ru: 'агенты без вопроса на N ч',
  en: 'agents without asking for N h',
};

const W = '(?<![\\p{L}\\d])'; // word start that works for Cyrillic (`\b` does not)
const E = '(?![\\p{L}])'; // word end
const re = (parts) => new RegExp(parts.join('|'), 'iu');

const AGENTS = re([
  `${W}(?:саб|суб|под)?агент\\p{L}{0,4}${E}`,
  `${W}(?:sub-?)?agents?${E}`, // `agents?` + word end: «agentdeck» is not an agents word
]);
const ALLOW = re([
  `${W}разреш`,
  `${W}можешь`,
  `${W}можно`,
  `${W}запускай`,
  `${W}активируй`,
  `${W}сам(?:а|и|остоятельно)?${E}`,
  `${W}без\\s+(?:вопрос|спрос|подтвержд)`,
  `${W}не\\s+(?:надо\\s+|нужно\\s+)?(?:спрашива|переспрашива)`,
  `${W}allow`,
  `${W}without\\s+asking`,
  `${W}(?:don'?t|do\\s+not|never|no\\s+need\\s+to)\\s+ask`,
  `${W}stop\\s+asking`,
  `${W}feel\\s+free`,
  `${W}go\\s+ahead`,
  `${W}on\\s+your\\s+own`,
  `${W}(?:may|can)\\s+(?:spawn|launch|run|use|start)`,
]);
const NEGATE = re([
  `${W}не\\s+(?:разреш|запуск|активир|позволя)`,
  `${W}запрещ`,
  `${W}нельзя`,
  `${W}отзыв`,
  `${W}отмен`,
  `${W}больше\\s+не(?!\\s+(?:спрашива|переспрашива|задава|жди))`,
  `(?<!не\\s+)${W}спрашивай\\s+(?:снова|опять|всегда|кажд)`,
  `${W}(?:снова|опять)\\s+спрашивай`,
  `${W}хватит(?!\\s+(?:спрашива|переспрашива))`,
  `${W}без\\s+(?:саб|суб|под)?агент`,
  `${W}не\\s+(?:надо|нужно|нужны|стоит)\\s+(?:\\p{L}+\\s+)?(?:саб|суб|под)?агент`,
  `${W}(?:don'?t|do\\s+not|never|no\\s+longer|stop)\\s+(?:spawn|launch|run|start|using|use)`,
  `${W}not\\s+allowed`,
  `${W}disallow`,
  `${W}forbid`,
  `${W}revok`,
  `(?<!(?:don'?t|not|never|no\\s+need\\s+to)\\s+)${W}ask\\s+(?:me\\s+)?(?:again|every|each|first|before)`,
  `${W}no\\s+(?:more\\s+)?(?:sub-?)?agents${E}`,
  `${W}without\\s+(?:sub-?)?agents${E}`,
  `^\\s*stop${E}`,
]);
/** What a revocation must stand beside: «отмени ветку» alone is not about agents. */
const PERM = re([`${W}разреш`, `${W}спрашива`, `${W}permission`, `${W}grant`, `${W}ask`]);

const NUM = {
  один: 1,
  одну: 1,
  одного: 1,
  два: 2,
  две: 2,
  двух: 2,
  три: 3,
  трёх: 3,
  трех: 3,
  четыре: 4,
  четырёх: 4,
  четырех: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
  десять: 10,
  одиннадцать: 11,
  двенадцать: 12,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const NUM_ALT = `\\d+(?:[.,]\\d+)?|${Object.keys(NUM).join('|')}`;
const num = (s) => NUM[s] ?? Number(String(s).replace(',', '.'));
const HOURS = new RegExp(
  `(?<!(?:до|until|till)\\s{1,3})${W}(${NUM_ALT})\\s*-?\\s*(?:ч|час\\p{L}*|h|hrs?|hours?)${E}`,
  'iu',
);
const MINUTES = new RegExp(`${W}(${NUM_ALT})\\s*-?\\s*(?:мин\\p{L}*|min|mins|minutes?)${E}`, 'iu');
const CLOCK = new RegExp(`${W}(?:до|until|till)\\s+(\\d{1,2})[:.](\\d{2})(?!\\d)`, 'iu');
const WORDS = [
  [new RegExp(`${W}полтора\\s+часа|${W}an?\\s+hour\\s+and\\s+a\\s+half`, 'iu'), 90 * 60e3],
  [new RegExp(`${W}полчаса|${W}half\\s+an\\s+hour`, 'iu'), 30 * 60e3],
  [
    new RegExp(
      `${W}на\\s+(?:одн[иы]\\s+)?сутки|${W}на\\s+(?:один\\s+)?день${E}|${W}for\\s+(?:a|one)\\s+day${E}`,
      'iu',
    ),
    24 * 3600e3,
  ],
  [new RegExp(`${W}(?:на|for)\\s+(?:один\\s+)?час${E}|${W}for\\s+an?\\s+hour${E}`, 'iu'), 3600e3],
];

/** Milliseconds from `now` the sentence names, or 0. */
function durationOf(s, now) {
  for (const [rx, ms] of WORDS) if (rx.test(s)) return ms;
  const c = s.match(CLOCK);
  if (c && Number(c[1]) < 24 && Number(c[2]) < 60) {
    const at = new Date(now);
    at.setHours(Number(c[1]), Number(c[2]), 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime() - now;
  }
  const h = s.match(HOURS);
  if (h) return num(h[1]) * 3600e3 || 0;
  const m = s.match(MINUTES);
  if (m) return num(m[1]) * 60e3 || 0;
  return 0;
}

/** Sentences of what the user typed; quoted/fenced blocks and harness reminders removed. */
function sentences(text) {
  return String(text ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\.{2,}|…/g, ' … ')
    .split(/\n+|[.!?;](?=\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The verdict of one typed prompt: {kind:'grant', ms} | {kind:'revoke'} | null.
 * Pure — the grammar is tested on it directly and through the prompt dispatcher.
 */
export function parseSpawnGrant(text, now = Date.now()) {
  const list = sentences(text);
  if (list.some((s) => NEGATE.test(s) && (AGENTS.test(s) || PERM.test(s))))
    return { kind: 'revoke' };
  for (let i = 0; i < list.length; i++) {
    for (const w of [list[i], `${list[i]} ${list[i + 1] ?? ''}`]) {
      if (NEGATE.test(w) || !AGENTS.test(w) || !ALLOW.test(w)) continue;
      const ms = durationOf(w, now);
      if (ms > 0) return { kind: 'grant', ms: Math.min(ms, GRANT_CAP_MS) };
    }
  }
  return null;
}

function grantFile(input) {
  if (process.env.AGENTDECK_SPLIT_CHILD === '1') return null;
  const key = sessionKey(input);
  const dir = key && stateDir('grants');
  return dir ? join(dir, `spawn-${key}.json`) : null;
}

/** Prompt side: a grant writes the session's file, a revocation removes it; anything else — no-op. */
export function recordSpawnGrant(input, prompt, now = Date.now()) {
  const file = grantFile(input);
  if (!file || !prompt) return null;
  const v = parseSpawnGrant(prompt, now);
  if (!v) return null;
  if (v.kind === 'revoke') {
    rmSync(file, { force: true });
    logSessionEvent(input, { kind: 'spawn-grant-revoked' });
    return v;
  }
  const grant = {
    from: new Date(now).toISOString(),
    until: new Date(now + v.ms).toISOString(),
    text: String(prompt).slice(0, 200),
  };
  writeFileSync(file, JSON.stringify(grant), 'utf8');
  logSessionEvent(input, { kind: 'spawn-grant', until: grant.until });
  return v;
}

/** Guard side: this session's unexpired grant, or null. A window longer than the cap is not trusted. */
export function activeSpawnGrant(input, now = Date.now()) {
  const file = grantFile(input);
  if (!file || !existsSync(join(KIT_ROOT, 'hooks', 'secret-guard.mjs'))) return null;
  try {
    const g = JSON.parse(readFileSync(file, 'utf8'));
    const from = Date.parse(g.from);
    const until = Date.parse(g.until);
    if (!(until > now) || !(from <= now + 60e3) || until - from > GRANT_CAP_MS + 60e3) return null;
    return g;
  } catch {
    return null;
  }
}

const STATE_NAME = /agentdeck-kit-state/i;
/** The grant file itself, reached by a relative path; a project's own `grants/spawn-*.ts` is not it. */
const GRANT_NAME = /grants[\\/]+spawn-[^\\/\s'"]*\.json\b/i;
/** The variable by any spelling: `$X`, `%X%`, `$env:X`, `process.env.X`, `os.environ['X']`. */
const STATE_ENV = /\bAGENTDECK_KIT_STATE\b/i;
const EDIT_TOOLS = /^(?:Write|Edit|MultiEdit|NotebookEdit)$/;
const NULL_SINK = /^\s*(?:\/dev\/null|nul|\$null)(?![\w.])/i;
/**
 * A route that writes a file: copy/move/link verbs, cmdlets and their aliases, downloads, archive
 * extraction, cmd, any interpreter, an in-place sed. Re-check 24.10: `curl -o`, `wget -O`, `tar -C`,
 * `unzip -d`, `cmd /c copy`, `xcopy`, `ni`/`sc`/`ac`/`cpi` and `Expand-Archive` wrote the store unseen.
 */
const WRITE_VERB = new RegExp(
  [
    /\b(?:tee|cp|mv|install|ln|dd|touch|rsync|curl|wget|tar|bsdtar|unzip|7za?|cmd|copy|xcopy|robocopy|move|ren(?:ame)?)\b/,
    /\b(?:Copy|Move|Rename|New)-Item\b|\b(?:Set|Add)-Content\b|\bOut-File\b|\bExpand-Archive\b|\bExport-\w+/,
    /\b(?:Invoke-(?:WebRequest|RestMethod)|Start-BitsTransfer)\b|(?<![\w-])(?:ni|sc|ac|cpi|mi|rni|iwr|irm)\b/,
    /\b(?:node|nodejs|python3?|py|deno|bun|perl|ruby|php|pwsh|powershell)\b/,
    /writeFile|write_text|WriteAll(?:Text|Bytes|Lines)|\bsed\b[^|;&]*\s-i/,
  ]
    .map((part) => part.source)
    .join('|'),
  'i',
);

const slashed = (text) => String(text).replace(/\\/g, '/').toLowerCase();

function namesStore(text) {
  return (
    STATE_NAME.test(text) ||
    GRANT_NAME.test(text) ||
    STATE_ENV.test(text) ||
    slashed(text).includes(slashed(STATE_DIR))
  );
}

/**
 * `>`/`>>` to anything but a null sink; `2>&1`, `>&-`, `->`, `=>` are not writes. `>&file` is: Bash
 * sends both streams into that file (re-check 24.10, it passed as `2>&1`).
 */
function redirectsToFile(command) {
  for (const m of command.matchAll(/(?<![-=])>{1,2}(?:&(?!\s*(?:\d+|-)(?![^\s;|&)]))|(?!&))/g)) {
    if (!NULL_SINK.test(command.slice(m.index + m[0].length))) return true;
  }
  return false;
}

/**
 * A model write into the kit state dir (the grant store lives there) → the reason, else null.
 * Reads and `rm` pass: a removal only revokes, the safe side. Known limit, as in inline-edit-guard:
 * a script FILE run by path, or a path built from fragments, is not seen.
 */
export function grantStoreWrite(input) {
  const tool = String(input?.tool_name ?? '');
  const ti = input?.tool_input ?? {};
  if (EDIT_TOOLS.test(tool)) {
    const path = String(ti.file_path ?? ti.notebook_path ?? '');
    return path && namesStore(path) ? `${tool} into the agentdeck kit state (${path})` : null;
  }
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const command = String(ti.command ?? '');
  if (!namesStore(command)) return null;
  return redirectsToFile(command) || WRITE_VERB.test(command)
    ? 'a command that writes into the agentdeck kit state'
    : null;
}
