import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RunInputRecord } from '@agentdeck/contracts/run-input';
import type { RunOptions } from './ChatRunner.ts';

/**
 * «Что получил агент» (U8) обязан совпадать с тем, что получил CLI, — иначе
 * окно сверки само стало бы местом, где теряется текст. Поэтому сверяем не
 * запись с ожиданием, а запись с НАСТОЯЩИМ запуском: тот же прогон уходит через
 * `ChatRun.start` с подменённым `spawn`, и дописка из файла флага, промпт
 * контура, модель, глубина и вход процесса сравниваются с записью.
 */

class FakeChild extends EventEmitter {
  stdinText = '';
  readonly stdin = Object.assign(new EventEmitter(), {
    write: (chunk: string): boolean => {
      this.stdinText += chunk;
      return true;
    },
    end: () => undefined,
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

interface Launched {
  args: string[];
  files: Record<string, string>;
  stdin: string;
  record: RunInputRecord;
}

/** Запуск на Windows: дописка и промпт контура едут файлами — их и читаем. */
async function launch(options: RunOptions): Promise<Launched> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  vi.stubEnv('TEMP', tmpdir());
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  const child = new FakeChild();
  const seen = { args: [] as string[], files: {} as Record<string, string> };
  vi.resetModules();
  vi.doMock('node:child_process', () => ({
    spawn: (_command: string, args: string[]) => {
      seen.args = args;
      args.forEach((arg, index) => {
        if (/^--(append-)?system-prompt-file$/.test(arg)) {
          const path = (args[index + 1] ?? '').replace(/^"|"$/g, '');
          seen.files[arg] = readFileSync(path, 'utf8');
        }
      });
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    },
    spawnSync: () => ({ status: 0 }),
  }));

  try {
    const { ChatRun, receivedInputOf } = await import('./ChatRunner.ts');
    const record = receivedInputOf(options, 1);
    await new ChatRun().start(options, () => undefined);
    return { args: seen.args, files: seen.files, stdin: child.stdinText, record };
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
}

const valueOf = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('ChatRun: «что получил агент» совпадает с запуском', () => {
  it('ребёнок разделения: дописка с его правилами, промпт контура, модель и вход — как у CLI', async () => {
    const run = await launch({
      prompt: 'Задание звена ревью: прочитай дифф.',
      cwd: process.cwd(),
      child: true,
      appendSystemPrompt: 'Текст панели о группе {"done":"x"}',
      workspaceNote: 'В проекте есть тесты: npm test.',
      platformSystemPrompt: 'Промпт контура.\nВторая строка.',
      model: 'claude-opus-5',
      effort: 'high',
      permissionMode: 'auto',
    });

    expect(run.record.appendSystemPrompt).toBe(run.files['--append-system-prompt-file']);
    // Правила ребёнка — часть дописки: запись без них соврала бы о входе группы.
    expect(run.record.appendSystemPrompt).toContain('Текст панели о группе');
    expect(run.record.appendSystemPrompt).toContain('В проекте есть тесты: npm test.');
    expect(run.record.appendSystemPrompt).not.toBe(
      'Текст панели о группе {"done":"x"}\n\nВ проекте есть тесты: npm test.',
    );
    expect(run.record.systemPrompt).toBe(run.files['--system-prompt-file']);
    expect(run.record.model).toBe(valueOf(run.args, '--model'));
    expect(run.record.effort).toBe(valueOf(run.args, '--effort'));
    expect(run.record.permissionMode).toBe(valueOf(run.args, '--permission-mode'));
    expect(run.stdin).toContain(run.record.prompt);
  });

  it('снятая контуром дописка не записывается, отвергнутое имя модели — тоже', async () => {
    const run = await launch({
      prompt: 'ход',
      cwd: process.cwd(),
      appendSystemPrompt: 'Текст панели',
      platformDropAppend: true,
      model: 'bad model & rm',
    });

    expect(run.files['--append-system-prompt-file']).toBeUndefined();
    expect(run.record.appendSystemPrompt).toBeUndefined();
    expect(valueOf(run.args, '--model')).toBeUndefined();
    expect(run.record.model).toBeUndefined();
  });
});
