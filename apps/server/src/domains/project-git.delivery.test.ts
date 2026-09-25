import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StoredSplitSettings } from '@agentdeck/contracts/task-split';
import { addWorktree, chatDeliveryFor, resolveProjectDelivery } from './project-git.ts';
import type { DeliverySource } from './project-git/delivery.ts';

/**
 * Доставка до MR: что панель выводит о проекте сама. Всё на настоящем git —
 * удалённый репозиторий, копия через `git worktree`, — потому что вывод
 * строится ровно из этих чтений, и подделка доказала бы только себя.
 */

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

function gitIn(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
}

function source(
  input: { enabled?: boolean; stored?: StoredSplitSettings; bootstrap?: string } = {},
): DeliverySource {
  return {
    getSettings: () => ({ deliverToMr: input.enabled ?? true }),
    getWorktreeMirror: () => (input.bootstrap !== undefined ? { bootstrap: input.bootstrap } : {}),
    getSplitSettings: () => input.stored ?? { deliver: true },
  };
}

describe('доставка до MR: профиль проекта', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-delivery-'));
    gitIn(dir, ['init', '-q', '-b', 'main']);
    gitIn(dir, [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ]);
  });
  afterEach(() => dropTemp(dir));

  it('без удалённого репозитория доставка не действует, с ним — действует', () => {
    const bare = resolveProjectDelivery(source(), dir);
    expect(bare.view.profile).toMatchObject({ repo: true, remote: false });
    expect(bare.active).toBe(false);
    expect(chatDeliveryFor(source(), dir)).toBeUndefined();

    gitIn(dir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git']);
    const withRemote = resolveProjectDelivery(source(), dir);
    expect(withRemote.view.profile.remote).toBe(true);
    expect(withRemote.active).toBe(true);
    expect(chatDeliveryFor(source(), dir)).toContain('Доставка до MR');
  });

  it('не репозиторий — так и сказано, доставки нет', () => {
    const plain = mkdtempSync(join(tmpdir(), 'cc-delivery-plain-'));
    try {
      const outside = resolveProjectDelivery(source(), plain);
      expect(outside.view.profile).toMatchObject({ repo: false, remote: false });
      expect(outside.active).toBe(false);
    } finally {
      dropTemp(plain);
    }
  });

  it('главный выключатель и настройка проекта гасят доставку каждый сам', () => {
    gitIn(dir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git']);
    expect(resolveProjectDelivery(source({ enabled: false }), dir).active).toBe(false);
    expect(resolveProjectDelivery(source({ stored: { deliver: false } }), dir).active).toBe(false);
    expect(chatDeliveryFor(source({ enabled: false }), dir)).toBeUndefined();
  });

  it('навык проекта найден по имени и назван агенту', () => {
    gitIn(dir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git']);
    mkdirSync(join(dir, '.claude', 'skills', 'acme-ticket-delivery'), { recursive: true });
    mkdirSync(join(dir, '.claude', 'skills', 'other'), { recursive: true });
    expect(resolveProjectDelivery(source(), dir).view.profile.skill).toBe('acme-ticket-delivery');
    expect(chatDeliveryFor(source(), dir)).toContain('`acme-ticket-delivery`');
  });

  it('групп разом: заданное человеком, иначе по тяжести подготовки копии', () => {
    const light = resolveProjectDelivery(source(), dir).view;
    expect(light).toMatchObject({ parallel: 8, parallelAuto: true });
    expect(light.profile.heavy).toBe(false);

    for (const name of ['a', 'b']) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'package-lock.json'), '{}');
    }
    const heavy = resolveProjectDelivery(source(), dir).view;
    // Четыре — решение владельца по живому прогону 24.09.2026.
    expect(heavy).toMatchObject({ parallel: 4, parallelAuto: true });
    expect(heavy.profile.bootstrap).toContain('[a] npm ci');
    expect(heavy.profile.bootstrapConfigured).toBe(false);

    const pinned = resolveProjectDelivery(source({ stored: { deliver: true, parallel: 12 } }), dir);
    expect(pinned.view).toMatchObject({ parallel: 12, parallelAuto: false });
    // Настроенная команда — одна, лёгкая, и помечена как заданная человеком.
    const configured = resolveProjectDelivery(source({ bootstrap: 'make setup' }), dir).view;
    expect(configured.profile).toMatchObject({
      bootstrap: 'make setup',
      bootstrapConfigured: true,
      heavy: false,
    });
  });

  it('чат в копии относится к основной копии: её настройка и её навык', async () => {
    gitIn(dir, ['remote', 'add', 'origin', 'https://example.invalid/repo.git']);
    mkdirSync(join(dir, '.claude', 'skills', 'acme-ticket-delivery'), { recursive: true });
    const created = await addWorktree(dir, 'feature/x');
    const copy = created.path;
    const seen: string[] = [];
    const tracking: DeliverySource = {
      ...source(),
      getSplitSettings: (path) => {
        seen.push(path);
        return { deliver: true };
      },
    };
    expect(chatDeliveryFor(tracking, copy)).toContain('`acme-ticket-delivery`');
    expect(seen.every((path) => !path.includes('feature'))).toBe(true);
  });
});
