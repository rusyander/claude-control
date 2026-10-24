import { describe, expect, it } from 'vitest';
import { buildHandoffPrompt } from '@agentdeck/contracts/chat-handoff';
import { continuationEnvironment, environmentPreamble } from '@agentdeck/contracts/task-split';

/**
 * Продолжение группы получает задание заново (L7.17b): у живой группы
 * 18.10.2026 преамбула окружения весила 10,8 тыс. знаков — по строке на каждый
 * модуль и полный список команд подготовки. Форма строк — та, что хранилась в
 * её задании (до склейки модулей), имена модулей заменены.
 */

const GO = (mod: string, wanted: string) =>
  `Go in ${mod}/: the project asks for ${wanted} (${mod}/go.mod go): ready on 1.27.0. Run it with: go test ./....`;
const PY_FAILED = (mod: string) =>
  `⚠ Python in ${mod}/: the project asks for >=3.12 (${mod}/pyproject.toml requires-python): preparing it failed. «.venv/python -m pip install -r requirements.txt» exited with code 1 Decide yourself: retry or do without it.`;
const NODE = (mod: string) =>
  `Node in ${mod}/: the project asks for >=22.22.2 <23 (${mod}/package.json engines); the panel prepared the copy on 22.23.2, the machine default is 24.13.0. Use 22.23.2 for installs and runs (put it first in PATH).`;

const GO_MODS = Array.from({ length: 30 }, (_, i) => `svc-${i}`);
const PY_MODS = ['box-a', 'box-b', 'box-c'] as const;
const NODE_MODS = ['web-a', 'web-b'] as const;
const COMMANDS = NODE_MODS.map((m) => `[${m}] npm ci --prefer-offline --no-audit --no-fund`).join(
  ' · ',
);

const BEFORE = ['Fix the login form.', 'Owned files: web-a/src/**', '', 'Group task:'];
const AFTER = [
  'If a tool the task needs is missing (an MCP server, a skill, a CLI), say so in the first lines of your answer and name what it blocks — never work around it silently.',
  '',
  'Answer in Russian.',
];
const LEGACY = [
  ...BEFORE,
  'The panel prepared this copy: Local layer: 12 copied.',
  `⚠ Copy preparation: the command "${COMMANDS}" exited with code 1. Dependencies may not be installed — decide yourself: repeat the install or do without it.`,
  'First error: [web-a] npm error code ELIFECYCLE',
  'Full log: /data/worktree-logs/copy.log',
  NODE(NODE_MODS[0]),
  ...GO_MODS.map((m, i) => GO(m, i % 3 ? '>=1.25.0' : '>=1.25')),
  PY_FAILED(PY_MODS[0]),
  NODE(NODE_MODS[1]),
  PY_FAILED(PY_MODS[1]),
  'Python in box-z/: the project asks for >=3.12 (box-z/pyproject.toml requires-python): ready on 3.15.0. Run it with: .venv/Scripts/python.exe -m pytest.',
  PY_FAILED(PY_MODS[2]),
  'Python in box-y/: the project asks for  (): ready on 3.15.0. Run it with: .venv/Scripts/python.exe -m pytest.',
  'Do not set up MCP or the local layer — start with the task.',
  ...AFTER,
].join('\n');

const count = (text: string, part: string) => text.split(part).length - 1;

describe('преамбула окружения в продолжении группы', () => {
  const out = continuationEnvironment(LEGACY);

  it('одинаковые строки склеены: каждая среда и каждый провал — один раз', () => {
    expect(count(out, 'ready on 1.27.0. Run it with: go test ./....')).toBe(1);
    expect(count(out, 'preparing it failed')).toBe(1);
    expect(count(out, 'Use 22.23.2 for installs and runs')).toBe(1);
    expect(count(out, 'ready on 3.15.0')).toBe(1);
    expect(out).toContain('the project asks for >=1.25 or >=1.25.0: ready on 1.27.0');
    expect(out.length).toBeLessThan(LEGACY.length * 0.4);
  });

  it('ни один модуль не потерян, у каждого — его строка', () => {
    const goLine = out.split('\n').find((line) => line.startsWith('Go in '));
    expect(goLine).toContain(`(${GO_MODS.length} modules)`);
    for (const mod of GO_MODS) expect(goLine).toContain(`${mod}/`);
    const pyLine = out.split('\n').find((line) => line.startsWith('⚠ Python in '));
    for (const mod of PY_MODS) expect(pyLine).toContain(`${mod}/`);
    // Модуль без объявленной версии склеивается, но пустой версией не становится.
    expect(out).toContain(
      'Python in box-z/, box-y/ (2 modules): the project asks for >=3.12: ready on 3.15.0',
    );
    expect(out).not.toContain(' or :');
    const nodeLine = out.split('\n').find((line) => line.startsWith('Node in '));
    for (const mod of NODE_MODS) expect(nodeLine).toContain(`${mod}/`);
  });

  it('провал подготовки: без списка команд, причина, первая ошибка и лог на месте', () => {
    expect(out).not.toContain('npm ci --prefer-offline');
    expect(out).toContain('⚠ Copy preparation exited with code 1 when the group started.');
    expect(out).toContain('decide yourself: repeat the install or do without it.');
    expect(out).toContain('First error: [web-a] npm error code ELIFECYCLE');
    expect(out).toContain('Full log: /data/worktree-logs/copy.log');
  });

  it('текст вокруг преамбулы — байт в байт, повторный вызов ничего не меняет', () => {
    expect(
      out.startsWith(
        `${BEFORE.join('\n')}\nThe panel prepared this copy: Local layer: 12 copied.\n`,
      ),
    ).toBe(true);
    expect(out.endsWith(AFTER.join('\n'))).toBe(true);
    expect(continuationEnvironment(out)).toBe(out);
  });

  it('без преамбулы или без её конца текст не трогается', () => {
    expect(continuationEnvironment('Fix the login form.')).toBe('Fix the login form.');
    const cut = LEGACY.split('\nIf a tool')[0] ?? '';
    expect(continuationEnvironment(cut)).toBe(cut);
  });

  it('новое задание (модули уже склеены): ничего не теряется и не раздувается', () => {
    const fresh = environmentPreamble({
      bootstrap: {
        status: 'ok',
        command: 'npm ci',
        logTail: '',
        runtimes: GO_MODS.map((where) => ({
          tool: 'go',
          where,
          wanted: '>=1.25.0',
          source: `${where}/go.mod go`,
          status: 'ok',
          used: '1.27.0',
          run: 'go test ./...',
        })),
      } as never,
    });
    const compact = continuationEnvironment(fresh);
    expect(compact.length).toBeLessThanOrEqual(fresh.length);
    for (const mod of GO_MODS) expect(compact).toContain(`${mod}/`);
    expect(count(compact, 'Run it with: go test ./...')).toBe(1);
  });

  it('удачная подготовка задания до 20.10: вместо списка команд — число шагов (живой прогон 24.10)', () => {
    // Задание, записанное до `installedLine`, несло 2,6 тыс. знаков «installed with
    // "[mod] go mod download · …"» в каждую холодную вводную группы.
    const long = GO_MODS.map((m) => `[${m}] go mod download`).join(' · ');
    const legacyOk = [
      ...BEFORE,
      `The panel prepared this copy: Local layer: 12 copied; dependencies installed with "${long}".`,
      NODE(NODE_MODS[0]),
      'The environment is ready — do not set it up again (MCP, local layer, dependencies), start with the task right away.',
      ...AFTER,
    ].join('\n');
    const compact = continuationEnvironment(legacyOk);
    expect(compact).not.toContain('go mod download');
    expect(compact).toContain(
      `The panel prepared this copy: Local layer: 12 copied; dependencies installed by the project's copy preparation (${GO_MODS.length} steps).`,
    );
    expect(compact).toContain('Use 22.23.2 for installs and runs');
    expect(continuationEnvironment(compact)).toBe(compact);
    // Короткая команда остаётся как была.
    const short = legacyOk.replace(long, 'npm ci');
    expect(continuationEnvironment(short)).toContain('dependencies installed with "npm ci".');
  });

  it('строка о модулях вне зоны: среды, версии, команды и провалы на месте, списков модулей нет (живой прогон 25.10)', () => {
    const outside = `Outside this group's zone (not needed for its tasks): Node ready on 22.23.2 in shared-ui/, cp-admin-ui/, inst-chat-ui/; Go ready on 1.27.0 in ${GO_MODS.map((m) => `${m}/`).join(', ')} — run: go test ./...; ⚠ Python preparation failed in box-a/, box-b/ («.venv/python -m pip install -r requirements.txt» exited with code 1); ⚠ Go >=1.26 not installed for apps/edge/; Python ready on 3.15.0 in shared-python/ — run: .venv/Scripts/python.exe -m pytest.`;
    const task = [
      ...BEFORE,
      'The panel prepared this copy: Local layer: 12 copied.',
      NODE(NODE_MODS[0]),
      outside,
      'The environment is ready — do not set it up again (MCP, local layer, dependencies), start with the task right away.',
      ...AFTER,
    ].join('\n');
    const line = continuationEnvironment(task)
      .split('\n')
      .find((row) => row.startsWith("Outside this group's zone"));
    expect(line).toBe(
      "Outside this group's zone (not needed for its tasks): Node ready on 22.23.2 in 3 modules; Go ready on 1.27.0 in 30 modules — run: go test ./...; ⚠ Python preparation failed in 2 modules («.venv/python -m pip install -r requirements.txt» exited with code 1); ⚠ Go >=1.26 not installed for 1 module; Python ready on 3.15.0 in 1 module — run: .venv/Scripts/python.exe -m pytest.",
    );
    expect(line!.length).toBeLessThan(outside.length * 0.6);
    const compact = continuationEnvironment(task);
    expect(continuationEnvironment(compact)).toBe(compact);
  });

  it('продолжение группы получает сжатую преамбулу', () => {
    const prompt = buildHandoffPrompt(
      { next: 'Run the review stage.', checkpoint: '.agent/PROGRESS.md' } as never,
      LEGACY,
      { group: true },
    );
    expect(prompt).toContain('Group task:');
    expect(count(prompt, 'go test ./....')).toBe(1);
    expect(prompt).not.toContain('npm ci --prefer-offline');
  });
});
