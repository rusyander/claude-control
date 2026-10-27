import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — модуль инструмента без объявлений типов
import { expandCopyPaths } from '../../../../../tools/tests-cli-base.mjs';

/**
 * `expandCopyPaths` на копии с пробелом в пути: путь копии, подставленный отдельным словом
 * без кавычек, оболочка резала надвое, и прогон на развилке падал «файл не найден».
 */
describe('tests-cli --base: путь копии вне git в --cmd', () => {
  let root = '';
  let copy = '';
  let tree = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-copy-paths-'));
    copy = join(root, 'my copy');
    tree = join(root, 'tree');
    mkdirSync(join(copy, '.agent', 'tmp'), { recursive: true });
    mkdirSync(tree);
    execFileSync('git', ['init', '-q'], { cwd: copy });
    writeFileSync(join(copy, '.agent', 'tmp', 'check.mjs'), '// own\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('отдельное слово — в кавычках; внутри значения X=… и в уже открытых кавычках — как есть', () => {
    const full = join(copy, '.agent/tmp/check.mjs');
    expect(expandCopyPaths('node .agent/tmp/check.mjs {report}', copy, tree)).toEqual({
      line: `node "${full}" {report}`,
      expanded: ['.agent/tmp/check.mjs'],
    });
    expect(expandCopyPaths('set P=.agent/tmp/check.mjs&& node x', copy, tree).line).toBe(
      `set P=${full}&& node x`,
    );
    expect(expandCopyPaths('node ".agent/tmp/check.mjs"', copy, tree).line).toBe(`node "${full}"`);
  });
});
