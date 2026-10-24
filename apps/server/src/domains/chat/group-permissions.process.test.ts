import { describe, expect, it, vi } from 'vitest';
import { GROUP_REQUEST_IDS, type GroupRequestId } from '@agentdeck/contracts/split-groups';
import {
  groupDecision,
  withProcessFacts,
  type GroupAutoApprove,
  type ProcessFactsIo,
} from './group-permissions.ts';

/**
 * Решение группы о погашении процессов (N3) и каталог оболочки (N4) — журнал
 * 23.10: группа сняла по номерам из netstat dev-серверы владельца на :5173-5175,
 * а уборку своего из подпроекта отдала человеку.
 */
const COPY = 'C:/work/shop-worktrees/fix-PROJ-1-x';

function group(extra: Partial<GroupAutoApprove> = {}): GroupAutoApprove {
  const rows = Object.fromEntries(GROUP_REQUEST_IDS.map((id) => [id, 'auto'])) as Record<
    GroupRequestId,
    'auto'
  >;
  return {
    rows: { ...rows, externalWrite: 'human', externalDestroy: 'human' },
    allowEdits: true,
    parentChatId: 'p',
    groupIndex: 1,
    worktree: COPY,
    ignored: [],
    ...extra,
  };
}

const bash = (command: string) => ({ toolName: 'Bash', input: { command } });
const decide = (g: GroupAutoApprove, command: string): string =>
  groupDecision(g, { ...bash(command), guardedPatterns: [] });

/** CLI 100 → оболочка 101 → dev-сервер 102; 200 — чужой; 300 — сирота на номере, занятом позже. */
const TABLE = [
  { pid: 100, ppid: 1, created: 10n },
  { pid: 101, ppid: 100, created: 11n },
  { pid: 102, ppid: 101, created: 12n },
  { pid: 200, ppid: 1, created: 5n },
  { pid: 300, ppid: 100, created: 3n },
];

function io(holders: Record<number, number[]> = {}): ProcessFactsIo & {
  readTable: ReturnType<typeof vi.fn>;
} {
  return {
    readTable: vi.fn(async () => TABLE),
    portHolders: (port: number) => holders[port] ?? [],
  };
}

describe('groupDecision — погашение процессов (N3)', () => {
  it('без своего дерева номер гасит человек', () => {
    expect(decide(group(), 'taskkill //PID 102 //F')).toBe('human');
  });

  it('свой номер — само, чужой рядом со своим — человеку', () => {
    const own = group({ ownPids: new Set([100, 101, 102]) });
    expect(decide(own, 'taskkill //PID 102 //F')).toBe('auto');
    expect(decide(own, 'kill 101 102')).toBe('auto');
    expect(decide(own, 'taskkill //PID 102 //PID 200 //F')).toBe('human');
  });

  it('порт: все держатели свои — само; никого или чужой — человеку', () => {
    const own = new Set([100, 101, 102]);
    const at = (holders: number[]) =>
      group({ ownPids: own, portHolders: new Map([[5173, holders]]) });
    expect(decide(at([102]), 'npx kill-port 5173')).toBe('auto');
    expect(decide(at([]), 'npx kill-port 5173')).toBe('human');
    expect(decide(at([102, 200]), 'npx kill-port 5173')).toBe('human');
  });

  it('своё без номера (`$!`) не ждёт дерева', () => {
    expect(decide(group(), 'npm run dev & P=$!; sleep 5; kill $P')).toBe('auto');
  });
});

/**
 * R-C03 (ревью корпуса 23.10): 30 из 107 карточек корпуса — группа гасит свой
 * dev-сервер номером, прочитанным из `netstat` по порту. Номер — подстановка,
 * и звено было «не назвать»; теперь это порт, и решает проверка держателей.
 */
describe('groupDecision — погашение по номеру из запроса порта (R-C03)', () => {
  const decideWith = async (command: string, holders: Record<number, number[]>) =>
    decide(await withProcessFacts(group(), bash(command), [100], io(holders)), command);

  it.each([
    `pid=$(netstat -ano | grep ':5273 ' | grep LISTENING | awk '{print $5}' | head -1); echo "pid=$pid"; [ -n "$pid" ] && taskkill //PID $pid //T //F`,
    `PID=$(netstat -ano | grep -E "LISTENING" | grep -E "[:.]5273 " | awk '{print $NF}' | sort -u); [ -n "$PID" ] && taskkill //PID $PID //T //F; sleep 1`,
    `P=$(netstat -ano | grep -E ':5273 .*LISTENING' | awk '{print $NF}' | head -1); [ -n "$P" ] && taskkill //PID $P //T //F 2>&1 | tail -1`,
    `for p in 5273 5274; do pid=$(netstat -ano | grep -E ":$p .*LISTENING" | awk '{print $5}' | head -1); [ -n "$pid" ] && taskkill //PID $pid //T //F >/dev/null 2>&1 && echo "stopped :$p"; done`,
    `for port in 5273 5274; do for pid in $(netstat -ano | grep -E "LISTENING" | grep -E "[:.]$port\\s" | awk '{print $NF}' | sort -u); do taskkill //PID $pid //T //F 2>&1 | tail -1; done; done`,
    `kill $(lsof -t -iTCP:5273 -sTCP:LISTEN)`,
  ])('держатели свои — само, чужой или никого — человеку: %s', async (command) => {
    expect(await decideWith(command, { 5273: [102], 5274: [102] })).toBe('auto');
    expect(await decideWith(command, { 5273: [102, 200], 5274: [102] })).toBe('human');
    expect(await decideWith(command, { 5274: [102] })).toBe('human');
  });

  it.each([
    // Вывод — не номера держателя: обращённый фильтр, совпадение частью, своё число.
    `pid=$(netstat -ano | grep -v ':5273 ' | awk '{print $5}'); taskkill //PID $pid //F`,
    `pid=$(netstat -ano | grep LISTENING | grep -oE '[0-9]+' | head -1); taskkill //PID $pid //F`,
    // Порт и LISTEN названы, но `-v` выбрасывает слушающих, `-o` печатает не номер.
    `pid=$(netstat -ano | grep ':5273 ' | grep -v LISTENING | awk '{print $5}'); taskkill //PID $pid //F`,
    `pid=$(netstat -ano | grep ':5273 ' | grep LISTENING | grep -oE '[0-9]+' | head -1); taskkill //PID $pid //F`,
    `pid=$(netstat -ano | grep ':5273 ' | grep LISTENING | awk '{print 200}'); taskkill //PID $pid //F`,
    // Без отбора LISTEN — и чужие соединения на этот порт.
    `pid=$(netstat -ano | grep ':5273 ' | awk '{print $5}'); taskkill //PID $pid //F`,
    // `:5273` без границы поймает и :52730.
    `pid=$(netstat -ano | grep LISTENING | grep ':5273' | awk '{print $5}'); taskkill //PID $pid //F`,
    `pid=$(cat ports.txt | grep ':5273 ' | grep LISTENING | awk '{print $5}'); taskkill //PID $pid //F`,
    // «Или» в отборе и порт из неизвестного списка.
    `pid=$(netstat -ano | grep LISTENING | grep -E ':5273 |:9' | awk '{print $5}'); taskkill //PID $pid //F`,
    `pid=$(netstat -ano | grep LISTENING | grep ':5273 \\|:9' | awk '{print $5}'); taskkill //PID $pid //F`,
    `for p in $PORTS; do pid=$(netstat -ano | grep -E ":$p .*LISTENING" | awk '{print $5}'); taskkill //PID $pid //F; done`,
    `pid=$(netstat -ano | findstr ":5273 LISTENING"); taskkill //PID $pid //F`,
  ])('номер не из держателей порта — человеку: %s', async (command) => {
    expect(await decideWith(command, { 5273: [102], 52730: [102] })).toBe('human');
  });
});

describe('withProcessFacts — своё дерево по снимку ОС', () => {
  it('потомки корней прогона — свои; чужой и сирота на чужом номере — нет', async () => {
    const facts = await withProcessFacts(group(), bash('kill 102'), [100], io());
    expect([...(facts.ownPids ?? [])].sort()).toEqual([100, 101, 102]);
    expect(decide(facts, 'kill 102')).toBe('auto');
    const foreign = await withProcessFacts(group(), bash('kill 200'), [100], io());
    expect(decide(foreign, 'kill 200')).toBe('human');
    const orphan = await withProcessFacts(group(), bash('kill 300'), [100], io());
    expect(decide(orphan, 'kill 300')).toBe('human');
  });

  it('держатели порта читаются для каждого гасимого порта', async () => {
    const facts = await withProcessFacts(
      group(),
      bash('npx kill-port 5173 5174'),
      [100],
      io({ 5173: [102], 5174: [200] }),
    );
    expect(decide(facts, 'npx kill-port 5173')).toBe('auto');
    expect(decide(facts, 'npx kill-port 5174')).toBe('human');
  });

  it('не гасит ничего числом — снимок не снимается', async () => {
    const stub = io();
    const facts = await withProcessFacts(group(), bash('git status'), [100], stub);
    expect(stub.readTable).not.toHaveBeenCalled();
    expect(facts.ownPids).toBeUndefined();
  });

  it('снимок не удался или корней нет — своё не доказано, человеку', async () => {
    const failing = io();
    failing.readTable.mockRejectedValueOnce(new Error('wmic gone'));
    const failed = await withProcessFacts(group(), bash('kill 102'), [100], failing);
    expect(decide(failed, 'kill 102')).toBe('human');
    const rootless = await withProcessFacts(group(), bash('kill 102'), [], io());
    expect(decide(rootless, 'kill 102')).toBe('human');
    // Корень уже вышел: в снимке его нет — дерево пустое.
    const gone = await withProcessFacts(group(), bash('kill 102'), [999], io());
    expect(decide(gone, 'kill 102')).toBe('human');
  });
});

describe('groupDecision — каталог оболочки (N4)', () => {
  const command = 'node -e "1" && ls node_modules | wc -l && rm -rf ../docs/old';

  it('из подпроекта копии `..` — копия; без каталога — от корня, человеку', () => {
    expect(decide(group({ shellCwd: `${COPY}/inst-docs-ui` }), command)).toBe('auto');
    expect(decide(group(), command)).toBe('human');
  });

  it('каталог вне копии мягче не делает', () => {
    expect(decide(group({ shellCwd: 'C:/work/shop-worktrees/other/inst-docs-ui' }), command)).toBe(
      'human',
    );
  });
});
