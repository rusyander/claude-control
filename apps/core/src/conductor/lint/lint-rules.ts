import type { LintRule } from '@agentdeck/contracts/core/user-layer';

/**
 * Данные линта запуска (06:121-129, G-h): фразы слоя человека, которые просят сессию сделать то,
 * что в AgentDeck делает ядро, и что ядро делает вместо этого. Правила — данные: английские и
 * русские формулировки, команды в коде (`gh pr create`) — тоже. Линт только показывает: ни одно
 * решение ядра не читает его итог (P36) — проза никогда не разбирается для решений (00:127).
 */

export interface LintRuleDef {
  rule: Exclude<LintRule, 'frontmatter-key'>;
  /** Регулярные выражения без флага `g` (одна строка — одно совпадение на правило). */
  patterns: readonly RegExp[];
  instead: string;
}

const W = 'iu';

export const PROCESS_RULES: readonly LintRuleDef[] = [
  {
    rule: 'push',
    patterns: [
      new RegExp(String.raw`\bgit\s+push\b`, W),
      new RegExp(String.raw`\bpush\s+(?:the\s+|your\s+)?(?:branch|changes|commits?|code)\b`, W),
      new RegExp(
        String.raw`\bpush\s+(?:it\s+)?to\s+(?:origin|the\s+remote|remote|github|gitlab)\b`,
        W,
      ),
      // `\b` в JS — только ASCII: у кириллицы граница слова — «не буква» (`\p{L}`).
      new RegExp(String.raw`(?:^|[^\p{L}])(?:за)?пуш(?:ни|ить|ь|ай|им|у)(?![\p{L}])`, W),
      new RegExp(String.raw`(?:сделай|выполни)\s+push\b`, W),
    ],
    instead:
      'The core publishes: it pushes the unit branch after the final gate; a session cannot push.',
  },
  {
    rule: 'mr',
    patterns: [
      new RegExp(
        String.raw`\b(?:open|create|raise|submit|file)\s+(?:a\s+|an\s+|the\s+)?(?:draft\s+)?(?:merge\s+request|pull\s+request|MR|PR)\b`,
        W,
      ),
      new RegExp(String.raw`\b(?:gh\s+pr|glab\s+mr)\s+create\b`, W),
      new RegExp(
        String.raw`(?:созда[йть]+|откр[оы]й|открыть|оформи|заведи)\s+(?:MR|PR|мр|пр|мерж-?реквест|пулл?-?реквест)`,
        W,
      ),
    ],
    instead:
      'The core opens the MR/PR itself at the publish step (draft or ready per the scenario).',
  },
  {
    rule: 'ci-wait',
    patterns: [
      new RegExp(
        String.raw`\bwait\s+(?:for|until)\s+(?:the\s+)?(?:ci|pipeline|pipelines|checks?|build|actions)\b`,
        W,
      ),
      new RegExp(
        String.raw`\b(?:gh\s+run\s+watch|gh\s+pr\s+checks|glab\s+ci\s+(?:status|view))\b`,
        W,
      ),
      new RegExp(
        String.raw`(?:дожд[иаё]|жди|ждать|подожди)[\p{L}]*\s+(?:[\p{L}]+\s+){0,2}(?:ci|пайплайн|сборк|проверок|ci-)`,
        W,
      ),
    ],
    instead:
      'The core waits for CI only when the human asked for it on this task (ciWait); a session never polls CI.',
  },
  {
    rule: 'whole-suite',
    patterns: [
      new RegExp(
        String.raw`\brun\s+(?:all\s+(?:the\s+)?tests|the\s+(?:whole|entire|full)\s+(?:test\s+)?suite|the\s+full\s+tests?)\b`,
        W,
      ),
      new RegExp(String.raw`\b(?:whole|entire|full)\s+test\s+suite\b`, W),
      new RegExp(
        String.raw`(?:прогони|запусти|прогнать|запустить)\s+(?:все|весь|полный)\s+(?:тесты|набор|прогон)`,
        W,
      ),
    ],
    instead:
      'The core runs the required checks through its queue at the gates; checks inside a step stay narrow.',
  },
  {
    rule: 'merge',
    patterns: [
      new RegExp(
        String.raw`\bmerge\s+(?:the\s+|this\s+|your\s+)?(?:mr|pr|merge\s+request|pull\s+request)\b`,
        W,
      ),
      new RegExp(String.raw`\b(?:gh\s+pr|glab\s+mr)\s+merge\b`, W),
      new RegExp(
        String.raw`(?:смерж|смёрж|смердж|влей|слей)[\p{L}]*\s+(?:MR|PR|мр|пр|ветку|реквест)`,
        W,
      ),
    ],
    instead: 'Nothing is merged from a session; merging is the human decision.',
  },
  {
    rule: 'approve',
    patterns: [
      new RegExp(
        String.raw`\bapprove\s+(?:the\s+|this\s+|your\s+(?:own\s+)?|my\s+|its\s+)?(?:mr|pr|merge\s+request|pull\s+request|changes)\b`,
        W,
      ),
      new RegExp(String.raw`\b(?:gh\s+pr\s+review\s+[^\n]*--approve|glab\s+mr\s+approve)\b`, W),
      new RegExp(String.raw`(?:заапрув|апрувн|одобри)[\p{L}]*`, W),
    ],
    instead: 'Approvals are human; the core never approves a merge request.',
  },
];

export const FRONTMATTER_INSTEAD =
  'The core reads only agentdeck.steps from a skill frontmatter; this key changes nothing.';
