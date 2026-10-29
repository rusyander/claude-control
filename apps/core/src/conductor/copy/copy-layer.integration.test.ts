import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { installer, makeRepo, taskWithUnit, wiring } from './__fixtures__/copy-harness.ts';
import { mirrorLocalLayer } from './mirror.ts';

/**
 * Локальный слой в копии по настоящему пути (04:93-98, P84, P04): каждый перенесённый файл
 * окружения проходит переписывание или не переносится и называется; перенос не пишет сквозь
 * ссылку в копии; ветки отказа зеркала (ссылка-источник, > 8 МБ, флаг git не встал) называются.
 */

const PROD = 'DATABASE_URL=postgres://prod.example.com:5432/app\n';

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    encoding: 'utf8',
  }).trim();
}

describe('unit copy local layer', () => {
  it('every mirrored env file is rewritten or not mirrored and named: no production endpoint in the copy', async () => {
    const { repo, base } = makeRepo({
      '.gitignore': '.env.local\nsecrets.txt\nnode_modules/\n.env\nprod.env\n',
    });
    mkdirSync(join(repo, 'docker'));
    writeFileSync(join(repo, '.env'), PROD);
    writeFileSync(join(repo, 'docker', '.env'), PROD);
    writeFileSync(join(repo, 'prod.env'), PROD);
    const { task, unitId } = await taskWithUnit(repo, base);
    const got = await wiring(task, tempDir('cpw-'), installer().install).prepare(
      task.taskId,
      unitId,
    );
    if (!('value' in got) || !got.value.placed) throw new Error('prepare unread');
    const dir = got.value.placed.dir;
    expect(readFileSync(join(dir, '.env'), 'utf8')).not.toContain('prod.example.com');
    expect(readFileSync(join(dir, 'docker', '.env'), 'utf8')).not.toContain('prod.example.com');
    expect(existsSync(join(dir, 'prod.env'))).toBe(false);
    const left = got.value.decision.leftBehind.map((l) => `${l.kind}:${l.subject}`);
    expect(left).toContain('env-var:docker/.env:DATABASE_URL');
    expect(left).toContain('mirror-skip:prod.env');
    task.close();
  });

  it('mirror never writes through a link in the copy, skips a big file and names a git flag that did not set', async () => {
    const top = mkdtempSync(join(tempDir('mir-'), 't-'));
    const main = join(top, 'main');
    execFileSync('git', ['init', '-q', '-b', 'main', main]);
    writeFileSync(join(main, '.gitignore'), '.claude/\n*.local\n');
    writeFileSync(join(main, 'package.json'), '{}\n');
    sh(main, 'add', '-A');
    sh(main, 'commit', '-q', '-m', 'A');
    const base = sh(main, 'rev-parse', 'HEAD');
    mkdirSync(join(main, 'config'));
    writeFileSync(join(main, 'config', 'local.json'), '{"v":1}\n');
    sh(main, 'add', '-A');
    sh(main, 'commit', '-q', '-m', 'B');
    // Флаг человека на файле, которого на базе копии нет: в копии git его поставить не может.
    sh(main, 'update-index', '--skip-worktree', 'config/local.json');
    mkdirSync(join(main, '.claude'));
    writeFileSync(join(main, '.claude', 'settings.local.json'), '{"secret":1}\n');
    writeFileSync(join(main, 'big.local'), Buffer.alloc(9 * 1024 * 1024));

    const copy = join(top, 'copy');
    sh(main, 'worktree', 'add', '-q', '--detach', copy, base);
    const outside = join(top, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'settings.local.json'), 'victim\n');
    // Ссылка в копии (как отслеживаемая ссылка на базе): `.claude` → каталог вне копии.
    symlinkSync(outside, join(copy, '.claude'), 'junction');

    const report = await mirrorLocalLayer(main, copy, undefined);
    if (!('value' in report)) throw new Error(JSON.stringify(report));
    const skipped = Object.fromEntries(report.value.skipped.map((s) => [s.path, s.why]));
    expect(readFileSync(join(outside, 'settings.local.json'), 'utf8')).toBe('victim\n');
    expect(skipped['.claude/settings.local.json']).toMatch(/^link in the copy at \.claude/);
    expect(skipped['big.local']).toMatch(/^larger than 8 MB/);
    expect(existsSync(join(copy, 'big.local'))).toBe(false);
    expect(report.value.mirrored).toContain('config/local.json');
    expect(report.value.flagsFailed).toEqual(['config/local.json']);
  });
});
