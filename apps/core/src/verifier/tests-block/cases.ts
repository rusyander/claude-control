import type { Fact } from '@agentdeck/contracts/core/facts';
import { join } from 'node:path';
import { listDir, readBytesSync } from '../../platform/safe-io/files.ts';
import type { LinkedCase } from './tests-block.types.ts';

/**
 * Связанные кейсы хранилища `<main checkout>/.agent/tests/` (формат блока тестов: группа —
 * `<id>.tests.json`, часть большой группы несёт ключ `group` — её кейсы принадлежат той группе).
 * Битая группа — `unknown` целиком: прогон, записанный мимо кейса, которого не прочли, хуже
 * отказа (вердикт кейса не должен зависеть от того, какой файл случайно разобрался).
 */

export const GROUP_SUFFIX = '.tests.json';

function linkedOf(groupId: string, raw: unknown): LinkedCase | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as { id?: unknown; automation?: unknown };
  if (typeof c.id !== 'string' || !c.automation || typeof c.automation !== 'object') return null;
  const a = c.automation as { status?: unknown; file?: unknown; testName?: unknown };
  if (a.status !== 'automated' || typeof a.file !== 'string' || a.file === '') return null;
  return {
    groupId,
    caseId: c.id,
    file: a.file.replace(/\\/g, '/'),
    ...(typeof a.testName === 'string' && a.testName !== '' ? { testName: a.testName } : {}),
  };
}

export function readLinkedCases(store: string): Fact<LinkedCase[]> {
  const names = listDir(store);
  if (!('value' in names)) return names;
  const out: LinkedCase[] = [];
  for (const name of names.value.filter((n) => n.endsWith(GROUP_SUFFIX)).sort()) {
    const bytes = readBytesSync(join(store, name));
    // Файл пропал между списком и чтением — то же сомнение, что и нечитаемый.
    if (!('value' in bytes))
      return { unknown: `${name}: ${'unknown' in bytes ? bytes.unknown : 'исчез при чтении'}` };
    let body: { group?: unknown; cases?: unknown };
    try {
      body = JSON.parse(bytes.value.toString('utf8')) as typeof body;
    } catch {
      return { unknown: `${name}: не JSON` };
    }
    const groupId =
      typeof body.group === 'string' && body.group !== ''
        ? body.group
        : name.slice(0, -GROUP_SUFFIX.length);
    if (!Array.isArray(body.cases)) continue; // индекс разбитой группы: кейсы в частях
    for (const raw of body.cases) {
      const linked = linkedOf(groupId, raw);
      if (linked) out.push(linked);
    }
  }
  return { value: out };
}
