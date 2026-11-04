import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Карточка правила держит и правку скриптом. Звено g9 (26.10) после сжатия правило
 * пакета не читало: семнадцать правок UI ушли через `cat > /tmp/x.mjs <<'EOF' …
 * fs.writeFileSync(p, s) … EOF` + `node /tmp/x.mjs`, а запрет карточки смотрел только
 * на `file_path` у Edit/Write. Скрипт по пути — законный путь (так велит сам
 * inline-edit-guard), поэтому файлы, которые он пишет, судятся как правка этих файлов:
 * правило не прочитано — тот же отказ с карточкой, прочитано — проходит.
 * Через диспетчер `run.mjs`, как его зовёт hooks.json.
 */

const KIT = builtinKitDir();
const DISPATCH = join(KIT, 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-script-card-'));
const STATE = join(dir, 'state');
// Копия вне временного каталога: правка во временном — черновик, правило о UI её не касается.
const copy = mkdtempSync(join(process.cwd(), 'node_modules', '.kit-script-card-'));
mkdirSync(join(copy, '.git'), { recursive: true });
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(copy, { recursive: true, force: true });
});

const CHILD = { AGENTDECK_STEP_KIND: 'implement' };
const ENV = {
  ...process.env,
  AGENTDECK_KIT_VARIANT: '',
  AGENTDECK_KIT_STATE: STATE,
  ...CHILD,
};

type HookOut = {
  hookSpecificOutput?: {
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};
function hook(event: string, payload: object): HookOut {
  const out = spawnSync(process.execPath, [DISPATCH, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: ENV,
    timeout: 15_000,
  }).stdout.trim();
  return event === 'pre' && out ? (JSON.parse(out) as HookOut) : {};
}
const ctx = (o: HookOut) => o.hookSpecificOutput?.additionalContext ?? '';
const reason = (o: HookOut) => o.hookSpecificOutput?.permissionDecisionReason ?? '';
const denied = (o: HookOut) => o.hookSpecificOutput?.permissionDecision === 'deny';

let n = 0;
function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}
const turn = (name: string, input: object, body = 'ok') => {
  const id = `tu${++n}`;
  return [
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body }] },
    },
  ];
};
const empty = transcript(turn('Bash', { command: 'ls' }));

const RULE_FILE = join(KIT, 'skills', 'situational-rules', 'references', 'visible-fix-shots.md');
const FULL = readFileSync(RULE_FILE, 'utf8')
  .trim()
  .split('<kit>')
  .join(resolve(KIT).split('\\').join('/'));
const UI = 'inst-admin-ui/src/pages/users/CreateRolePage/index.tsx';

const call = (session: string, tool: string, input: object, tp = empty) => ({
  hook_event_name: 'PreToolUse',
  session_id: session,
  transcript_path: tp,
  cwd: copy,
  tool_name: tool,
  tool_input: input,
});
const bash = (session: string, command: string, tp = empty) =>
  hook('pre', call(session, 'Bash', { command }, tp));
const edit = (session: string, file = join(copy, UI), tp = empty) =>
  hook('pre', call(session, 'Edit', { file_path: file, old_string: 'a', new_string: 'b' }, tp));

/** Этап до сжатия: правка UI получила правило целиком, затем PreCompact снял отметки. */
function compacted(session: string) {
  const first = edit(session);
  expect(denied(first)).toBe(false);
  expect(ctx(first)).toContain(FULL);
  hook('precompact', {
    hook_event_name: 'PreCompact',
    session_id: session,
    transcript_path: empty,
  });
}
/** Отказ карточки с файлом правила целиком, как у правки того же файла. */
const fedDeny = (o: HookOut) =>
  denied(o) &&
  /^rule-card: this call needs visible-fix-shots \(.*full text .*attached to this deny/s.test(
    reason(o),
  ) &&
  ctx(o).includes(FULL);

// Команда g9 20:13:19Z (C:\work\acme-worktrees\feat-PROJ-55-rbac-ui), тело скрипта сокращено.
const G9 = [
  "cat > /tmp/crp.mjs <<'EOF'",
  "import fs from 'node:fs';",
  `const p = '${UI}';`,
  "let s = fs.readFileSync(p, 'utf8');",
  "const rep = (a, b) => { if (!s.includes(a)) throw new Error('miss: ' + a.slice(0, 60)); s = s.replace(a, b); };",
  "rep(`import { getMissingPermissions } from '@features/auth';`,",
  "`import { getMissingPermissions, PERMISSION } from '@features/auth';`);",
  'fs.writeFileSync(p, s);',
  'EOF',
  `node /tmp/crp.mjs && git diff --stat ${UI}`,
].join('\n');
// Команда g9 20:17:58Z: путь собран из `base + 'файл'`.
const G9_JOINED = [
  "cat > /tmp/sk.mjs <<'EOF'",
  "import fs from 'node:fs';",
  "const edit = (p, pairs) => { let s = fs.readFileSync(p, 'utf8'); for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error(p + ' miss'); s = s.replace(a, b); } fs.writeFileSync(p, s); };",
  "const base = 'inst-admin-ui/src/features/skills/ui/SkillForm/';",
  "edit(base + 'SkillForm.tsx', [[`  tools,`, `  tools,\n  toolsDeniedReason,`]]);",
  'EOF',
  'node /tmp/sk.mjs && sed -n 10,26p inst-admin-ui/src/features/skills/ui/SkillForm/SkillForm.tsx',
].join('\n');

describe('rule-injector: правка скриптом под той же карточкой, что и Edit', () => {
  it('g9: heredoc-скрипт + node по пути после сжатия — тот же отказ с файлом правила, что у Edit', () => {
    compacted('kscript-g9-a');
    const viaScript = bash('kscript-g9-a', G9);
    expect(fedDeny(viaScript), JSON.stringify(viaScript)).toBe(true);
    // Повтор проходит: отказ нёс правило целиком и снял запрет.
    expect(denied(bash('kscript-g9-a', G9))).toBe(false);
    // Та же правка через Edit в такой же сессии — та же причина отказа.
    compacted('kscript-g9-b');
    expect(reason(edit('kscript-g9-b'))).toBe(reason(viaScript));
  });

  it('путь из `base + файл` и `cd` перед запуском судятся по настоящему файлу', () => {
    compacted('kscript-join');
    expect(fedDeny(bash('kscript-join', G9_JOINED))).toBe(true);
    compacted('kscript-cd');
    const inPkg = [
      "cat > /tmp/cd.mjs <<'EOF'",
      "import fs from 'node:fs';",
      "fs.writeFileSync('src/pages/A/index.tsx', 'x');",
      'EOF',
      'cd inst-admin-ui && node /tmp/cd.mjs',
    ].join('\n');
    expect(fedDeny(bash('kscript-cd', inPkg))).toBe(true);
  });

  it('готовый скрипт в черновом месте, запущенный по пути, — тот же отказ', () => {
    const script = join(dir, 'scratchpad', 'fix.mjs');
    mkdirSync(join(dir, 'scratchpad'), { recursive: true });
    writeFileSync(
      script,
      `import fs from 'node:fs';\nconst p = ${JSON.stringify(join(copy, UI).split('\\').join('/'))};\nfs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('a', 'b'));\n`,
    );
    compacted('kscript-file');
    expect(fedDeny(bash('kscript-file', `node "${script.split('\\').join('/')}"`))).toBe(true);
  });

  it('встроенный код, пропущенный повтором inline-edit-guard, — тот же отказ карточки', () => {
    const command = `node -e "require('fs').writeFileSync('${UI}', 'x')"`;
    const refused = transcript(
      turn('Bash', { command }, 'PreToolUse:Bash hook error: [ctx-guard] inline-edit-guard: …'),
    );
    compacted('kscript-inline');
    expect(fedDeny(bash('kscript-inline', command, refused))).toBe(true);
  });

  it('правило прочитано после сжатия — скрипт проходит; черновик, чтение и инструмент проекта — без отказа', () => {
    compacted('kscript-read');
    const read = transcript(turn('Read', { file_path: RULE_FILE.split('\\').join('/') }));
    expect(denied(bash('kscript-read', G9, read))).toBe(false);
    compacted('kscript-free');
    const scratchOnly = G9.split(`const p = '${UI}'`).join("const p = '/tmp/out.tsx'");
    expect(
      denied(bash('kscript-free', scratchOnly.split(` && git diff --stat ${UI}`).join(''))),
    ).toBe(false);
    const readOnly = G9.split('fs.writeFileSync(p, s);').join('console.log(s.length);');
    expect(denied(bash('kscript-free', readOnly))).toBe(false);
    // `cd` в черновое место: относительный путь скрипта пишет туда же — черновик.
    const inScratch = [
      "cat > /tmp/p.mjs <<'EOF'",
      "import fs from 'node:fs';",
      "fs.writeFileSync('x.tsx', 'x');",
      'EOF',
      'cd /tmp/probe && node /tmp/p.mjs',
    ].join('\n');
    expect(denied(bash('kscript-free', inScratch))).toBe(false);
    // Инструмент проекта, запущенный по пути, не вскрывается: его правки — не правка скриптом.
    mkdirSync(join(copy, 'tools'), { recursive: true });
    writeFileSync(
      join(copy, 'tools', 'build.mjs'),
      "import fs from 'node:fs';\nfs.writeFileSync('src/App.tsx', 'x');\n",
    );
    expect(denied(bash('kscript-free', 'node tools/build.mjs'))).toBe(false);
  });

  it('скрипт пишет тест-файл — правило о способе проверки едет с вызовом, как у Edit', () => {
    const DEPTH = readFileSync(
      join(KIT, 'skills', 'situational-rules', 'references', 'verification-depth.md'),
      'utf8',
    )
      .trim()
      .split('<kit>')
      .join(resolve(KIT).split('\\').join('/'));
    // Не UI-файл: правило о снимках не делит с ним потолок вызова.
    const testFile = 'svc/handlers_test.go';
    const s = 'kscript-test';
    for (let i = 0; i < 3; i += 1) edit(s, join(copy, testFile));
    hook('precompact', { hook_event_name: 'PreCompact', session_id: s, transcript_path: empty });
    const script = G9.split(UI).join(testFile);
    expect(ctx(bash(s, script))).toContain(DEPTH);
    // Тест-файл в черновом месте — проба, а не тест: правила нет.
    const probe = G9.split(UI).join('/tmp/probe_test.go');
    expect(ctx(bash('kscript-probe', probe))).not.toMatch(/# Verification depth/);
  });

  it('путь из `base + файл` решает, какое правило нужно: файл хука под карточкой hook-authoring', () => {
    const HOOK_FULL = readFileSync(
      join(KIT, 'skills', 'situational-rules', 'references', 'hook-authoring.md'),
      'utf8',
    )
      .trim()
      .split('<kit>')
      .join(resolve(KIT).split('\\').join('/'));
    const s = 'kscript-hook';
    edit(s, join(copy, '.claude', 'hooks', 'guard.mjs'));
    hook('precompact', { hook_event_name: 'PreCompact', session_id: s, transcript_path: empty });
    const joined = [
      "cat > /tmp/h.mjs <<'EOF'",
      "import fs from 'node:fs';",
      "const base = '.claude/hooks/';",
      "fs.writeFileSync(base + 'guard.mjs', 'export default () => null;\\n');",
      'EOF',
      'node /tmp/h.mjs',
    ].join('\n');
    const o = bash(s, joined);
    expect(denied(o)).toBe(true);
    expect(reason(o)).toMatch(/^rule-card: this call needs hook-authoring \(/);
    expect(ctx(o)).toContain(HOOK_FULL);
  });

  // Перенаправление оболочки в исходник — та же правка файла, что и Edit: та же карточка.
  const REDIRECTS: [string, string][] = [
    ['cat >', `cat > ${UI} <<'EOF'\nexport const A = 1;\nEOF`],
    ['cat >>', `cat >> ${UI} <<'EOF'\nexport const B = 2;\nEOF`],
    ['tee', `echo 'export const A = 1;' | tee ${UI}`],
    ['tee -a', `echo 'export const B = 2;' | tee -a ${UI} > /dev/null`],
    ['printf >', `printf '%s\\n' 'export const A = 1;' > ${UI}`],
    ['echo > в кавычках', `echo 'export const A = 1;' > "${UI}"`],
    [
      'cd, затем echo >>',
      `cd inst-admin-ui && echo 'export const B = 2;' >> src/pages/A/index.tsx`,
    ],
  ];
  it.each(REDIRECTS)(
    'перенаправление `%s` в UI-файл после сжатия — тот же отказ, что у Edit',
    (form, command) => {
      // Имя сессии — без знаков формы: `cat >` и `cat >>` сводятся к одному файлу состояния.
      const s = `kredirect-${REDIRECTS.findIndex(([f]) => f === form)}`;
      compacted(s);
      const o = bash(s, command);
      expect(fedDeny(o), JSON.stringify(o)).toBe(true);
    },
  );

  it('перенаправление в /dev/null, дескриптор, черновик и журнал проверки — без отказа', () => {
    compacted('kredirect-free');
    for (const command of [
      'ls > /dev/null 2>&1',
      'ls src 2>&1 | tee /dev/null',
      'ls >&2',
      `cat > /tmp/x.tsx <<'EOF'\nexport const A = 1;\nEOF`,
      'ls src > .agent/tmp/ls.tsx 2>&1',
      'ls src > out.log 2>&1',
      // `cd` в черновое место: относительная цель — тоже черновик.
      "cd /tmp/probe && echo 'export const A = 1;' > a.tsx",
    ])
      expect(denied(bash('kredirect-free', command)), command).toBe(false);
  });
});
