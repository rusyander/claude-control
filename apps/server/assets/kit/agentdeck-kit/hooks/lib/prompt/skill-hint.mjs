// Module of the prompt dispatcher (one node start per prompt for every hint). Contract:
// (input, prompt) → string | null.
// Global router (UserPromptSubmit): match the SITUATION in the user's prompt → name the skill(s) that
// fit, so the user never has to remember they exist. This is the hook-routed leg of the invocation
// axis (skill skill-authoring §1): zero always-on context cost, exact trigger, and it survives a long
// turn where dozens of descriptions compete for attention.
//
// Design rules:
// - At most 2 candidates. A menu is as useless as no menu.
// - Silent where another hook already owns the domain (figma-hint on a figma.com link, docs-order-hint
//   on "docs + tidy") — two hints on one prompt is duplication.
// - Silent when the user asked for the fast lane. "just do it" (either language) outranks every suggestion.
// - Advisory, never a deny: the model still decides, and mechanical work takes no skill at all.
// Kill switch: AGENTDECK_KIT_SKILL_HINT=0 (CLAUDE_SKILL_HINT=0 too).
//
// Deliberately absent, not forgotten: style-conformance-review (chained by prepare-mr and
// refactor-code-health), frontend-architecture (opt-in per project-profile binding), doc-hygiene
// (the doc-guard hooks already fire it), human-docs (user-invoked by design), docs-triage and
// figma-parity (owned by docs-order-hint / figma-hint above). Adding them would raise the
// multi-match rate, which pushes prompts into the skill-map fallback and hints nothing.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export default function skillHint(input, prompt) {
  if (process.env.AGENTDECK_KIT_SKILL_HINT === '0' || process.env.CLAUDE_SKILL_HINT === '0')
    return null;
  if (!prompt.trim()) return null;

  // \b is ASCII-only in JS, so Cyrillic stems carry explicit lookarounds inline in each pattern below.

  // A project that already carries a profile, looked up from the session cwd to the filesystem root —
  // a session opened inside a monorepo package still belongs to the onboarded repo above it.
  function hasProjectProfile(start) {
    let dir = String(start ?? '');
    for (let i = 0; dir && i < 12; i++) {
      if (existsSync(join(dir, '.claude', 'project-profile.md'))) return true;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return false;
  }

  // The user waived ceremony — no suggestion is welcome.
  const FAST_LANE =
    /(просто\s+сделай|без\s+церемони|не\s+надо\s+скилл|без\s+скилл|быстро\s+поправь|just\s+do\s+it|no\s+ceremony)/i;

  // Domains another hook already routes — hinting twice on one prompt is duplication.
  const FIGMA = /figma\.com\//i; // figma-hint
  // docs-order-hint fires only when a doc noun AND a tidy verb are both present; mirror that pair.
  const DOCS_NOUN =
    /(?<![а-яёa-z])(документ[а-яё]*|док(?:и|ов|ам|ами|ах|у|а|е)?|docs?|documentation|markdown)(?![а-яё])|\.md(?![a-z])/i;
  const DOCS_TIDY =
    /(в\s+порядок|порядок\s+в|наведи\s+порядок|приберись|прибери|разложи|разбери|расклад|почист|очист|подчист|прочист|сгруппируй|структурир|упорядоч|систематизир|дедуплиц|убери\s+дубл|сожми|уплотн|tidy|clean\s*up|reorganiz|consolidat|dedupe|sort\s+out|declutter)/i;
  const ownedElsewhere = (p) => FIGMA.test(p) || (DOCS_NOUN.test(p) && DOCS_TIDY.test(p));

  const CANDIDATES = [
    {
      skill: 'stand-doctor',
      what: 'systematic diagnosis of a sick local stand before touching code',
      re: /(?<![а-яё])(стенд[а-яё]*|локалк[а-яё]*)(?![а-яё])|не\s+(?:поднимается|запускается|стартует)|(?:после|потом)\s+пересборк|502|503|bad\s+gateway|dev\s*server\s+(?:won'?t|does\s*not)\s+start/i,
    },
    {
      skill: 'log-forensics',
      what: 'any bug — error, wrong behaviour, flaky test: a red-capable repro loop before any hypothesis',
      // Wrong behaviour and flakiness carry no log words, so they get their own branches; "floating" /
      // "unstable" only next to a bug noun — a floating button is layout, not a bug.
      re: /(?<![а-яё])(стектрейс[а-яё]*|стэктрейс[а-яё]*|трейс[а-яё]*|логах?|логи|логов)(?![а-яё])|stack\s*trace|traceback|(?<![а-яё])(упал[а-яо]?|падает|крашит[а-яё]*|валится)(?![а-яё])|unhandled|уже\s+в\s+проде.*ошибк|(?<![а-яё])флак[а-яё]*|flaky|(?<![а-яё])(?:плавающ|нестабильн)[а-яё]*\s+(?:тест|баг|ошибк)|то\s+проходит,?\s+то\s+(?:нет|падает)|(?<![а-яё])через\s+раз(?![а-яё])|работает\s+не\s+так|вед[её]т\s+себя\s+(?:не\s+так|странно)|почему\s+не\s+работает/i,
    },
    {
      skill: 'perf-audit',
      what: 'measure first — bundle, network, re-renders, timings — then fix what the numbers show',
      re: /(?<![а-яё])(тормоз[а-яё]*|медленн[а-яё]*|лаг[а-яё]*|подвисает|фриз[а-яё]*)(?![а-яё])|долго\s+(?:грузит|грузится|открывается)|(?:slow|laggy|janky)(?!\w)|перформанс|производительност/i,
    },
    {
      skill: 'deep-review',
      what: 'three-axis review of any scope — MR, branch, working tree or whole repo — every finding proved by a run, a line or a grep',
      re: /(?<![а-яё])(?:(?:от|про|за)?ревьюй?|ревьюшн)(?![а-яё])|код[-\s]?ревью|(?:посмотри|глянь|проверь|пройдись\s+по)\s+(?:(?:мо[йиюе][а-яё]*|чуж[а-яё]+|вес[ьс]|всему?)\s+)?(?:ветк[уеи]|мр(?![а-яё])|mr|пр(?![а-яё])|pr|пулл[а-яё]*|правк[аиу][а-яё]*|дифф?|diff|код[уа]?(?![а-яё])|проект[уа]?(?![а-яё]))|review\s+(?:this\s+|my\s+|the\s+)?(?:pr|mr|branch|diff|code|changes)|code\s*review/i,
      // Remarks FROM a finished review are intake for task-spec-builder, not a request for a new review.
      not: [
        /(?<![а-яё])(?:замечани|комментари|коммент)[а-яё]*\s+(?:с|из|по)\s+ревью|ревьюер[а-яё]*\s+(?:написал|оставил|накидал)/i,
      ],
    },
    {
      skill: 'prepare-mr',
      what: 'the final gate before handover — verify, style self-review, readiness checklist, summary',
      re: /(?<![а-яё])(готов[а-яё]*\s+к\s+(?:мр|mr|мержу)|собери\s+(?:мр|mr)|перед\s+(?:мержем|мр|mr)|финальн[а-яё]*\s+провер)|ready\s+for\s+(?:mr|pr|merge)/i,
    },
    {
      skill: 'changelog-builder',
      what: 'paste-ready MR description / changelog built from the real diff',
      re: /(?<![а-яё])(описание\s+(?:мр|mr|пр|pr)|чейнджлог|changelog|что\s+измен[а-яё]+)(?![а-яё])|release\s+notes/i,
    },
    {
      skill: 'unit-integration-tests',
      what: 'stack and precedent first, plan for approval, then tests written to green',
      re: /(?<![а-яё])(напиши|добавь|нужны|покрой)[^.!?\n]{0,24}тест|покрыт[а-яё]*\s+тестами|unit\s*tests?|(?<![а-яё])вайтест|vitest|jest(?!\w)|тестами\s+покры/i,
    },
    {
      skill: 'playwright-e2e-tests',
      what: 'e2e flows — analyze auth/kit, plan for approval, drive to green',
      re: /(?<![а-яё])(e2e|енд[- ]?ту[- ]?енд|плейрайт|playwright|end[- ]to[- ]end)(?![а-яё])/i,
    },
    {
      skill: 'bug-regression-test',
      what: 'lock the fix in with a test that would have failed before it',
      re: /(?<![а-яё])(регресс[а-яё]*\s+тест|чтобы\s+не\s+(?:повтор|верну)[а-яё]*|не\s+сломалось\s+снова)|regression\s+test/i,
    },
    {
      skill: 'project-audit',
      what: 'tool-driven whole-repo hard audit — vulns, cycles, dead code, duplication, complexity, secrets, stack canon — verified findings to a report pack',
      re: /(?<![а-яё])(полн|жёстк|жестк|глубок)[а-яё]*\s+аудит|аудит\s+(?:всего\s+)?(?:проект|репо|код)[а-яё]*|full\s+audit|deep\s+audit|audit\s+the\s+(?:repo|project|codebase)/i,
    },
    {
      skill: 'refactor-code-health',
      what: 'staged audit — dead code, duplication, simplification — applied only on approval',
      re: /(?<![а-яё])(отрефактор[а-яё]*|рефактор[а-яё]*|почист[а-яё]*\s+код|мертв[а-яё]*\s+код|мёртв[а-яё]*\s+код|дубл[а-яё]*\s+в\s+код|упрост[а-яё]*\s+код)(?![а-яё])|refactor|dead\s+code/i,
    },
    {
      skill: 'improve-react',
      what: 'whole-codebase React audit against a real scanner — read-only report plus plans',
      re: /(?<![а-яё])(аудит[а-яё]*\s+(?:реакт|react)|(?:реакт|react)[а-яё]*\s+аудит|пройдись\s+по\s+(?:реакт|react))|react\s+audit|react\s+doctor/i,
    },
    {
      skill: 'a11y-audit',
      what: 'axe-core sweep plus a keyboard pass; fixes on approval',
      re: /(?<![а-яё])(доступност[а-яё]*|скринридер[а-яё]*|контраст[а-яё]*)(?![а-яё])|a11y|accessibility|aria(?!\w)|screen\s*reader/i,
    },
    {
      skill: 'i18n-audit',
      what: 'hardcoded strings, locale drift, raw or unused keys',
      re: /(?<![а-яё])(локализац[а-яё]*|перевод[а-яё]*|непереведен[а-яё]*|непереведён[а-яё]*|локал[а-яё]*)(?![а-яё])|i18n|untranslated/i,
    },
    {
      skill: 'api-contract-sync',
      what: 'find where client types and the real API disagree; fix the frontend only',
      re: /(?<![а-яё])(контракт[а-яё]*|типы\s+не\s+сход[а-яё]*|бэк\s+отдаёт|бэк\s+отдает|апи\s+отдаёт|апи\s+отдает)(?![а-яё])|openapi|swagger|api\s+(?:returns|contract)\s+/i,
    },
    {
      skill: 'dependency-risk-review',
      what: 'needed at all? health, size, license, alternatives — before a NEW package lands',
      re: /(?<![а-яё])(поставь|установи|добавь|подключи)\s+(?:библиотек|пакет|зависимост|либу)|npm\s+i(?:nstall)?\s+\S|pnpm\s+add\s+\S|yarn\s+add\s+\S|стоит\s+ли\s+(?:брать|тащить)/i,
    },
    {
      skill: 'deps-upgrade',
      what: 'staged upgrade — changelogs, breaking changes, grouped by risk, verified per batch',
      // Each Cyrillic branch closes its own stem: one shared trailing negative lookahead would veto a
      // truncated stem (the one for "dependenc-") the moment a real inflection follows it.
      re: /(?<![а-яё])обнов[а-яё]*\s+(?:зависимост|пакет|библиотек|деп)[а-яё]*|(?<![а-яё])апгрейд[а-яё]*|upgrade\s+(?:deps|dependencies|packages)|bump\s+(?:deps|dependencies)/i,
    },
    {
      skill: 'storybook-stories',
      what: 'CSF3 stories with autodocs and play functions, state coverage planned first',
      re: /(?<![а-яё])(сторибук[а-яё]*|сторис[а-яё]*)(?![а-яё])|storybook|\bstories\b/i,
    },
    {
      skill: 'batch-runner',
      what: 'bounded-context worker per unit for a homogeneous sweep — spec once, state-patched knowledge, free resume',
      re: /(?<![а-яё])(по\s+всем\s+файл[а-яё]*|во\s+всех\s+файл[а-яё]*|в\s+кажд[а-яё]+\s+(?:файл|компонент|модул)[а-яё]*|массов[а-яё]*|батч[а-яё]*)(?![а-яё])|пакетн[а-яё]*\s+(?:обработ|правк|прогон|переимен)[а-яё]*|миграци[а-яё]*\s+по\s+(?:всем|кажд)|across\s+all\s+files|in\s+every\s+(?:file|component)|batch\s+(?:edit|change|update|process)/i,
    },
    {
      skill: 'task-spec-builder',
      what: 'expand a raw batch — tasks, bugs, review remarks verified against code — into TASKS.md with acceptance and verification',
      re: /(?<![а-яё])(вот\s+(?:задачи|правки|список|скрин)|пачк[а-яё]*\s+(?:задач|правок|багов)|список\s+правок|прилетел[а-яё]*\s+правк)|правки\s+с\s+ревью|несколько\s+задач|(?<![а-яё])(?:замечани|комментари|коммент)[а-яё]*\s+(?:с|из|по)\s+ревью|ревьюер[а-яё]*\s+(?:написал|оставил|накидал)/i,
    },
    {
      skill: 'requirements-grilling',
      what: 'reach shared understanding first — decision tree asked in rounds, a recommendation per question',
      re: /(?<![а-яё])(допрос[а-яё]*|допраш[а-яё]*|уточни[а-яё]*\s+(?:всё|все|детал|требован)|задай\s+вопрос[а-яё]*|разбер[а-яё]*\s+по\s+полочк|убедись[^.!?\n]{0,24}(?:понял|поняла)|непонятн[а-яё]*[^.!?\n]{0,20}(?:спроси|уточни))|grill\s*me(?!\w)/i,
    },
    {
      skill: 'project-onboard',
      what: 'materialize .claude/project-profile.md so portable skills act correctly in THIS repo',
      re: /(?<![а-яё])(онбор[а-яё]*|изучи\s+проект|разберись\s+с\s+проектом|проанализируй\s+проект)|onboard/i,
      // "study the project" in a repo that has carried a profile for months is a question about the code, not
      // a request to onboard (it was once offered twice in one day in the same repo). With a profile on disk only
      // the explicit word routes here — the skill also UPDATES a profile. No cwd = unknown = offer.
      unless: (p) => hasProjectProfile(input?.cwd) && !/(?<![а-яё])онбор|onboard/i.test(p),
    },
    {
      skill: 'skill-authoring',
      what: 'invocation axis, information ladder, pruning verdicts for a skill you are about to touch',
      re: /(?<![а-яё])(скилл[а-яё]*)(?![а-яё])|SKILL\.md|\bskills?\b(?=[^.\n]*\b(?:напиши|написать|правь|поправ|audit|write|edit)\b)/i,
    },
    {
      skill: 'config-draft',
      what: "the flow for changing or retiring agent config (rules, skills, hooks, memory) — draft in the user's language → meaning gate → EN final → text gate → proved write",
      // An intent verb NEXT TO the artifact: "skill" alone is a topic, "fix the skill" is a change.
      // Retiring is the same flow run backwards, so its verbs sit in the same list.
      // Pairs with skill-authoring rather than competing — that one holds the quality bar, this one
      // the approval flow, and a prompt that asks to write a skill genuinely wants both.
      // "hook" gets a much tighter gap than the rest: it has to be the verb's own object ("add a hook"),
      // or "write tests for this hook" — a React hook — would route here.
      re: /(?<![а-яё])(?:добав|завед|настро|поправ|обнов|измен|созда|сдела|перепиш|напиш|хочу|нужн|давай|удал|убер|выпил|заархивир|отключ|снес)[а-яё]*(?:[^.!?\n]{0,40}(?:правил(?:о|а|ом|е|у)?(?![а-яё])|скилл[а-яё]*(?![а-яё])|skill|claude\.md)|[^.!?\n]{0,12}(?:хук[а-яё]*(?![а-яё])|hook))/i,
      // The same three words own a frontend meaning. `use[A-Z]` stays case-SENSITIVE on purpose: under
      // /i it also swallows "user", and a rule about user-facing text is this skill's own subject.
      not: [
        /use[A-Z]\w+/,
        /(?<![а-яё])(?:кастомн|реакт)[а-яё]*\s+хук|хук[а-яё]*\s+(?:для|в)\s+(?:компонент|форм|стор)/i,
        /(?<![а-яё])(?:eslint|prettier|stylelint|nginx|iptables|firewall|валидаци)[а-яё]*/i,
        /\.tsx(?![a-z])/i,
      ],
    },
    {
      skill: 'prototype',
      what: 'throwaway code answering ONE design question — UI variants on a route, or a logic harness',
      // "sketch a couple of variants", "how would it look" — the filler between the verb and its object
      // is where the user's real phrasing lives, so the gap is bounded, not forbidden.
      re: /(?<![а-яё])прототип[а-яё]*|(?:накида|скетч|наброс)[а-яё]*[^.!?\n]{0,20}вариант|нескольк[а-яё]*\s+вариант[а-яё]*\s+(?:верстк|дизайн|интерфейс|экран)|как[^.!?\n]{0,14}будет\s+выгляд[а-яё]*|prototype|mockup/i,
    },
    {
      skill: 'resolving-merge-conflicts',
      what: "resolve hunk by hunk by intent traced to each side's source; finish the merge, never abort",
      re: /(?<![а-яё])(конфликт[а-яё]*)(?![а-яё])|merge\s+conflict|rebase\s+conflict|<<<<<<</i,
    },
    {
      skill: 'token-economy',
      what: 'subagent I/O contract, tiered verification, context budget for long multi-step work',
      re: /(?<![а-яё])(контекст\s+(?:кончается|заканчивается|переполн)|многошагов[а-яё]*|сабагент[а-яё]*|субагент[а-яё]*)|too\s+many\s+tokens|context\s+(?:is\s+)?(?:full|bloat)/i,
    },
    {
      skill: 'skill-map',
      what: 'the flow map over every skill — which one fits this situation',
      re: /как(?:ой|ие)\s+скилл|что\s+(?:тут\s+)?(?:применит|использоват)|с\s+чего\s+начат|что\s+у\s+нас\s+есть|which\s+skill/i,
    },
  ];

  if (FAST_LANE.test(prompt)) return null;
  if (ownedElsewhere(prompt)) return null;

  // `not` is how a candidate whose trigger words carry a second, unrelated meaning stays silent on it —
  // an exclusion list per candidate, never a global one, so it cannot mute its neighbours.
  const hits = CANDIDATES.filter(
    (c) => c.re.test(prompt) && !(c.not ?? []).some((r) => r.test(prompt)) && !c.unless?.(prompt),
  );
  if (!hits.length) return null;

  // Three or more matches means the prompt spans several situations — a menu here is noise. That is
  // exactly what the router exists for: it holds the flows and the hand-offs a regex cannot express.
  const body =
    hits.length > 2
      ? `Prompt matches ${hits.length} situations (${hits.map((c) => `agentdeck-kit:${c.skill}`).join(', ')}) — too many to ` +
        'pick blind. Consult the router skill `agentdeck-kit:skill-map` for the flow they belong to, then take the one ' +
        'that fits the actual next step.'
      : 'Situation match — skills that fit this prompt:\n' +
        hits.map((c) => `- \`agentdeck-kit:${c.skill}\` — ${c.what}`).join('\n');

  return (
    `${body}\n` +
    'Judge the fit yourself: take the one that genuinely helps, or none if the work is mechanical ' +
    "(fast lane wins). Taking one → open your reply with ONE line, in the user's language, naming it and what it " +
    'does for this task, so the user learns the tool exists. Taking none → say nothing about it.'
  );
}
