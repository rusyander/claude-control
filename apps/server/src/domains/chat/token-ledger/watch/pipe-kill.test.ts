import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS, type GroupWatchRule } from '@agentdeck/contracts/group-watch';
import { launchesOf, pipeKillTargets } from './pipe-kill.ts';
import { createWatchState, reduce } from './reduce.ts';
import { evaluate } from './rules.ts';
import { killTargets, outsideWrites } from './shell-targets.ts';
import { createTranscriptReader } from './transcript-events.ts';
import type { RuleHit, WatchContext, WatchEvent } from './watch.types.ts';

/**
 * R26 по конвейеру остановки (N3b / F-111): источник перечисляет процессы, сток их гасит.
 * Вырезки — НАСТОЯЩИЕ строки транскриптов 14–15.10 (`__fixtures__/leak/R26-foreign-kill/
 * {fire,near-miss}-{pipe,substitution}.jsonl`): пути → `/work/app`, имена программ
 * обезличены (`TrayApp`, `watcher.mjs`), ответы — заполнитель той же длины.
 * `fire-substitution` — та же строка остановки, что в `near-miss-substitution`, без строки
 * запуска перед ней: контекст урезан, команда настоящая. Формы Linux и cmd (`pgrep | xargs
 * kill`, `ps | awk | xargs kill -9`, `for /f … in ('tasklist …')`) в этих транскриптах не
 * встречаются — они синтетикой ниже, на функции разбора, каждая подписана.
 */

const COPY = '/work/app';

function events(name: string): WatchEvent[] {
  const read = createTranscriptReader();
  return readFileSync(new URL(`./__fixtures__/leak/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => read(JSON.parse(line) as unknown));
}

const ctx: WatchContext = { settings: GROUP_WATCH_DEFAULTS, cwd: COPY, home: '/home/u' };

function judge(list: readonly WatchEvent[], context: WatchContext = ctx): RuleHit[] {
  const state = createWatchState(list[0]?.t ?? 0);
  for (const event of list) reduce(state, event, context);
  const node = { chatId: 'c1', groupIndex: 0, running: true, paused: false };
  return evaluate(state, node, context, list.at(-1)?.t ?? 0);
}

const hit = (list: readonly WatchEvent[], rule: GroupWatchRule, context?: WatchContext) =>
  judge(list, context).find((one) => one.rule === rule);

const none = { ports: [] as number[], launches: [] as string[] };

describe('R26 конвейер остановки: настоящие строки', () => {
  it('`Get-Process TrayApp | Stop-Process -Force` внутри `powershell -Command "…"` — чужой образ, сигнал', () => {
    expect(hit(events('R26-foreign-kill/fire-pipe.jsonl'), 'R26')).toMatchObject({
      severity: 'warn',
      numbers: { kills: 1 },
      params: { target: 'TrayApp' },
    });
  });

  it('`P=$(powershell … Get-CimInstance … ProcessId); for p in $P; do taskkill //PID $p` — образ и образец, сигнал', () => {
    expect(hit(events('R26-foreign-kill/fire-substitution.jsonl'), 'R26')).toMatchObject({
      numbers: { kills: 1 },
      params: { target: 'node.exe watcher\\.mjs' },
    });
  });

  it('та же остановка после своего `node bridge/scripts/watcher.mjs` в фоне — тишина', () => {
    const list = events('R26-foreign-kill/near-miss-substitution.jsonl');
    expect(hit(list, 'R26')).toBeUndefined();
  });

  it('`Get-CimInstance … | Where-Object {*L6-live.mjs*} | ForEach-Object { Stop-Process }` своего скрипта — тишина; без запуска — сигнал', () => {
    const list = events('R26-foreign-kill/near-miss-pipe.jsonl');
    expect(hit(list, 'R26')).toBeUndefined();
    const killOnly = list.slice(2);
    expect(hit(killOnly, 'R26')?.params?.target).toBe('node.exe *L6-live.mjs*');
  });

  it('образец с именем своей копии — свои процессы, но не у основной копии панели', () => {
    const command =
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match \'review-1029\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"';
    const copy = '/work/worktrees/review-1029';
    expect(pipeKillTargets(command, { ...none, copy })).toEqual([]);
    expect(pipeKillTargets(command, none)).toEqual(['review-1029']);
    const list: WatchEvent[] = [{ kind: 'tool', t: 1, id: 't1', name: 'Bash', input: { command } }];
    expect(hit(list, 'R26', { ...ctx, cwd: copy })).toBeUndefined();
    expect(hit(list, 'R26', { ...ctx, cwd: copy, panelRoot: copy })).toBeDefined();
  });
});

describe('R26 конвейер остановки: формы Linux, cmd и PowerShell (синтетика)', () => {
  const foreign: Array<[string, string]> = [
    ['pgrep -f vite | xargs kill', 'vite'],
    ['pgrep node | xargs -r kill -9', 'node'],
    ["ps aux | grep '[v]ite' | grep -v grep | awk '{print $2}' | xargs kill -9", '[v]ite'],
    ["ps -ef | awk '/http-server/ {print $2}' | xargs kill", 'http-server'],
    ['pidof node | xargs kill', 'node'],
    ['kill $(pgrep -f "next dev")', 'next dev'],
    ['powershell -Command "Get-Process node | Stop-Process -Force"', 'node'],
    ['pwsh -c "Get-Process -Name chrome | ForEach-Object { $_.Kill() }"', 'chrome'],
    ['powershell -Command "(Get-Process node).Kill()"', 'node'],
    ['for /f "tokens=2" %a in (\'tasklist ^| findstr node\') do taskkill /PID %a /F', 'node'],
    ['tasklist /FI "IMAGENAME eq node.exe" | xargs taskkill /F /PID', 'node.exe'],
    [
      'powershell -Command "Get-NetTCPConnection -LocalPort 5173 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"',
      'PID :5173',
    ],
    ["ps aux | awk '{print $2}' | xargs kill", '*'],
  ];
  it.each(foreign)('%s → чужая цель %s', (command, target) => {
    expect(killTargets(command, [], undefined)).toContain(target);
  });

  const own: Array<[string, { ports?: number[]; launches?: string[] }]> = [
    ['pgrep -f "vite --port 5284" | xargs kill', { ports: [5284] }],
    ['pgrep -f probe-stub.mjs | xargs kill', { launches: ['probe-stub.mjs'] }],
    [
      'powershell -Command "Get-NetTCPConnection -LocalPort 5399 | ForEach-Object { Stop-Process -Id $_.OwningProcess }"',
      { ports: [5399] },
    ],
    ['powershell -Command "Get-Process -Id 4242 | Stop-Process"', {}],
    ['powershell -Command "Get-Process -Id $pid | Stop-Process"', {}],
  ];
  it.each(own)('%s → своё, тишина', (command, mine) => {
    expect(
      killTargets(command, mine.ports ?? [], undefined, { launches: mine.launches ?? [] }),
    ).toEqual([]);
  });

  const harmless = [
    'Get-Process node | Select-Object Id,Path',
    'ps aux | grep vite',
    'tasklist | findstr node',
    'pgrep -f vite; echo done',
    'powershell -Command "Get-Process -Id 52528 -ErrorAction SilentlyContinue | select Id,ProcessName"; taskkill //PID 55504 //T //F',
  ];
  it.each(harmless)('%s → не остановка по перечню', (command) => {
    expect(pipeKillTargets(command, none)).toEqual([]);
  });

  it('запуски сессии: имя файла скрипта, не бегун и не аргумент-флаг', () => {
    expect(launchesOf('cd /work/app; node .agent/tmp/L6-live.mjs > out.txt 2>&1')).toEqual([
      'l6-live.mjs',
    ]);
    expect(launchesOf('PORT=5284 npx tsx scripts/Serve.ts --watch')).toEqual(['serve.ts']);
    expect(launchesOf('python3 tools/probe.py && ./bin/helper.exe')).toEqual([
      'probe.py',
      'helper.exe',
    ]);
    expect(launchesOf('cat scripts/a.mjs; grep -n x b.ts')).toEqual([]);
  });
});

describe('R31: временный каталог — только системный корень (F-111)', () => {
  const at = (path: string) => outsideWrites('Write', { file_path: path }, ctx);
  it('сегмент `tmp` в чужой копии — правка вне копии; системные корни — нет', () => {
    expect(at('/work/other-repo/tmp/x.txt')).toEqual(['/work/other-repo/tmp/x.txt']);
    expect(at('/srv/temp/build.log')).toEqual(['/srv/temp/build.log']);
    expect(at('/tmp/scratch.txt')).toEqual([]);
    expect(at('/var/folders/ab/T/x')).toEqual([]);
    expect(at('C:/Users/u/AppData/Local/Temp/claude/x.json')).toEqual([]);
  });
});
