import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedFacts, coldBriefFacts, remoteFacts } from './cold-brief.ts';

/**
 * g8 26.10 (F3, F12): вводная нового разговора перечислила коммиты копии по локальным
 * ссылкам, а бот CI уже дописал в ветку на удалённом свой. Новая сессия сняла MR с
 * черновика, считая его голову своей. Настоящий git, свой origin.
 */

let root: string;
let copy: string;
let bot: string;
const BRANCH = 'fix/PROJ-1063-docs';

const run = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function commitFile(cwd: string, file: string, body: string, message: string): void {
  writeFileSync(join(cwd, file), body);
  run(cwd, 'add', '.');
  run(cwd, '-c', 'user.email=g@t', '-c', 'user.name=group', 'commit', '-qm', message);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cold-remote-'));
  const bare = join(root, 'origin.git');
  run(root, 'init', '--bare', '-q', '-b', 'main', bare);
  copy = join(root, 'copy');
  mkdirSync(copy);
  run(copy, 'init', '-q', '-b', 'main');
  run(copy, 'remote', 'add', 'origin', bare);
  commitFile(copy, 'a.txt', 'base\n', 'base');
  run(copy, 'push', '-q', 'origin', 'main');
  run(copy, 'checkout', '-q', '-b', BRANCH);
  commitFile(copy, 'a.txt', 'fix\n', 'fix');
  run(copy, 'push', '-q', 'origin', BRANCH);
  bot = join(root, 'bot');
  run(root, 'clone', '-q', '-b', BRANCH, bare, bot);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('вводная нового разговора: ветка на удалённом против HEAD', () => {
  it('удалённый = HEAD — «pushed»; копия впереди — «push pending»', () => {
    expect(remoteFacts(copy, BRANCH).join('\n')).toContain('= HEAD of the copy');
    commitFile(copy, 'b.txt', 'more\n', 'more');
    expect(remoteFacts(copy, BRANCH).join('\n')).toContain('behind HEAD by 1 commit(s)');
  });

  it('бот CI дописал коммит: вводная называет его и `pull --ff-only`, даже без fetch в копии', () => {
    commitFile(bot, 'gen.mdx', 'regenerated\n', 'docs(api): regenerate');
    run(bot, 'push', '-q', 'origin', BRANCH);
    // Копия коммита не знает — строка велит fetch.
    expect(remoteFacts(copy, BRANCH).join('\n')).toContain('a commit this copy does not have');
    run(copy, 'fetch', '-q', 'origin');
    const transcript = join(root, 's.jsonl');
    writeFileSync(transcript, '');
    const facts = coldBriefFacts(copy, transcript);
    expect(facts).toContain(`## Remote origin/${BRANCH} (read from the remote now)`);
    expect(facts).toContain('AHEAD of the copy by 1 commit(s) not made here');
    expect(facts).toMatch(/- [0-9a-f]{7,} docs\(api\): regenerate \(group\)/);
    expect(facts).toContain(`git pull --ff-only origin ${BRANCH}`);
  });

  it('ветки нет на удалённом — «not pushed yet»', () => {
    run(copy, 'checkout', '-q', '-b', 'fix/PROJ-2-new');
    expect(remoteFacts(copy, 'fix/PROJ-2-new').join('\n')).toContain('not pushed yet');
  });
});

describe('вводная нового разговора: справочные заметки', () => {
  it('копия трекера и ловушки длиннее порога — оглавление и путь; блокнот состояния — целиком', () => {
    mkdirSync(join(copy, '.agent', 'run'), { recursive: true });
    const body = 'x'.repeat(2_000);
    writeFileSync(
      join(copy, '.agent', 'run', 'tickets.md'),
      `# Tracker tasks — read by the panel\n## PROJ-1063 — labels\n### Description\n# step one\n${body}\n### Comments (2)\n${body}\n`,
    );
    writeFileSync(
      join(copy, '.agent', 'notes.md'),
      `# notes\n## Frontend canon\n${body}\n## Dev-stand login\n${body}\n`,
    );
    writeFileSync(join(copy, '.agent', 'PROGRESS.md'), `# PROGRESS\n## NEXT\nundraft MR ${body}\n`);
    const transcript = join(root, 's.jsonl');
    writeFileSync(transcript, '');
    const facts = coldBriefFacts(copy, transcript);
    expect(facts).toContain(
      '## Notebook .agent/run/tickets.md\n# Tracker tasks — read by the panel\n## PROJ-1063 — labels\n…(index only,',
    );
    expect(facts).toContain('Read .agent/run/tickets.md for a section the work needs');
    expect(facts).not.toContain('# step one');
    expect(facts).toContain('## Frontend canon\n## Dev-stand login\n…(index only,');
    expect(facts).toContain(`undraft MR ${body}`);
    expect(facts.length).toBeLessThan(body.length * 2 + 2_500);
  });

  it('короткая копия трекера едет целиком', () => {
    mkdirSync(join(copy, '.agent', 'run'), { recursive: true });
    writeFileSync(join(copy, '.agent', 'run', 'tickets.md'), '## PROJ-1 — short\nbody line\n');
    const transcript = join(root, 's.jsonl');
    writeFileSync(transcript, '');
    expect(coldBriefFacts(copy, transcript)).toContain('## PROJ-1 — short\nbody line');
  });
});

describe('вводная нового разговора: файлы ветки', () => {
  const numstat = Array.from(
    { length: 30 },
    (_, i) => `1\t0\tf${String(i).padStart(2, '0')}.mdx`,
  ).join('\0');
  it('всё закоммичено — 10 строк и счёт остальных', () => {
    const lines = changedFacts('origin/main', numstat, '');
    expect(lines).toContain('   f09.mdx +1 -0');
    expect(lines).not.toContain('   f10.mdx +1 -0');
    expect(lines).toContain('…(20 more files, 0 of them uncommitted)');
  });
  it('есть незакоммиченное — прежние 40 строк', () => {
    const lines = changedFacts('origin/main', numstat, ' M f00.mdx\0');
    expect(lines).toContain('   f29.mdx +1 -0');
  });
});
