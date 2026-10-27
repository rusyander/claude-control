// autonomous-pick — PreToolUse on AskUserQuestion in an autonomous panel run WITHOUT the panel's
// permission broker: full access (`bypassPermissions`) attaches no broker, and in `-p` a question there
// came back as the error «Answer questions?» and the run stood until the human typed. The broker
// answers every other autonomous run itself (routes/chat/run-routes: `recommendedPicks`), so this
// module stays silent wherever the broker is attached — two answerers would race.
//
// Picks exactly what the panel's `recommendedPicks` (domains/chat/auto-pick/auto-pick.ts) picks:
// every question needs an option recommended in its label or description (ru/en, a negation in the two
// words before it cancels the mark), and that option must not ask the human to act or claim the human
// already did (`needsHuman`, domains/chat/group-questions). One question fails → silence, the call goes
// to the human as before. The deny text is `autonomousPickMessage` (contracts/chat-group-settings)
// byte for byte: the panel recognises the pick by its marker and lines. A server test runs both sides
// over one corpus. Text over the dispatcher cap (1200) would be cut and the lines lost → silence.
//
// The SAME file lives in the panel kit (assets/kit/agentdeck-kit/hooks/lib/) and in ~/.claude/hooks/lib/;
// `tools/kit-twins.mjs` turns the build red when the two drift.

const MARKER = 'agentdeck:autonomous-pick';
const CAP = 1200;

const RECOMMEND_WORD =
  '(?:recommended|recommend|рекомендую|рекомендуем|рекомендуется|рекомендовано|рекомендован[аоы]?|рекомендуемый)';
const NEGATION =
  "(?:(?<![\\p{L}])(?:не|not|never|no)|n't)\\s+(?:(?!(?:but|yet|though|although|however|но|однако|зато|а)(?![\\p{L}']))[\\p{L}']+\\s+){0,2}";
const RECOMMENDED = new RegExp(`(?<![\\p{L}])(?<!${NEGATION})${RECOMMEND_WORD}(?![\\p{L}])`, 'iu');

const HUMAN_ACTION_RU =
  /(?<![\p{L}])(?<!(?:не|без)\s)(?:я|мы|(?:за|пере)?логин(?:ил|юсь|усь)\p{L}*|авторизовал\p{L}*|вош[её]л|вошла|вошли|войду|зайду|заш[её]л|зашла|обновил\p{L}*|обновлю|перезапустил\p{L}*|запустил\p{L}*|запущу|сделал\p{L}*|сделаю|подтверждаю|подтвердил\p{L}*|пришлю|прислал\p{L}*|выдам|выдал\p{L}*|дам|дал[аи]?|добавлю|настрою|настроил\p{L}*|проверю|исправлю|поправлю|подожд\p{L}*|жди|ждать|жду|вручную|руками|готово)(?![\p{L}])/iu;
const HUMAN_ACTION_EN =
  /\b(?:we'(?:ll|ve)|me|my|myself|logged\s+in|signed\s+in|re-?logged|wait\s+for\s+me|manually|by\s+hand|done|(?:is|are|was|were|been|has\s+been|have\s+been)\s+(?:updated|refreshed|renewed|fixed|restarted|done)|already\s+(?:ran|run|did|done|logged|signed|updated|refreshed|restarted))\b/i;
const HUMAN_ACTION_EN_CASED = /\bI(?:['’](?:ll|ve|m|d))?(?![\w/.])|\bi['’](?:ll|ve|m|d)\b/;
const HUMAN_RESOURCE =
  '(?:sessions?|logins?|tokens?|credentials|creds|cookies?|passwords?|keys?|secrets?|access|permissions?|auth|accounts?|vpn|stand|certs?|certificates?|2fa|mfa|otp|licen[cs]es?|quotas?' +
  '|сесси\\p{L}*|логин\\p{L}*|токен\\p{L}*|ключ\\p{L}*|парол\\p{L}*|доступ\\p{L}*|прав[аоы]?|куки|секрет\\p{L}*|уч[её]тк\\p{L}*|аккаунт\\p{L}*|стенд\\p{L}*|сертификат\\p{L}*|лицензи\\p{L}*|квот\\p{L}*)';
const HUMAN_STATE =
  '(?:updated|refreshed|renewed|restarted|fixed|rotated|granted|restored|reset|reissued|extended|unlocked' +
  '|(?:обновл[её]н|перезапущен|исправлен|выдан|продл[её]н|восстановлен|сброшен|разблокирован)[аоы]?)';
const HUMAN_CLAIMED_STATE = new RegExp(
  '(?:^|[\\n—–:;,.!?(]|\\s-\\s)\\s*(?:(?!(?:keep|mark|leave|make|get|set|treat|consider|have|use|with|without|оставь\\p{L}*|остав\\p{L}*|пометь\\p{L}*|помет\\p{L}*|сделай\\p{L}*|используй\\p{L}*|использ\\p{L}*)(?![\\p{L}]))[\\p{L}\\d-]+\\s+)?' +
    `${HUMAN_RESOURCE}(?:\\s+(?!(?:not|no|never|yet|не|без|ещё|еще)(?![\\p{L}]))[\\p{L}\\d:-]+){0,2}\\s+${HUMAN_STATE}(?![\\p{L}])`,
  'iu',
);
const CRITICAL = /^\s*\[?critical\]?\s*$/i;

const textOf = (option) =>
  `${typeof option.label === 'string' ? option.label : ''}\n${typeof option.description === 'string' ? option.description : ''}`;

export function needsHuman(option) {
  const text = textOf(option);
  return (
    HUMAN_ACTION_RU.test(text) ||
    HUMAN_ACTION_EN.test(text) ||
    HUMAN_ACTION_EN_CASED.test(text) ||
    HUMAN_CLAIMED_STATE.test(text)
  );
}

export function recommendedIndex(options) {
  const byLabel = options.findIndex(
    (o) => typeof o.label === 'string' && RECOMMENDED.test(o.label),
  );
  if (byLabel >= 0) return byLabel;
  return options.findIndex(
    (o) => typeof o.description === 'string' && RECOMMENDED.test(o.description),
  );
}

/** The panel's `recommendedPicks`: one pick per question, or null when any question has none. */
export function recommendedPicks(input) {
  const questions = input?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const picks = [];
  for (const raw of questions) {
    if (typeof raw?.question !== 'string') return null;
    const options = (Array.isArray(raw.options) ? raw.options : []).filter(
      (o) => Boolean(o) && typeof o.label === 'string',
    );
    const chosen = options[recommendedIndex(options)];
    if (!chosen || needsHuman(chosen)) return null;
    picks.push({
      question: raw.question,
      label: String(chosen.label),
      critical: typeof raw.header === 'string' && CRITICAL.test(raw.header),
    });
  }
  return picks;
}

/** contracts `autonomousPickMessage`, byte for byte. */
export function pickMessage(picks) {
  return [
    `${MARKER}: this chat runs autonomously — the owner pre-approved the ` +
      'recommended options. Do not ask again; take these answers, state the pick in one line ' +
      'and continue:',
    ...picks.map((p) => `- ${JSON.stringify(p.question)} → ${JSON.stringify(p.label)}`),
  ].join('\n');
}

export default function autonomousPick(input) {
  if (String(input?.tool_name ?? '') !== 'AskUserQuestion') return null;
  if (process.env.AGENTDECK_AUTONOMOUS !== '1') return null;
  // The broker answers wherever it is attached; only full access runs without it.
  if (input?.permission_mode !== 'bypassPermissions') return null;
  const picks = recommendedPicks(input.tool_input);
  if (!picks) return null;
  const reason = pickMessage(picks);
  return reason.length <= CAP ? { decision: 'deny', reason } : null;
}
