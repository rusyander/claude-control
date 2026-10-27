import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localizeText } from '../../../lib/server-texts/server-texts.ts';
import { deliveryFacts } from '../../chat/delivery-check/delivery-check.ts';
import { foreignReverts, remoteAhead } from './branch-commits.ts';
import { missingDelivery, readDeliveryFacts } from './delivery-facts.ts';

/**
 * g8 26.10 (F1, F3): бот CI дописал в ветку группы перегенерацию справочника. Удалённый
 * впереди — доставка писала «не отправлена»; подтянутый бот-коммит откатил строку группы
 * в сгенерированной странице, и MR ушёл в ревью с откатом. Настоящий git, свой origin.
 */

let root: string;
let copy: string;
let bot: string;

const run = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function commitFile(cwd: string, file: string, body: string, message: string): void {
  writeFileSync(join(cwd, file), body);
  run(cwd, 'add', '.');
  run(cwd, 'commit', '-qm', message);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'branch-commits-'));
  const bare = join(root, 'origin.git');
  run(root, 'init', '--bare', '-q', '-b', 'main', bare);
  copy = join(root, 'copy');
  run(root, 'clone', '-q', bare, copy);
  run(copy, 'config', 'user.email', 'group@example.com');
  run(copy, 'config', 'user.name', 'group');
  run(copy, 'checkout', '-q', '-b', 'main');
  commitFile(copy, 'gen.mdx', 'title\nlabel «Unsupported params» (Qoʻllab)\n', 'base');
  run(copy, 'push', '-q', 'origin', 'main');
  run(copy, 'checkout', '-q', '-b', 'fix/PROJ-1063-docs');
  commitFile(
    copy,
    'gen.mdx',
    'title\nlabel «Qoʻllab-quvvatlanmaydigan parametrlar»\n',
    'fix labels',
  );
  run(copy, 'push', '-q', 'origin', 'fix/PROJ-1063-docs');
  bot = join(root, 'bot');
  run(root, 'clone', '-q', '-b', 'fix/PROJ-1063-docs', bare, bot);
  run(bot, 'config', 'user.email', 'ci-bot@example.com');
  run(bot, 'config', 'user.name', 'CI bot');
  commitFile(
    bot,
    'gen.mdx',
    'title\nlabel «Unsupported params» (Qoʻllab)\n',
    'docs(api): regenerate',
  );
  run(bot, 'push', '-q', 'origin', 'fix/PROJ-1063-docs');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('коммиты на ветке группы, которых группа не делала', () => {
  it('удалённый впереди: доставка называет его коммит и `pull --ff-only`, а не «не отправлена»', async () => {
    const remoteSha = run(bot, 'rev-parse', 'HEAD');
    const ahead = await remoteAhead(
      copy,
      'origin',
      'fix/PROJ-1063-docs',
      remoteSha,
      run(copy, 'rev-parse', 'HEAD'),
    );
    expect(ahead?.count).toBe(1);
    expect(ahead?.commits[0]).toMatch(/^[0-9a-f]{7,} docs\(api\): regenerate$/);

    const facts = await readDeliveryFacts({ cwd: copy, branch: 'fix/PROJ-1063-docs' });
    expect(facts.pushed).toBe(false);
    const lines = missingDelivery(facts, 'fix/PROJ-1063-docs').map((line) =>
      localizeText(line, 'en'),
    );
    expect(lines.join('\n')).toContain('on the remote is ahead of the copy');
    expect(lines.join('\n')).toContain('docs(api): regenerate');
    expect(lines.join('\n')).toContain('git pull --ff-only origin fix/PROJ-1063-docs');
    expect(lines.join('\n')).not.toContain('is not pushed');
  });

  it('копия ушла вперёд своим коммитом — не «впереди», а обычное «не отправлена»', async () => {
    commitFile(copy, 'other.txt', 'mine\n', 'mine');
    const facts = await readDeliveryFacts({ cwd: copy, branch: 'fix/PROJ-1063-docs' });
    expect(facts.remoteAhead).toBeUndefined();
    expect(
      missingDelivery(facts, 'fix/PROJ-1063-docs')
        .map((line) => localizeText(line, 'en'))
        .join('\n'),
    ).toContain('is not pushed');
  });

  it('подтянутый бот-коммит убрал строку группы, её нет в HEAD — назван коммит и файл', async () => {
    run(copy, 'pull', '-q', '--ff-only', 'origin', 'fix/PROJ-1063-docs');
    const base = run(copy, 'rev-parse', 'origin/main');
    const reverts = await foreignReverts(copy, base);
    expect(reverts).toHaveLength(1);
    expect(reverts[0]?.commit).toMatch(/docs\(api\): regenerate \(CI bot\)$/);
    expect(reverts[0]?.files).toEqual(['gen.mdx']);
  });

  it('проверка доставки группы держит откат строкой пробела с коммитом и файлом', async () => {
    run(copy, 'pull', '-q', '--ff-only', 'origin', 'fix/PROJ-1063-docs');
    const verdict = await deliveryFacts(
      { path: copy, branch: 'fix/PROJ-1063-docs', sieveRows: [] },
      undefined,
      [],
      { testsCommand: 'tests-cli run --project .' },
    );
    const lines = verdict.missing.map((line) => localizeText(line, 'en')).join('\n');
    expect(lines).toContain(
      'docs(api): regenerate (CI bot) on the branch was not made by the group',
    );
    expect(lines).toContain('gen.mdx');
  });

  it('группа закрепила файл своим коммитом после бота — пробела нет; бот без отката — тоже', async () => {
    run(copy, 'pull', '-q', '--ff-only', 'origin', 'fix/PROJ-1063-docs');
    const base = run(copy, 'rev-parse', 'origin/main');
    commitFile(
      copy,
      'gen.mdx',
      'title\nlabel «Qoʻllab-quvvatlanmaydigan parametrlar»\n',
      'source fix',
    );
    expect(await foreignReverts(copy, base)).toEqual([]);
  });

  it('группа после бота правила тот же файл иначе — она его видела: пробела нет', async () => {
    run(copy, 'pull', '-q', '--ff-only', 'origin', 'fix/PROJ-1063-docs');
    const base = run(copy, 'rev-parse', 'origin/main');
    commitFile(
      copy,
      'gen.mdx',
      'title v2\nlabel «Unsupported params» (Qoʻllab)\n',
      'accept the regenerated label, retitle',
    );
    expect(await foreignReverts(copy, base)).toEqual([]);
  });

  it('бот тронул другой файл — строк группы не убирал', async () => {
    run(copy, 'pull', '-q', '--ff-only', 'origin', 'fix/PROJ-1063-docs');
    const base = run(copy, 'rev-parse', 'origin/main');
    commitFile(
      copy,
      'gen.mdx',
      'title\nlabel «Qoʻllab-quvvatlanmaydigan parametrlar»\n',
      'source fix',
    );

    // Бот тронул другой файл — строк группы не убирал.
    commitFile(bot, 'other.mdx', 'new page\n', 'docs: new page');
    run(bot, 'pull', '-q', '--rebase', 'origin', 'fix/PROJ-1063-docs');
    run(copy, 'push', '-q', 'origin', 'fix/PROJ-1063-docs');
    run(bot, 'pull', '-q', '--rebase', 'origin', 'fix/PROJ-1063-docs');
    run(bot, 'push', '-q', 'origin', 'fix/PROJ-1063-docs');
    run(copy, 'pull', '-q', '--ff-only', 'origin', 'fix/PROJ-1063-docs');
    expect(await foreignReverts(copy, base)).toEqual([]);
  });
});
