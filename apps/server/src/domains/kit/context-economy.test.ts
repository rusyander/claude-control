import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Экономия окна в шаге задачи ядра (AGENTDECK_STEP_KIND, не `chat`) — через диспетчер `run.mjs`, как его
 * зовёт hooks.json: карточка правила ≥ 4k в следующих шагах той же копии и запрет до чтения правила.
 * Строка [batch] после серии Bash-чтений — одна для человека и шага. Сессия человека — как была.
 */

// AGENTDECK_KIT_UNDER_TEST — копия набора для прогона «красный до» против старого кода; без неё — встроенный.
const KIT = process.env.AGENTDECK_KIT_UNDER_TEST || builtinKitDir();
const DISPATCH = join(KIT, 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-context-economy-'));
const STATE = join(dir, 'state');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CHILD = { AGENTDECK_STEP_KIND: 'implement' };
const HUMAN = { AGENTDECK_STEP_KIND: '' };

type HookOut = {
  hookSpecificOutput?: {
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};

function hook(event: string, payload: object, env: Record<string, string>): HookOut {
  const out = spawnSync(process.execPath, [DISPATCH, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_STEP_KIND: '',
      AGENTDECK_KIT_STATE: STATE,
      ...env,
    },
    timeout: 15_000,
  }).stdout.trim();
  return out ? (JSON.parse(out) as HookOut) : {};
}

let n = 0;
type Use = { type: 'tool_use'; id: string; name: string; input: object };
const use = (name: string, input: object): Use => ({
  type: 'tool_use',
  id: `tu${++n}`,
  name,
  input,
});
const turn = (uses: Use[], bodies: string[] = []) => {
  const id = `msg${++n}`;
  return [
    ...uses.map((u) => ({ type: 'assistant', message: { id, role: 'assistant', content: [u] } })),
    {
      type: 'user',
      message: {
        role: 'user',
        content: uses.map((u, i) => ({
          type: 'tool_result',
          tool_use_id: u.id,
          content: bodies[i] ?? 'ok',
        })),
      },
    },
  ];
};
function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}
const ctx = (o: HookOut) => o.hookSpecificOutput?.additionalContext ?? '';
const denied = (o: HookOut) => o.hookSpecificOutput?.permissionDecision === 'deny';

describe('batch-nudge: серия Bash-чтений — строка после вызова', () => {
  // Подталкивание до вызова и потолок чтения оболочкой были ветками звена группы — сняты вместе с
  // группами разделения. Строка post-any одна для сессии человека и шага задачи ядра.
  it('post-any: три Bash-чтения подряд — строка [batch] и у человека, и в шаге задачи', () => {
    const bash = Array.from({ length: 3 }, (_, i) =>
      turn([use('Bash', { command: `cat f${i}.txt` })]),
    ).flat();
    const payload = (s: string) => ({
      hook_event_name: 'PostToolUse',
      session_id: s,
      transcript_path: transcript(bash),
      cwd: dir,
      tool_name: 'Bash',
      tool_input: { command: 'cat f2.txt' },
      tool_response: { stdout: 'x' },
    });
    expect(ctx(hook('post-any', payload('kposthuman01'), HUMAN))).toMatch(/\[batch\]/);
    expect(ctx(hook('post-any', payload('kpoststep001'), CHILD))).toMatch(/\[batch\]/);
  });

  it('pre больше не шлёт [batch] и не отказывает одиночному чтению оболочкой', () => {
    const reads = Array.from({ length: 10 }, (_, i) =>
      turn([use('Read', { file_path: `C:/repo/src/a${i}.ts` })], [`body ${i}`]),
    ).flat();
    const tp = transcript(reads);
    for (const env of [HUMAN, CHILD]) {
      const out = hook(
        'pre',
        {
          hook_event_name: 'PreToolUse',
          session_id: 'kprenobatch1',
          transcript_path: tp,
          cwd: dir,
          tool_name: 'Read',
          tool_input: { file_path: 'C:/repo/src/other.ts' },
        },
        env,
      );
      expect(ctx(out)).not.toMatch(/\[batch\]/);
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    }
  });
});

describe('rule-injector: правило ≥ 4k в следующем этапе той же копии — карточка', () => {
  const copy = join(dir, 'copyA');
  const other = join(dir, 'copyB');
  for (const r of [copy, other]) mkdirSync(join(r, '.git'), { recursive: true });
  const ask = (session: string, command: string, cwd: string, env: Record<string, string>) =>
    ctx(
      hook(
        'pre',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
          session_id: session,
          transcript_path: '',
          cwd,
        },
        env,
      ),
    );

  it('этап 1 — целиком, этап 2 той же копии — карточка с окнами разделов, другая копия — целиком', () => {
    const first = ask('kcopystage01', 'pytest tests/ -q', copy, CHILD);
    expect(first).toMatch(/# Verification depth/);
    expect(first.length).toBeGreaterThan(1000);
    // g5 25.10 (K3): прогон проверки карточку verification-depth не несёт — правило о том, как
    // писать тест; карточка приходит с правкой тест-файла.
    expect(ask('kcopystage02', 'pytest tests/ -q', copy, CHILD)).not.toMatch(/Verification depth/);
    const later = ctx(
      hook(
        'pre',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: join(copy, 'a.test.ts'), old_string: 'a', new_string: 'b' },
          session_id: 'kcopystage02',
          transcript_path: '',
          cwd: copy,
        },
        CHILD,
      ),
    );
    expect(later).toMatch(/earlier step in this copy/);
    expect(later.length).toBeLessThanOrEqual(1000);
    expect(later).toMatch(/offset=\d+ limit=\d+/);
    expect(ask('kcopyother01', 'pytest tests/ -q', other, CHILD)).not.toMatch(/card \(task step/);
  });

  it('правило короче 4k — целиком в каждом этапе; сессия человека — целиком', () => {
    const a = ask('kcopysmall01', 'docker run --rm hello-world', copy, CHILD);
    const b = ask('kcopysmall02', 'docker run --rm hello-world', copy, CHILD);
    expect(a.length).toBeGreaterThan(1000);
    expect(b).toBe(a);
    expect(ask('kcopyhuman01', 'pytest tests/ -q', copy, HUMAN)).not.toMatch(/card \(task step/);
  });
});

/**
 * Карточка экономит токены, только если звено НЕ прочтёт правило, а не прочесть его —
 * и есть потеря качества (владелец, 25.10). Поэтому вызов, ради которого пришла
 * карточка, отказывается, пока сессия не прочла раздел правила целиком (раздел вида
 * правленого файла; после сжатия — прочтение после него). Правила о способе проверки
 * (verification-depth, live-check) не отказывают: текст целиком едет с вызовом, вызов
 * проходит (g5 25.10, K4 — отказ правки `_test.go` и тот же текст через 13 с).
 */
describe('rule-injector: карточка не пропускает свой вызов до чтения правила', () => {
  const copy = join(dir, 'copyGate');
  mkdirSync(join(copy, '.git'), { recursive: true });
  const call = (session: string, tp: string, extra: object = {}, cwd = copy) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'pytest tests/ -q' },
    session_id: session,
    transcript_path: tp,
    cwd,
    ...extra,
  });
  const reason = (o: HookOut) => o.hookSpecificOutput?.permissionDecisionReason ?? '';
  const empty = transcript(turn([use('Bash', { command: 'ls' })]));
  // Окно по умолчанию — раздел «The substitution boundary» (строки 35–42): раздел вида тест-файла.
  const readOf = (
    file: string,
    before: object[] = [],
    after: object[] = [],
    window = { offset: 35, limit: 8 },
  ) => transcript([...before, ...turn([use('Read', { file_path: file, ...window })]), ...after]);

  // Аудит g0 F-05 (25.10): отказ → Read → повтор стоил два хода на карточку. Теперь сам отказ
  // несёт файл правила целиком (в additionalContext: причина режется до CAP.pre) и снимает
  // запрет — повтор проходит без отдельного чтения.
  const RULE_FILE = join(KIT, 'skills', 'situational-rules', 'references', 'verification-depth.md');
  // Файл как он лежит на диске, с `<kit>`, раскрытым в корень набора (так его отдаёт диспетчер).
  const KIT_ROOT = resolve(KIT).split('\\').join('/');
  const asDelivered = (file: string) =>
    readFileSync(file, 'utf8').trim().split('<kit>').join(KIT_ROOT);
  const FULL = asDelivered(RULE_FILE);
  const fed = (o: HookOut, full = FULL) =>
    denied(o) &&
    /^rule-card: .*full text .*attached to this deny/s.test(reason(o)) &&
    ctx(o).includes(full) &&
    !/\[truncated/.test(ctx(o)) &&
    !/card \(task step/.test(ctx(o));
  // Правило о способе проверки: файл целиком в контексте, вызов НЕ отказан.
  const rides = (o: HookOut, full = FULL) =>
    !denied(o) &&
    ctx(o).includes(full) &&
    !/\[truncated/.test(ctx(o)) &&
    !/card \(task step/.test(ctx(o));
  const testFile = join(copy, 'src', 'a.test.ts');
  const lookup = (s: string) =>
    call(s, empty, { tool_name: 'Read', tool_input: { file_path: testFile } });
  const editTest = (s: string, tp = empty) =>
    call(s, tp, {
      tool_name: 'Edit',
      tool_input: { file_path: testFile, old_string: 'a', new_string: 'b' },
    });

  it('этап 2: правка тест-файла несёт файл правила целиком и проходит; прогон — без карточки', () => {
    expect(denied(hook('pre', call('kgatestage01', empty), CHILD))).toBe(false);
    const run = hook('pre', call('kgatestage02', empty), CHILD);
    expect(denied(run)).toBe(false);
    expect(ctx(run)).not.toMatch(/Verification depth/);
    expect(rides(hook('pre', editTest('kgatestage02'), CHILD))).toBe(true);
    const again = hook('pre', editTest('kgatestage02'), CHILD);
    expect(denied(again)).toBe(false);
    expect(ctx(again)).not.toContain(FULL);
  });

  it('карточку взвёл Read тест-файла → правка несёт файл и проходит; повтор — без второй копии', () => {
    const armed = hook('pre', lookup('kgatelookup1'), CHILD);
    expect(denied(armed)).toBe(false);
    expect(ctx(armed)).toMatch(/card \(task step/);
    expect(rides(hook('pre', editTest('kgatelookup1'), CHILD))).toBe(true);
    const again = hook('pre', editTest('kgatelookup1'), CHILD);
    expect(denied(again)).toBe(false);
    expect(ctx(again)).not.toContain(FULL);
    // Взведённая карточка не отказывает чистому прогону проверки и не прикладывает к нему файл.
    hook('pre', lookup('kgatelookup2'), CHILD);
    const run = hook('pre', call('kgatelookup2', empty), CHILD);
    expect(denied(run)).toBe(false);
    expect(ctx(run)).not.toContain(FULL);
  });

  it('карточку снимает только раздел вида файла целиком: обрывок раздела — файл едет снова', () => {
    hook('pre', lookup('kgatereadit1'), CHILD);
    const whole = hook('pre', editTest('kgatereadit1', readOf(RULE_FILE)), CHILD);
    expect(denied(whole)).toBe(false);
    expect(ctx(whole)).not.toContain(FULL);
    // 6 строк из 8 раздела — обрывок; раздел «The budget ladder» (5–34) к тест-файлу не относится.
    for (const [s, window] of [
      ['kgatereadit2', { offset: 35, limit: 6 }],
      ['kgatereadit3', { offset: 5, limit: 30 }],
    ] as const) {
      hook('pre', lookup(s), CHILD);
      expect(
        rides(hook('pre', editTest(s, readOf(RULE_FILE, [], [], window)), CHILD)),
        JSON.stringify(window),
      ).toBe(true);
    }
  });

  it('параллельный вызов той же пачки — без отказа и без второй копии текста', () => {
    const s = 'kgatesiblng1';
    hook('pre', lookup(s), CHILD);
    mkdirSync(join(STATE, 'rules'), { recursive: true });
    writeFileSync(join(STATE, 'rules', `rule-fed-verification-depth-${s}`), '1');
    const sibling = hook('pre', editTest(s), CHILD);
    expect(denied(sibling)).toBe(false);
    expect(ctx(sibling)).not.toContain(FULL);
    expect(denied(hook('pre', editTest(s), CHILD))).toBe(false);
  });

  // F-06: review-depth запрещает только ПУБЛИКАЦИЮ ревью; чтение обсуждений и ответ в тред —
  // карточка без отказа. review-publish-guard выключен своим выключателем: он отказал бы
  // публикации раньше (нет deep-review, нет свежего чтения тредов) и спрятал бы карточный запрет.
  it('review-depth: чтение MR — карточка без отказа, публикация треда — отказ с файлом целиком', () => {
    const rev = join(dir, 'copyReview');
    mkdirSync(join(rev, '.git'), { recursive: true });
    const REVIEW_FULL = asDelivered(
      join(KIT, 'skills', 'situational-rules', 'references', 'review-depth.md'),
    );
    const env = { ...CHILD, AGENTDECK_KIT_REVIEW_GUARD: '0' };
    const mcp = (s: string, tool: string, server = 'gitlab') =>
      hook(
        'pre',
        {
          hook_event_name: 'PreToolUse',
          session_id: s,
          transcript_path: empty,
          cwd: rev,
          tool_name: `mcp__${server}__${tool}`,
          tool_input: { project_id: 'g/p', merge_request_iid: '7' },
        },
        env,
      );
    // Этап 1 копии: forge-protocol и review-depth вместе не помещаются в потолок — второе
    // правило откладывается до следующего такого вызова (а не обрезается), потом приходит целиком.
    const stage1 = mcp('kgatereview0', 'mr_discussions');
    expect(ctx(stage1)).not.toMatch(/# Review depth/);
    expect(ctx(mcp('kgatereview0', 'mr_discussions'))).toContain(REVIEW_FULL);
    const disc = mcp('kgatereview1', 'mr_discussions');
    expect(denied(disc)).toBe(false);
    expect(ctx(disc)).toMatch(/# Review depth.*card \(task step/);
    expect(denied(mcp('kgatereview1', 'get_merge_request_diffs'))).toBe(false);
    expect(denied(mcp('kgatereview1', 'create_merge_request_discussion_note'))).toBe(false);
    const thread = mcp('kgatereview1', 'create_merge_request_thread');
    expect(fed(thread, REVIEW_FULL)).toBe(true);
    expect(denied(mcp('kgatereview1', 'create_merge_request_thread'))).toBe(false);
    mcp('kgatereview2', 'get_pull_request_diff', 'github');
    const gh = mcp('kgatereview2', 'create_pull_request_review', 'github');
    expect(denied(gh) && ctx(gh).includes(REVIEW_FULL)).toBe(true);
  });

  it('файл правила, который едет с вызовом, идёт первым; не поместившееся откладывается, не режется', () => {
    // docker-shared стоит в порядке правил раньше verification-depth: без приоритета он
    // занял бы место, и файл карточки не поместился бы.
    const live = join(dir, 'copyOrder');
    mkdirSync(join(live, '.git'), { recursive: true });
    const bash = (s: string, command: string) =>
      hook(
        'pre',
        {
          hook_event_name: 'PreToolUse',
          session_id: s,
          transcript_path: empty,
          cwd: live,
          tool_name: 'Bash',
          tool_input: { command },
        },
        CHILD,
      );
    // risk-tier выбирает глубину проверки — это не «чистый прогон», правило с ним едет.
    const depth = 'node tools/risk-tier.mjs src';
    bash('kgateorder01', depth); // этап 1: verification-depth целиком, копия помечена
    const cmd = `docker run --rm hello-world && ${depth}`;
    const both = bash('kgateorder02', cmd);
    expect(rides(both)).toBe(true);
    expect(ctx(both)).not.toMatch(/# Docker/i);
    const repeat = bash('kgateorder02', cmd);
    expect(denied(repeat)).toBe(false);
    expect(ctx(repeat)).toMatch(/^# .*docker/im);
  });

  it('два файла карточек не помещаются в потолок — второй оставляет строку Read, без обрезки', () => {
    // published-text (4.2k) + review-depth (6.4k) > PAYLOAD_MAX: первый идёт целиком, второй —
    // строкой «Read …» в причине отказа; следующий повтор приносит его целиком, затем вызов проходит.
    const rev = join(dir, 'copyBudget');
    mkdirSync(join(rev, '.git'), { recursive: true });
    const env = { ...CHILD, AGENTDECK_KIT_REVIEW_GUARD: '0' };
    const mcp = (s: string, tool: string) =>
      hook(
        'pre',
        {
          hook_event_name: 'PreToolUse',
          session_id: s,
          transcript_path: empty,
          cwd: rev,
          tool_name: `mcp__gitlab__${tool}`,
          tool_input: { project_id: 'g/p', merge_request_iid: '7' },
        },
        env,
      );
    const REVIEW_FULL = asDelivered(
      join(KIT, 'skills', 'situational-rules', 'references', 'review-depth.md'),
    );
    const PUBLISHED_FULL = asDelivered(
      join(KIT, 'skills', 'situational-rules', 'references', 'published-text.md'),
    );
    // Этап 1 копии: каждое правило приходит целиком хотя бы раз (copy помечена для обоих).
    for (let i = 0; i < 3; i += 1) mcp('kgatebudget0', 'create_merge_request_thread');
    // Обе карточки взведены до публикации: review-depth — чтением тредов, published-text —
    // записью в хранилище карточек (у набора нет вызова-чтения, который взвёл бы её без отказа).
    mcp('kgatebudget1', 'mr_discussions');
    const store = join(STATE, 'rules', 'rule-cards-kgatebudget1.json');
    const armed = JSON.parse(readFileSync(store, 'utf8')) as Record<string, object>;
    expect(Object.keys(armed)).toEqual(['review-depth']);
    const PUBLISHED = join(KIT, 'skills', 'situational-rules', 'references', 'published-text.md');
    writeFileSync(
      store,
      JSON.stringify({ ...armed, 'published-text': { file: PUBLISHED, head: '# Published text' } }),
    );
    const draft = mcp('kgatebudget1', 'create_draft_note');
    expect(denied(draft)).toBe(true);
    // published-text идёт в порядке правил первым и помещается; review-depth — строкой Read.
    expect(ctx(draft)).toContain(PUBLISHED_FULL);
    expect(ctx(draft)).not.toContain(REVIEW_FULL);
    expect(ctx(draft)).not.toMatch(/\[truncated/);
    expect(reason(draft)).toMatch(/Read \S*review-depth\.md\b/);
    expect(reason(draft)).not.toMatch(/needs review-depth .*attached to this deny/);
    expect(fed(mcp('kgatebudget1', 'create_draft_note'), REVIEW_FULL)).toBe(true);
    expect(denied(mcp('kgatebudget1', 'create_draft_note'))).toBe(false);

    // g5 25.10: строку Read правила, не влезшего целиком, четыре параллельных Edit несли каждый
    // (~650 знаков на отказ). Параллельный вызов той же пачки — ссылка на неё, без второй копии.
    mcp('kgatebudget2', 'mr_discussions');
    const store2 = join(STATE, 'rules', 'rule-cards-kgatebudget2.json');
    const armed2 = JSON.parse(readFileSync(store2, 'utf8')) as Record<string, object>;
    writeFileSync(
      store2,
      JSON.stringify({
        ...armed2,
        'published-text': { file: PUBLISHED, head: '# Published text' },
      }),
    );
    writeFileSync(join(STATE, 'rules', 'rule-open-review-depth-kgatebudget2'), '1');
    const parallel = mcp('kgatebudget2', 'create_draft_note');
    expect(denied(parallel)).toBe(true);
    expect(reason(parallel)).toMatch(
      /needs review-depth \(\S+\).*parallel call in this same batch/s,
    );
    expect(reason(parallel)).not.toMatch(/Read \S*review-depth\.md \(the section covering/);
  });

  // Аудит звена g9 (26.10): CLI шлёт пачку потоком и зовёт хук каждого вызова по готовности его блока —
  // 2-й..N-й вызовы пачки написаны вслепую, и каждый получал тот же отказ (47 отказов в 21 пачке).
  // Отказ теперь только первому вызову пачки (то же message.id в транскрипте), соседи проходят с пометкой.
  it('пачка: отказ только первому вызову, сосед по пачке проходит с пометкой, следующая пачка — снова отказ', () => {
    const rev = join(dir, 'copyBatch');
    mkdirSync(join(rev, '.git'), { recursive: true });
    const env = { ...CHILD, AGENTDECK_KIT_REVIEW_GUARD: '0' };
    const tp = join(dir, `batch${++n}.jsonl`);
    writeFileSync(tp, '');
    const input = { project_id: 'g/p', merge_request_iid: '7' };
    // Запись вызова появляется в транскрипте до его хука — так CLI пишет пачку.
    const mcp = (s: string, tool: string, msg?: string) => {
      const id = `tub${++n}`;
      const name = `mcp__gitlab__${tool}`;
      if (msg)
        writeFileSync(
          tp,
          `${readFileSync(tp, 'utf8')}${JSON.stringify({ type: 'assistant', message: { id: msg, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })}\n`,
        );
      const payload = {
        hook_event_name: 'PreToolUse',
        session_id: s,
        transcript_path: tp,
        cwd: rev,
      };
      return hook('pre', { ...payload, tool_name: name, tool_input: input, tool_use_id: id }, env);
    };
    for (let i = 0; i < 3; i += 1) mcp('kgatebatch00', 'create_merge_request_thread');
    mcp('kgatebatch01', 'mr_discussions');
    const store = join(STATE, 'rules', 'rule-cards-kgatebatch01.json');
    const PUBLISHED = join(KIT, 'skills', 'situational-rules', 'references', 'published-text.md');
    writeFileSync(
      store,
      JSON.stringify({
        ...(JSON.parse(readFileSync(store, 'utf8')) as Record<string, object>),
        'published-text': { file: PUBLISHED, head: '# Published text' },
      }),
    );
    // Первый вызов: published-text едет целиком, review-depth не помещается — строка Read.
    const first = mcp('kgatebatch01', 'create_draft_note', 'msg_batch_a');
    expect(denied(first)).toBe(true);
    expect(reason(first)).toMatch(/Read \S*review-depth\.md\b/);
    expect(reason(first)).toMatch(/Later calls of this same batch are let through/);
    const second = mcp('kgatebatch01', 'create_draft_note', 'msg_batch_a');
    expect(denied(second), reason(second)).toBe(false);
    expect(ctx(second)).toMatch(/review-depth — an earlier call of this same batch was refused/);
    // Новая пачка — новый вывод модели: запрет на месте, пока правило не прочитано.
    const next = mcp('kgatebatch01', 'create_draft_note', 'msg_batch_b');
    expect(denied(next)).toBe(true);
    expect(reason(next)).toMatch(/review-depth/);
  });

  // Тот же аудит: после сжатия файл карточек переживает PreCompact, отметка — нет; вызов вёз текст
  // правила (проход 1) и тут же карточку того же правила (проход 2) — повтор в одну миллисекунду.
  it('после сжатия взведённая карточка везёт текст целиком и не шлёт карточку рядом', () => {
    // published-text (4.2k): рядом с ним карточка помещается в потолок — у verification-depth (7k,
    // сам потолок) проход 2 откладывал бы её и прятал повтор.
    const s = 'kgatefeed001';
    const PUBLISHED = join(KIT, 'skills', 'situational-rules', 'references', 'published-text.md');
    mkdirSync(join(STATE, 'rules'), { recursive: true });
    writeFileSync(join(STATE, 'rules', `rule-published-text-${s}.sent`), '1');
    writeFileSync(
      join(STATE, 'rules', `rule-cards-${s}.json`),
      JSON.stringify({ 'published-text': { file: PUBLISHED, head: '# Published text' } }),
    );
    // PreCompact печатает текст, не JSON — зовём его в обход разбора ответа.
    spawnSync(process.execPath, [DISPATCH, 'precompact'], {
      input: JSON.stringify({ hook_event_name: 'PreCompact', session_id: s, cwd: copy }),
      encoding: 'utf8',
      env: { ...process.env, AGENTDECK_KIT_VARIANT: '', AGENTDECK_KIT_STATE: STATE, ...CHILD },
      timeout: 15_000,
    });
    expect(readFileSync(join(STATE, 'rules', `rule-cards-${s}.json`), 'utf8')).toMatch(
      /published-text/,
    );
    // Публикация без git-guard и без review-depth: заведение задачи в трекере.
    const commit = hook(
      'pre',
      call(s, empty, {
        tool_name: 'mcp__gitlab__create_issue',
        tool_input: { project_id: 'g/p', title: 'x' },
      }),
      { ...CHILD, AGENTDECK_KIT_REVIEW_GUARD: '0' },
    );
    expect(fed(commit, asDelivered(PUBLISHED)), JSON.stringify(commit).slice(0, 400)).toBe(true);
    expect(reason(commit)).not.toMatch(/parallel call in this same batch/);
    // Поданный текст ставит отметку: иначе следующий вызов снова вёз бы текст или карточку.
    expect(existsSync(join(STATE, 'rules', `rule-published-text-${s}.stamp`))).toBe(true);
  });

  it('сессия человека в той же копии — без карточки и без отказа', () => {
    const human = hook('pre', call('kgatehuman01', empty), HUMAN);
    expect(denied(human)).toBe(false);
    expect(ctx(human)).not.toMatch(/card \(task step/);
  });

  it('карточка после сжатия: чтение до границы не в счёт, после — снимает отказ', () => {
    const other = join(dir, 'copyGate2');
    mkdirSync(join(other, '.git'), { recursive: true });
    const s = 'kgatecompact';
    hook('pre', call(s, empty, {}, other), CHILD);
    // PreCompact пишет текст, не JSON: вывод не нужен, нужен сброс отметок.
    spawnSync(process.execPath, [DISPATCH, 'precompact'], {
      input: JSON.stringify({
        hook_event_name: 'PreCompact',
        session_id: s,
        transcript_path: empty,
      }),
      env: {
        ...process.env,
        AGENTDECK_KIT_VARIANT: '',
        AGENTDECK_KIT_STATE: STATE,
        ...CHILD,
      },
      timeout: 15_000,
    });
    const boundary = {
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
    };
    // Чтение до границы сжатия не в счёт: правка несёт файл целиком; повтор — без второй копии.
    const resend = hook('pre', editTest(s, readOf(RULE_FILE, [], [boundary])), CHILD);
    expect(rides(resend)).toBe(true);
    const again = hook('pre', editTest(s), CHILD);
    expect(denied(again)).toBe(false);
    expect(ctx(again)).not.toContain(FULL);
  });

  it('после сжатия чтение правила после границы снимает отказ без вложения', () => {
    const other = join(dir, 'copyGate3');
    mkdirSync(join(other, '.git'), { recursive: true });
    hook('pre', call('kgatecompac2', empty, {}, other), CHILD);
    const s = 'kgatecompac3';
    const boundary = {
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
    };
    const after = hook(
      'pre',
      call(
        s,
        readOf(RULE_FILE, [boundary]),
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(other, 'a.test.ts'), old_string: 'a', new_string: 'b' },
        },
        other,
      ),
      CHILD,
    );
    expect(denied(after)).toBe(false);
    expect(ctx(after)).toMatch(/card \(task step/);
  });
});

/**
 * g5 25.10 (K3): Read 6 строк раздела i18n снял карточку для шести правок `.mdx`, о которых
 * раздел молчит. Карточку снимает только окно, целиком покрывающее раздел вида правленого
 * файла; без правленого файла (публикация) — любой раздел целиком, но не обрывок.
 */
describe('rule-injector: карточку снимает раздел вида файла целиком, не любое окно', () => {
  const REFS = join(KIT, 'skills', 'situational-rules', 'references');
  const REVIEW = join(REFS, 'review-depth.md');
  const REVIEW_FULL = readFileSync(REVIEW, 'utf8')
    .trim()
    .split('<kit>')
    .join(resolve(KIT).split('\\').join('/'));
  const rev = join(dir, 'copySection');
  mkdirSync(join(rev, '.git'), { recursive: true });
  const env = { ...CHILD, AGENTDECK_KIT_REVIEW_GUARD: '0' };
  const mcp = (s: string, tool: string, tp: string) =>
    hook(
      'pre',
      {
        hook_event_name: 'PreToolUse',
        session_id: s,
        transcript_path: tp,
        cwd: rev,
        tool_name: `mcp__gitlab__${tool}`,
        tool_input: { project_id: 'g/p', merge_request_iid: '7' },
      },
      env,
    );
  const empty = transcript(turn([use('Bash', { command: 'ls' })]));
  const readWin = (offset: number, limit: number) =>
    transcript(turn([use('Read', { file_path: REVIEW, offset, limit })]));

  it('публикация ревью: обрывок раздела — отказ с файлом; раздел целиком — проходит без файла', () => {
    mcp('ksection0000', 'mr_discussions', empty);
    mcp('ksection0000', 'mr_discussions', empty); // этап 1: review-depth целиком, копия помечена
    mcp('ksection0001', 'mr_discussions', empty); // этап 2: карточка взведена
    const part = mcp('ksection0001', 'create_merge_request_thread', readWin(29, 5));
    expect(denied(part)).toBe(true);
    expect(ctx(part)).toContain(REVIEW_FULL);
    mcp('ksection0002', 'mr_discussions', empty);
    const whole = mcp('ksection0002', 'create_merge_request_thread', readWin(29, 11));
    expect(denied(whole)).toBe(false);
    expect(ctx(whole)).not.toContain(REVIEW_FULL);
  });

  it('needOf: правка .mdx — раздел о документах; нет такого — файл целиком; без файла — любой раздел', async () => {
    const lib = (await import(
      pathToFileURL(join(KIT, 'hooks', 'lib', 'rule-injector.mjs')).href
    )) as { needOf: (file: string, input: object) => number[][] | null };
    const rule = join(dir, 'sections.md');
    writeFileSync(
      rule,
      '# Frontend\nlead\n## Code standards\na\nb\n## i18n & toasts\nc\n## Docs prose\nd\ne\n## Misc\nevery .mdx page\n',
    );
    const edit = (file_path: string) => ({ tool_name: 'Edit', tool_input: { file_path } });
    // «Docs prose» — по заголовку, «Misc» — по расширению в теле раздела.
    expect(lib.needOf(rule, edit('docs/page.mdx'))).toEqual([
      [8, 10],
      [11, 12],
    ]);
    expect(lib.needOf(rule, edit('src/x.css'))).toEqual([[1, 12]]);
    expect(lib.needOf(rule, { tool_name: 'Bash', tool_input: { command: 'git commit' } })).toEqual([
      [3, 5],
      [6, 7],
      [8, 10],
      [11, 12],
    ]);
  });
});

/**
 * Размещение документа решается для НОВОГО файла (аудит g9 26.10: 7 из 47 отказов — правки уже
 * лежащего .agent/PROGRESS.md сразу после сжатия), а отчёт звена ревью в `.agent/tmp/` и заметка во
 * временном каталоге — не документы (rbac-ui:63, g9 #250: lane-A2.md получил карточный запрет).
 */
describe('rule-injector: doc-classification — новый документ, не черновик и не уже лежащий файл', () => {
  // Копия вне временного каталога: всё, что во временном, — черновик, правило его не касается.
  const copy = mkdtempSync(join(process.cwd(), 'node_modules', '.kit-doc-place-'));
  mkdirSync(join(copy, '.git'), { recursive: true });
  mkdirSync(join(copy, '.agent'), { recursive: true });
  afterAll(() => rmSync(copy, { recursive: true, force: true }));
  const reason = (o: HookOut) => o.hookSpecificOutput?.permissionDecisionReason ?? '';
  const write = (s: string, file_path: string, tool = 'Write') =>
    hook(
      'pre',
      {
        hook_event_name: 'PreToolUse',
        session_id: s,
        transcript_path: transcript(turn([use('Bash', { command: 'ls' })])),
        cwd: copy,
        tool_name: tool,
        tool_input: { file_path, content: '# x\n', old_string: 'a', new_string: 'b' },
      },
      CHILD,
    );
  const placement = (o: HookOut) => /# Doc placement/.test(ctx(o));

  it('уже лежащий файл — без карточного запрета; новый файл — запрет на месте', () => {
    const s = 'kdocplace001';
    const progress = join(copy, '.agent', 'PROGRESS.md');
    writeFileSync(progress, '# progress\n');
    mkdirSync(join(STATE, 'rules'), { recursive: true });
    writeFileSync(join(STATE, 'rules', `rule-doc-classification-${s}.sent`), '1');
    const existing = write(s, progress, 'Edit');
    expect(denied(existing), reason(existing)).toBe(false);
    const fresh = write(s, join(copy, 'docs', 'NEW.md'));
    expect(denied(fresh)).toBe(true);
    expect(reason(fresh)).toMatch(/needs doc-classification/);
  });

  it('`.agent/tmp/` и временный каталог — без правила; `.agent/` вне tmp — с правилом', () => {
    expect(
      placement(write('kdocscratch1', join(copy, '.agent', 'tmp', 'review-x', 'lane-A2.md'))),
    ).toBe(false);
    expect(placement(write('kdocscratch2', join(tmpdir(), 'scratchpad', 'notes.md')))).toBe(false);
    expect(placement(write('kdocscratch3', join(copy, '.agent', 'NOTES.md')))).toBe(true);
    expect(
      placement(write('kdocscratch4', join(copy, '.agent', 'screenshots', 'e6', 'README.md'))),
    ).toBe(true);
    expect(placement(write('kdocscratch5', join(copy, 'docs', 'tmp-notes', 'guide.md')))).toBe(
      true,
    );
  });

  it('журнал доставок: строки тестовых ключей не повторы; карточка + текст запрета — одна доставка', async () => {
    const lib = (await import(
      pathToFileURL(join(KIT, 'hooks', 'lib', 'rule-injector.mjs')).href
    )) as { ruleRepeats: (now?: number, file?: string) => string | null };
    const log = join(dir, 'deliveries-f2e.jsonl');
    const now = Date.now();
    const row = (s: string, rule: string, extra: object = {}) =>
      JSON.stringify({ t: now, s, rule, bytes: 4000, ...extra });
    const put = (rows: string[]) => writeFileSync(log, `${rows.join('\n')}\n`);
    put([row('tce12345-abc', 'git-writes'), row('tce12345-abc', 'git-writes')]);
    expect(lib.ruleRepeats(now, log)).toBeNull();
    put([row('c7117e96-6b1', 'git-writes'), row('c7117e96-6b1', 'git-writes')]);
    expect(lib.ruleRepeats(now, log)).toMatch(/git-writes x1/);
    put([row('c7117e96-6b1', 'review-depth'), row('c7117e96-6b1', 'review-depth', { feed: true })]);
    expect(lib.ruleRepeats(now, log)).toBeNull();
    put([
      row('c7117e96-6b1', 'review-depth', { feed: true }),
      row('c7117e96-6b1', 'review-depth', { feed: true }),
    ]);
    expect(lib.ruleRepeats(now, log)).toMatch(/review-depth x1/);
  });
});
