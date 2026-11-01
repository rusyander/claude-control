import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionAsk } from '../../adapters/adapter.types.ts';
import { foldsCaseAt } from '../../platform/paths.ts';
import { decidePermit } from './permit.ts';
import type { PermitContext } from './permit.types.ts';

/**
 * R7: маска `grantRequired`, гранта и своих путей против пути копии — правилом тома, тем же, что у
 * вопроса до запуска (`estimate/grants.ts`). Windows/macOS регистр не различают — `Migrations/1.sql`
 * тот же файл под замком; на Linux это другой файл, и замок чужого регистра его не накрывает (был
 * всегда свёрнутый регистр: лишний отказ и пункт человека 5 на чужом файле).
 */

const copyRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'permit-case-')));
const folds = foldsCaseAt(copyRoot);

const ctx = (over: Partial<PermitContext> = {}): PermitContext => ({
  copyRoot,
  ownedPaths: [],
  deny: { paths: [], commands: [], mcpTools: [], tools: [] },
  platformPaths: [join(tmpdir(), 'permit-case-core-home')],
  endpointSources: [],
  grantRequired: [{ globs: ['migrations/**'], ops: ['edit'] }],
  grants: [],
  ...over,
});

const edit = (rel: string): PermissionAsk => ({
  action: 'edit',
  target: join(copyRoot, rel),
  tool: 'Edit',
  display: `Edit ${rel}`,
});

describe('R7 case fold per volume in the permit judge', () => {
  it('the platform default holds for the temp volume (Windows/macOS fold, Linux exact)', () => {
    expect(folds).toBe(process.platform !== 'linux');
  });

  it('a grantRequired glob in another case: locked where the volume folds, open where it does not', () => {
    expect(decidePermit(edit('migrations/1.sql'), ctx())).toMatchObject({
      allow: false,
      code: 'grant-required',
    });
    const other = decidePermit(edit('Migrations/1.sql'), ctx());
    if (folds) expect(other).toMatchObject({ allow: false, code: 'grant-required' });
    else expect(other).toMatchObject({ allow: true });
  });

  it('a grant and owned paths follow the same rule', () => {
    const granted = ctx({ grants: [{ globs: ['Migrations/**'], ops: ['edit'] }] });
    const viaGrant = decidePermit(edit('migrations/1.sql'), granted);
    if (folds) expect(viaGrant).toMatchObject({ allow: true });
    else expect(viaGrant).toMatchObject({ allow: false, code: 'grant-required' });
    const owned = decidePermit(edit('Src/a.ts'), ctx({ ownedPaths: ['src'] }));
    expect(owned).toMatchObject({ allow: true, signal: folds ? null : 'ownership' });
  });
});
