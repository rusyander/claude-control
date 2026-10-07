// Module of the prompt dispatcher (one node start per prompt for every hint). Contract:
// (input, prompt) → string | null.
// Global hint (UserPromptSubmit): the bar is named before the first read of anything, on the words
// the user actually types. Two branches, because two different bars get dropped:
//   · "check this" → the check must be able to go red (PROJ-944: a parity script reported 200/200
//     while printing four misses of its own making);
//   · "review this" / "run it live" → how much checking the change has earned is COMPUTED, not felt.
//     Without it the effort drifts both ways: a copy fix gets a two-hour protocol, an RBAC change
//     gets a glance. The full procedures arrive from rule-injector at their trigger; this is the
//     one line that makes sure the command is known before the work starts.

export default function verifyHardHint(input, prompt) {
  if (!prompt) return null;

  // Russian stays Russian: a translated trigger fires on nothing the user actually types.
  //
  // A REQUEST, not a stem. The bare Russian stem for "check" hit 25 of 109 recorded prompts and eleven
  // of them asked for nothing: a noun ("checks are closed"), a past tense ("what you did not check"),
  // someone else's action ("the panel will check"), a negation, a purpose clause ("so as to check").
  // What is left is the imperative addressed to me, or an infinitive under a word of need. \b is useless
  // on Cyrillic without the u flag, hence the explicit letter-class lookarounds.
  const NOT_NEGATED = '(?<!(?<![а-яё])не\\s+)';
  const WANTS_CHECK = new RegExp(
    [
      `${NOT_NEGATED}(?<![а-яёa-z])(?:пере)?провер(?:ь|ьте|им|яй|яйте)(?![а-яё])`,
      '(?<![а-яё])(?:нужно|надо|нужен|можешь|сможешь|хочу|давай|стоит|пора)\\s+(?:\\S+\\s+){0,3}?(?:пере)?проверить',
      `${NOT_NEGATED}(?<![а-яё])свер(?:ь|ьте|им)(?![а-яё])`,
      '(?<![а-яё])убедись',
      '(?<![а-яё])удостоверься',
      'точно ли',
      '\\bverify\\b',
      '\\bdouble-?check\\b',
    ].join('|'),
    'i',
  );
  // The second half of REVIEW is the review that never says the word: `deep-review` takes a branch or a
  // working tree as readily as an MR, and "look at my branch" / "check the edits" — its own description
  // — matched nothing here. The verb is required in front, so "apply the edits" stays out.
  // The bare noun "review" is out for the same reason as the bare "check": "edits from the review" is a batch of remarks
  // to FIX (task-spec-builder), not a review to run.
  const WANTS_REVIEW = new RegExp(
    [
      '(?<![а-яё])(?:от|за|по|про)ревью',
      '(?<![а-яё])(?:сделай|сделать|проведи|провести|запусти|нужно|нужен|надо|давай|хочу)\\s+(?:\\S+\\s+){0,2}?ревью',
      '(?<![а-яё])ревью\\s+(?:мр|mr|ветк|кода|правок|изменени|дифф|!\\d+)',
      '\\breview\\s+(?:this|the|my|our)\\b',
      '\\bcode\\s*review\\b',
      '(?<![а-яё])(?:посмотри|глянь|прогляди|проверь|оцени|вычитай)\\s+(?:\\S+\\s+)?(?:мр|mr|!\\d+|дифф|diff|пул|код)(?![а-яё])',
      '(?<![а-яё])(?:посмотри|глянь|прогляди|проверь|оцени)\\s+(?:мо[июя]\\s+|эти\\s+|наши\\s+|сво[июя]\\s+)?(?:ветк|правк|изменени|дифф)',
    ].join('|'),
    'i',
  );
  const WANTS_LIVE =
    /живь[её]м|жив(?:ую|ой|ая)\s+проверк|на\s+стенде|(?<![а-яё])прог(?:они|оним|нать)|e2e\b|playwright|в\s+браузере|открой\s+стенд/i;
  // A prompt ABOUT the rules is config work. The request that asked to tighten these very rules named
  // "review" and "live check" five times and asked for neither; it goes to `config-draft`, and the
  // procedures still arrive from rule-injector if a review or a run really starts.
  const CONFIG_TALK =
    /(?<![а-яё])(?:правил[аоуе]?(?:м|ми|х)?|скилл[а-яё]*|хук[а-яё]*|инжектор[а-яё]*)(?![а-яё])|\b(?:hooks?|skills?|CLAUDE\.md|rule-injector)\b/i;
  const CONFIG_VERB =
    /(?<![а-яё])(?:сделай|сделать|поправ|добав|допиш|ужесточ|строж|строг|измени|перепиш|обнов|заведи|убери|удали)/i;
  if (CONFIG_TALK.test(prompt) && CONFIG_VERB.test(prompt)) return null;

  const out = [];
  if (WANTS_CHECK.test(prompt)) {
    out.push(
      'A check was asked for — run the hard one. It must be able to go red: before trusting a green run, feed it ' +
        'a value that must fail. Data against a specification runs both directions — everything the spec demands is ' +
        'present, AND everything the artifact changed was authorised, the allowed set built from exactly the rows ' +
        'that grant permission. Report what the run printed, never a number from memory; a non-zero missing/skipped/' +
        'unparsed count is a failure. Detail: skill agentdeck-kit:situational-rules → verification-depth.',
    );
  }
  if (WANTS_REVIEW.test(prompt) || WANTS_LIVE.test(prompt)) {
    out.push(
      'Review or live run asked for — decide the depth before starting, do not feel it: ' +
        '`node <kit>/tools/risk-tier.mjs` prints T0/T1/T2 with the markers that produced it, and the blast radius under it — ' +
        'one review verdict per printed consumer, one positive walk per printed entry point, anything over the cap named as not covered. T2 also owes ' +
        '`node <kit>/tools/mustfail.mjs --cmd "<tests>"` (a file whose revert leaves the suite green is untested), ' +
        'two review entry points rather than two copies of one pass, and two live variations — delay one of N ' +
        'requests · a role without the right · empty state · bad input. Procedures: skill agentdeck-kit:situational-rules → review-depth, live-check.',
    );
  }

  return out.length ? out.join(' ') : null;
}
