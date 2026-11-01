import { runRecorderProcess } from '../adapters/layer-run/recorder.ts';

/**
 * Запись хука человека в режиме `observe` (P87, G7): `run.ts recorder --log <журнал> --hook <ключ>
 * --observed <список>`. Исполнение команды и журнал — `adapters/layer-run/recorder.ts` (процессы и
 * файлы мостам MCP недоступны); здесь — только поток процесса. Код всегда 0: вердикт хука CLI
 * не получает.
 */
export async function runRecorder(argv: readonly string[]): Promise<number> {
  return runRecorderProcess(argv, {
    stdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    env: { ...process.env },
    cwd: process.cwd(),
  });
}
