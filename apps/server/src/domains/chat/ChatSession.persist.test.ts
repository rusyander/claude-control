import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import { ChatSession } from './ChatSession.ts';
import { RunLedger } from './run-ledger.ts';
import type { ChatEvent, RunOptions } from './ChatRunner.ts';

/**
 * Тумблер автоподтверждения переживает перезапуск панели (находка 16b, TASKS.md
 * «Авторежим прав по умолчанию во всех чатах»). Живой прогон 24.09.2026: у
 * родителя без идущего прогона тумблер жил только в памяти, и группы,
 * заведённые после перезапуска, оставались без него.
 *
 * Перезапуск здесь — НОВЫЕ реестр и `ChatSession` над тем же каталогом данных,
 * связанные так же, как в `bootstrap/runtime.ts`: журнал прогонов со снимком
 * тумблеров. Подменён только сам CLI.
 */
class FakeRun implements RunLike {
  private onEvent?: (event: ChatEvent) => void;
  private finish?: () => void;

  start(_options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    return new Promise<void>((resolve) => {
      this.finish = resolve;
    });
  }

  stop(): void {}

  emit(event: ChatEvent): void {
    this.onEvent?.(event);
  }

  end(): void {
    this.finish?.();
  }
}

const OPTIONS: RunOptions = { prompt: 'привет', cwd: 'C:/work/app' };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-toggles-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Сервер панели: реестр, журнал, тумблеры — как в `bootstrap/runtime.ts`. */
function boot(fake = new FakeRun()) {
  const registry = new ChatRunRegistry(() => fake);
  const session = new ChatSession(registry, dir);
  registry.setLedger(new RunLedger(dir), (key) => session.snapshotForLedger(key));
  return { registry, session, fake };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('ChatSession — тумблер переживает перезапуск', () => {
  it('родитель без прогона: дети после перезапуска наследуют тумблер по sessionId', async () => {
    const before = boot();
    before.session.armAutoApprove('new-1', { enabled: true, allowEdits: true });
    before.registry.start('new-1', OPTIONS, {});
    before.fake.emit({ kind: 'session', sessionId: 'sess-1', model: 'opus', tools: 0 });
    before.fake.end();
    await flush();

    const after = boot();
    // Карточка разделения знает родителя по sessionId — им и приходит `parentChatId`.
    after.session.inherit(['sess-1'], 'new-2');

    expect(after.session.autoApproveFor('new-2')).toEqual({ enabled: true, allowEdits: true });
    expect(after.session.autoApproveFor('sess-1')).toEqual({ enabled: true, allowEdits: true });
    expect(after.session.autoApproveFor('new-1')).toEqual({ enabled: true, allowEdits: true });
  });

  it('метка «унаследован от родителя» переживает перезапуск; щелчок человека её снимает', () => {
    const before = boot();
    before.session.armAutoApprove('parent', { enabled: true, allowEdits: true });
    before.session.inherit(['parent'], 'group', true);

    const after = boot();
    expect(after.session.autoApproveFor('group')).toEqual({
      enabled: true,
      allowEdits: true,
      inherited: true,
    });
    after.session.toggleAutoApprove('group', true);
    expect(after.session.autoApproveFor('group')).toEqual({ enabled: true, allowEdits: true });
  });

  it('щелчок тумблера на ходу — новое положение и после перезапуска', async () => {
    const before = boot();
    before.session.armAutoApprove('new-1', { enabled: true, allowEdits: false });
    before.registry.start('new-1', OPTIONS, {});
    before.fake.emit({ kind: 'session', sessionId: 'sess-1', model: 'opus', tools: 0 });
    before.session.toggleAutoApprove('sess-1', false);
    before.fake.end();
    await flush();

    const after = boot();

    expect(after.session.autoApproveFor('sess-1')).toEqual({ enabled: false, allowEdits: false });
  });

  it('щелчок тумблера между ходами (прогон не идёт) — тоже переживает перезапуск', async () => {
    const before = boot();
    before.session.armAutoApprove('new-1', { enabled: true, allowEdits: false });
    before.registry.start('new-1', OPTIONS, {});
    before.fake.emit({ kind: 'session', sessionId: 'sess-1', model: 'opus', tools: 0 });
    before.fake.end();
    await flush();
    // Журнал прогонов молчит: прогона нет, и на диск тумблер кладёт только сам щелчок.
    before.session.toggleAutoApprove('sess-1', false);

    const after = boot();

    expect(after.session.autoApproveFor('sess-1')).toEqual({ enabled: false, allowEdits: false });
  });

  it('остановленный разговор тумблер не держит и после перезапуска', async () => {
    const before = boot();
    before.session.armAutoApprove('new-1', { enabled: true, allowEdits: true });
    before.registry.start('new-1', OPTIONS, {});
    before.fake.emit({ kind: 'session', sessionId: 'sess-1', model: 'opus', tools: 0 });
    before.session.abort('sess-1');
    before.fake.end();
    await flush();

    const after = boot();

    expect(after.session.autoApproveFor('new-1')).toBeUndefined();
    expect(after.session.autoApproveFor('sess-1')).toBeUndefined();
  });

  it('без каталога данных — только память, как прежде', () => {
    const registry = new ChatRunRegistry(() => new FakeRun());
    const session = new ChatSession(registry);
    session.armAutoApprove('new-1', { enabled: true, allowEdits: true });

    expect(new ChatSession(registry).autoApproveFor('new-1')).toBeUndefined();
    expect(session.autoApproveFor('new-1')).toEqual({ enabled: true, allowEdits: true });
  });

  it('битый файл тумблеров — пустая память, а не упавший сервер', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'chat-toggles.json'), '{ не json');
    const { session } = boot();

    expect(session.autoApproveFor('sess-1')).toBeUndefined();
  });
});
