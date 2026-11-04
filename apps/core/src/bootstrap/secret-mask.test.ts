import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CREATED, deps, openFresh } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { dlpSecretMask } from './secret-mask.ts';

/**
 * Маска журнала, которую подключает загрузка (P61), через настоящий журнал в обе стороны:
 * хеши и коммиты — идентификаторы, а не секреты (без них `task.created` с хешем профиля и
 * `layer.changed` отвергались схемой, ref и ключ идемпотентности ложились «••••••»); настоящий
 * ключ, в том числе hex под секретным именем, по-прежнему не доходит до диска.
 */
const SHA256 = createHash('sha256').update('profile').digest('hex');
const GIT_SHA = createHash('sha1').update('commit').digest('hex');
const VENDOR_KEY = 'sk-ant-api03-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVbNm';
const HEX_TOKEN = createHash('sha1').update('token').digest('hex');

describe('journal secret mask wired by boot', () => {
  it('a DLP mask label after "key:" is already masked — the session prompt keeps it verbatim', () => {
    // The panel masks a pasted key as [КЛЮЧ_1]; the journal mask used to take the label for the
    // value of the "key:" pair and hide it as ••••••, so the model never saw the label.
    const prompt = 'Human (current request): Here is the key: [КЛЮЧ_1]';
    expect(dlpSecretMask(prompt)).toEqual({ text: prompt, count: 0 });
  });

  it('B1 hash- and commit-shaped identifiers reach the journal verbatim', async () => {
    const { task, dir, taskId } = await openFresh(undefined, deps({ mask: dlpSecretMask }));
    task.append({
      kind: 'task.created',
      actor: 'core',
      data: {
        ...CREATED,
        profilePins: [{ repoKey: 'r1', inputsFp: SHA256 }],
        userLayerHash: SHA256,
        repos: [{ repoKey: 'r1', path: '/tmp/r1', baseRef: GIT_SHA }],
      },
    });
    task.append({ kind: 'layer.changed', actor: 'core', data: { userLayerHash: SHA256 } });
    task.append({
      kind: 'action.started',
      actor: 'core',
      data: { actionId: newId(), kind: 'push', target: 'origin/feature', idempotencyHint: GIT_SHA },
    } as never);
    task.close();
    const lines = readJournalLines(dir, taskId).lines;
    const created = lines.find((l) => l.kind === 'task.created')!;
    const data = created.data as typeof CREATED;
    expect(data.profilePins[0]!.inputsFp).toBe(SHA256);
    expect(data.userLayerHash).toBe(SHA256);
    expect(data.repos[0]!.baseRef).toBe(GIT_SHA);
    expect(created.masked).toBeUndefined();
    expect(lines.find((l) => l.kind === 'layer.changed')!.data).toEqual({ userLayerHash: SHA256 });
    const started = lines.find((l) => l.kind === 'action.started')!.data as {
      idempotencyHint: string;
    };
    expect(started.idempotencyHint).toBe(GIT_SHA);
  });

  it('a repo path whose mkdtemp folder has a word with a digit (cc-t3-…) reaches the journal verbatim', async () => {
    // The opaque-key detector took `cc-t3-codex-project-gl9Kjc` for a key: `t3` was not a «word»,
    // so the words-with-tail exemption missed it, and the task lost its repo path on disk.
    const path = 'C:\\Temp\\cc-t3-codex-project-gl9Kjc';
    const { task, dir, taskId } = await openFresh(undefined, deps({ mask: dlpSecretMask }));
    task.append({
      kind: 'task.created',
      actor: 'core',
      data: { ...CREATED, repos: [{ repoKey: 'r1', path, baseRef: GIT_SHA }] },
    });
    task.close();
    const created = readJournalLines(dir, taskId).lines.find((l) => l.kind === 'task.created')!;
    expect((created.data as typeof CREATED).repos[0]!.path).toBe(path);
    expect(created.masked).toBeUndefined();
  });

  it('B1 a real key is still masked: vendor prefix, and hex under a secret name', async () => {
    const { task, dir, taskId } = await openFresh(undefined, deps({ mask: dlpSecretMask }));
    task.append({
      kind: 'error',
      actor: 'core',
      data: { code: 'leak', detail: `key ${VENDOR_KEY} and GITHUB_TOKEN=${HEX_TOKEN}` },
    });
    task.close();
    const raw = readJournalLines(dir, taskId).lines.find((l) => l.kind === 'error')!;
    const text = JSON.stringify(raw);
    expect(text).not.toContain(VENDOR_KEY);
    expect(text).not.toContain(HEX_TOKEN);
    expect(raw.masked).toBe(2);
  });

  it('W2b a panel endpoint route id (api-key:endpoint:<id> with digits) reaches the journal verbatim; a key under api-key: is still masked', async () => {
    // Настоящий id карточки панели: `ep-<время36>-<хвост>` (EndpointCard.addProfile).
    const ROUTE = 'api-key:endpoint:ep-mh1abc23-x9k2ab';
    const { task, dir, taskId } = await openFresh(undefined, deps({ mask: dlpSecretMask }));
    task.append({
      kind: 'task.created',
      actor: 'core',
      data: {
        ...CREATED,
        allowedRoutes: [
          { adapter: 'claude', route: { kind: 'api-key', id: ROUTE }, modelPattern: '*' },
        ],
      } as never,
    });
    task.append({
      kind: 'error',
      actor: 'core',
      data: { code: 'leak', detail: `api-key: hunter2-pass9 and api-key:endpoint:${VENDOR_KEY}` },
    });
    task.close();
    const lines = readJournalLines(dir, taskId).lines;
    const created = lines.find((l) => l.kind === 'task.created')!;
    expect(
      (created.data as { allowedRoutes: { route: { id: string } }[] }).allowedRoutes[0]!.route.id,
    ).toBe(ROUTE);
    expect(created.masked).toBeUndefined();
    const text = JSON.stringify(lines.find((l) => l.kind === 'error')!);
    expect(text).not.toContain('hunter2-pass9');
    expect(text).not.toContain(VENDOR_KEY);
  });
});
