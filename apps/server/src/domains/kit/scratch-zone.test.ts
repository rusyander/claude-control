import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Клон или рабочая копия, которую сессия сама создала (`git worktree add`, `git clone` в
 * транскрипте), — зона агента: удаление, `git clean` и откат внутри неё не требуют «да».
 * Чужой каталог, основной репозиторий, предки cwd и неразобранные переменные спрашивают как
 * раньше. Настоящий файл набора; фикстуры лежат вне temp — temp сам по себе зона агента.
 */

process.env.AGENTDECK_KIT_STATE = mkdtempSync(join(tmpdir(), 'kit-scratch-zone-'));
const HOOKS = join(builtinKitDir(), 'hooks', 'lib');
type Verdict = { decision: string; reason: string } | null;
type Input = Record<string, unknown>;
const guard = (await import(pathToFileURL(join(HOOKS, 'destructive-guard.mjs')).href)) as {
  default: (input: Input) => Verdict;
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), `.scratch-zone-${process.pid}`);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const MAIN = join(ROOT, 'main');
const WT = join(ROOT, 'wt-probe');
const CLONE = join(ROOT, 'clone-probe');
const FOREIGN = join(ROOT, 'foreign');
const NOGIT = join(ROOT, 'nogit');
const URLONLY = join(ROOT, 'upstream-repo');
for (const d of [MAIN, WT, CLONE, FOREIGN, URLONLY])
  mkdirSync(join(d, '.git'), { recursive: true });
mkdirSync(NOGIT, { recursive: true });
const fwd = (p: string): string => p.split('\\').join('/');

const ran = (command: string): object => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: command, name: 'Bash', input: { command } }] },
});
const MADE = [
  ran(`git worktree add --detach "${fwd(WT)}" abc123`),
  ran(`git clone --depth 1 -b main https://example.com/x.git "${fwd(CLONE)}"`),
  ran(`cd "${fwd(ROOT)}" && git clone https://example.com/org/upstream-repo.git`),
  ran(`git worktree add "${fwd(NOGIT)}"`),
  ran(`git worktree add "${fwd(ROOT)}"`), // предок cwd — никогда не зона
  ran('git worktree add $D abc'), // неизвестная переменная — никогда не зона
];
let seq = 0;
const input = (command: string, records: object[] = MADE): Input => {
  const transcript = join(ROOT, `t${++seq}.jsonl`);
  writeFileSync(transcript, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { tool_name: 'Bash', tool_input: { command }, transcript_path: transcript, cwd: MAIN };
};

describe('destructive-guard: клон сессии — зона агента', () => {
  const allowed: [string, string][] = [
    ['файл внутри созданной рабочей копии', `rm -rf "${fwd(WT)}/src/old"`],
    ['сама созданная рабочая копия', `rm -rf "${fwd(WT)}"`],
    [
      'созданный клон с ключами -b / --depth',
      `rm -rf "${fwd(CLONE)}/node_modules" "${fwd(CLONE)}/dist"`,
    ],
    ['клон только по адресу после cd', `rm -rf "${fwd(URLONLY)}"`],
    ['git -C <копия> clean -fdx', `git -C "${fwd(WT)}" clean -fdx`],
    ['git -C <копия> checkout -- .', `git -C "${fwd(WT)}" checkout -- .`],
    ['cd <копия> && git restore .', `cd "${fwd(WT)}" && git restore .`],
  ];
  it.each(allowed)('без вопроса: %s', (_name, command) => {
    expect(guard.default(input(command))).toBeNull();
  });

  const asked: [string, string][] = [
    ['git clean в cwd (основной репозиторий)', 'git clean -fd'],
    ['git checkout -- . в cwd', 'git checkout -- .'],
    ['каталог, которого сессия не создавала', `rm -rf "${fwd(FOREIGN)}/src"`],
    ['основной репозиторий', `rm -rf "${fwd(MAIN)}/src"`],
    ['предок созданной копии', `rm -rf "${fwd(ROOT)}"`],
    ['выход из копии через ..', `rm -rf "${fwd(WT)}/../foreign"`],
    ['созданный каталог без своего .git', `rm -rf "${fwd(NOGIT)}"`],
    ['своя копия и чужой путь вместе', `rm -rf "${fwd(WT)}/a" "${fwd(FOREIGN)}/b"`],
    ['git -C <чужой> clean -fdx', `git -C "${fwd(FOREIGN)}" clean -fdx`],
    ['clean в копии и в cwd вместе', `git -C "${fwd(WT)}" clean -fd && git clean -fd`],
    ['цель с неразобранной переменной', 'rm -rf "$D/src"'],
  ];
  it.each(asked)('спрашивает: %s', (_name, command) => {
    expect(guard.default(input(command))?.decision).toBe('deny');
  });

  it('без команды создания в транскрипте тот же rm спрашивает', () => {
    expect(guard.default(input(`rm -rf "${fwd(WT)}/src/old"`, []))?.decision).toBe('deny');
  });
});

/**
 * Клон, который сделал `review-plan.mjs plan` (метка `.git/review-plan-scratch.json`), — тоже
 * зона агента, хотя команды `git clone` в транскрипте нет: клон делает node-вызов РОДИТЕЛЬСКОЙ
 * сессии, а у подагента-рецензента свой транскрипт (живой ложный отказ 26.10, `git checkout --`
 * после пробы в клоне). Плохая метка, метка в cwd, его предке или там, откуда клон, — как раньше.
 */
const REVIEW = join(ROOT, 'claude-review', 'review-docs-x', 'clone');
const REVIEW_SUB = join(REVIEW, 'inst-docs-ui');
const BADMARK = join(ROOT, 'bad-mark');
const SELFMARK = join(ROOT, 'self-mark');
const NOHEAD = join(ROOT, 'no-head-mark');
const MARKED_CWD = join(ROOT, 'marked-cwd');
const LINK_TARGET = join(ROOT, 'link-target');
const TMPQ = '/c/Users/x/AppData/Local/Temp/q';
const mark = (dir: string, body: string): void => {
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'abc123\n');
  writeFileSync(join(dir, '.git', 'review-plan-scratch.json'), body);
};
mark(REVIEW, JSON.stringify({ source: MAIN, head: 'abc123', links: [], deps: 'none' }));
mkdirSync(join(REVIEW_SUB, 'scripts'), { recursive: true });
mark(BADMARK, '{"source": ');
mark(SELFMARK, JSON.stringify({ source: SELFMARK, head: 'abc123' }));
mark(NOHEAD, JSON.stringify({ source: MAIN }));
mark(MARKED_CWD, JSON.stringify({ source: MAIN, head: 'abc123' }));
mkdirSync(join(MARKED_CWD, 'sub'), { recursive: true });
mkdirSync(LINK_TARGET, { recursive: true });
symlinkSync(LINK_TARGET, join(REVIEW, 'linked'), 'junction');
const LIVE = (dir: string): string =>
  `C="${fwd(dir)}"; cd "$C" && sed -i '285s/a/b/' content/uz/agents/builder.mdx && node scripts/check_content.mjs 2>&1 | tail -4; git checkout -- content/uz/agents/builder.mdx; git status --short`;

describe('destructive-guard: клон review-plan — зона агента по метке', () => {
  const allowed: [string, string][] = [
    ['живой вызов рецензента: C=…; cd "$C" … git checkout -- файл', LIVE(REVIEW_SUB)],
    ['git -C <клон> clean -fdx', `git -C "${fwd(REVIEW)}" clean -fdx`],
    ['git -C <клон> checkout -- .', `git -C "${fwd(REVIEW)}" checkout -- .`],
    ['rm -rf файла пробы в клоне', `rm -rf "${fwd(REVIEW_SUB)}/scripts/check.probe.mjs"`],
  ];
  it.each(allowed)('без вопроса: %s', (_name, command) => {
    expect(guard.default(input(command, []))).toBeNull();
  });

  const asked: [string, string][] = [
    ['метка с битым JSON', `git -C "${fwd(BADMARK)}" checkout -- .`],
    ['метка, где source — сам каталог', `git -C "${fwd(SELFMARK)}" checkout -- .`],
    ['метка без head', `git -C "${fwd(NOHEAD)}" checkout -- .`],
    ['каталог без метки', `git -C "${fwd(FOREIGN)}" checkout -- .`],
    ['неразобранная переменная', 'cd "$D" && git checkout -- .'],
    [
      'переменную переназначили на чужое',
      `C="${fwd(REVIEW)}"; C="${fwd(FOREIGN)}"; cd "$C" && git checkout -- .`,
    ],
    ['переменную назначили после cd', `cd "$C"; C="${fwd(REVIEW)}"; git checkout -- .`],
    ['переменная из закрытой подоболочки', `(C="${fwd(REVIEW)}"); cd "$C" && git checkout -- .`],
    ['rm после голого cd', `cd "${fwd(REVIEW)}" && cd; rm -rf x`],
    // Временный каталог — зона сам по себе: дыры разбора каталога видны на нём.
    ['rm после голого cd из temp', `cd "${TMPQ}" && cd; rm -rf proj`],
    ['rm после cd - из temp', `cd "${TMPQ}" && cd -; rm -rf proj`],
    ['rm после popd из temp', `pushd "${TMPQ}" && popd; rm -rf proj`],
    ['cd по переменной, назначенной после него', `cd "$C"; C="${TMPQ}"; rm -rf proj`],
    ['переменная temp из закрытой подоболочки', `(C="${TMPQ}"); rm -rf "$C/proj"`],
    ['голый cd после клона уводит домой', `cd "${fwd(REVIEW)}" && cd && git checkout -- .`],
    ['cd - после клона', `cd "${fwd(REVIEW)}" && cd - && git checkout -- .`],
    ['popd после клона', `pushd "${fwd(REVIEW)}" && popd && git checkout -- .`],
    ['rm -rf через ссылку из клона наружу', `rm -rf "${fwd(REVIEW)}/linked/data"`],
    ['предок клона', `rm -rf "${fwd(join(ROOT, 'claude-review'))}"`],
  ];
  it.each(asked)('спрашивает: %s', (_name, command) => {
    expect(guard.default(input(command, []))?.decision).toBe('deny');
  });

  it('метка в самом cwd или в его предке — не зона', () => {
    const at = (cwd: string, command: string): Input => ({ ...input(command, []), cwd });
    expect(guard.default(at(MARKED_CWD, 'git checkout -- .'))?.decision).toBe('deny');
    expect(guard.default(at(join(MARKED_CWD, 'sub'), 'git checkout -- .'))?.decision).toBe('deny');
    expect(
      guard.default(at(join(MARKED_CWD, 'sub'), `rm -rf "${fwd(MARKED_CWD)}/sub/x"`))?.decision,
    ).toBe('deny');
  });

  /**
   * Каталог после `cd X` — X, только если `cd` точно исполнился и удался: дальше по той же цепочке
   * `&&`, или X есть на диске и `cd` не стоит в ветке `||`, после `&&` или в теле `if`. Иначе
   * `cd /tmp/x; rm -rf *` судился во временном, а исполнялся в прежнем каталоге — в копии.
   */
  const CD_TMP = mkdtempSync(join(tmpdir(), 'kit-cd-base-'));
  afterAll(() => rmSync(CD_TMP, { recursive: true, force: true }));
  const HERE = fwd(CD_TMP);
  const GONE = `${HERE}/missing`;

  describe('destructive-guard: каталог после cd X; — только если cd точно удался', () => {
    const allowed: [string, string][] = [
      ['cd в существующий temp; rm', `cd "${HERE}"; rm -rf build`],
      ['cd в несуществующий && rm — rm только после удачного cd', `cd "${GONE}" && rm -rf build`],
      ['cd в существующий || exit; rm', `cd "${HERE}" || exit 1; rm -rf build`],
      ['a && cd && rm — одна цепочка', `mkdir -p x && cd "${GONE}" && rm -rf build`],
      ['if cd X; then rm; fi — X есть', `if cd "${HERE}"; then rm -rf build; fi`],
      [
        'cd после закрытого if и цикла',
        `if true; then :; fi; for f in a; do :; done; cd "${HERE}"; rm -rf build`,
      ],
      ['cd в клон; git checkout -- .', `cd "${fwd(REVIEW)}"; git checkout -- .`],
    ];
    it.each(allowed)('без вопроса: %s', (_name, command) => {
      expect(guard.default(input(command, []))).toBeNull();
    });

    const asked: [string, string][] = [
      ['cd в несуществующий; rm', `cd "${GONE}"; rm -rf *`],
      ['cd в несуществующий || true; rm', `cd "${GONE}" || true; rm -rf build`],
      ['cd в ветке ||', `true || cd "${HERE}"; rm -rf build`],
      ['cd после && и ;', `test -d x && cd "${HERE}"; rm -rf build`],
      ['cd в теле if', `if false; then cd "${HERE}"; fi; rm -rf build`],
      ['cd глубже в теле if', `if false; then :; cd "${HERE}"; fi; rm -rf build`],
      ['a || cd X && rm', `true || cd "${HERE}" && rm -rf build`],
      [
        'cd в несуществующий каталог клона; git clean',
        `cd "${fwd(REVIEW)}/missing"; git clean -fd`,
      ],
      ['cd в клон в ветке ||; git checkout', `true || cd "${fwd(REVIEW)}"; git checkout -- .`],
    ];
    it.each(asked)('спрашивает: %s', (_name, command) => {
      expect(guard.default(input(command, []))?.decision).toBe('deny');
    });
  });
});
