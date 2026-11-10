import { newId } from '../../../lib/ids/uuidv7.ts';
import { addEntries } from '../moves.ts';
import { createBoardStore } from '../store.ts';

/**
 * Дочерний процесс хранилища доски (этап 12, P181) под настоящим node:
 *  - `crash <root> <cmdId>` — одна правка через настоящий `update` и SIGKILL сразу после неё:
 *    процесс не доходит ни до какой уборки, как при падении питания после записи.
 *  - `churn <root> <n>` — `n` правок подряд, каждая — атомарная замена файла (читатель рядом).
 */

const [mode, home, arg] = process.argv.slice(2);
if (!mode || !home || !arg) throw new Error('usage: store-child <crash|churn> <root> <arg>');
const root: string = home;
const store = createBoardStore({ root });
// Длинное тело, чтобы запись файла не была одной мгновенной операцией: окно разрыва видно.
const request = 'x'.repeat(4000);

function add(cmdId: string, title: string): void {
  const got = store.update(cmdId, Date.now(), (file) => {
    const created = addEntries(
      file,
      {
        cmdId,
        to: 'inbox',
        entries: [
          {
            preset: 'feature',
            source: { kind: 'manual', title },
            launch: {
              kind: 'fields',
              fields: { title, request, repos: [{ path: root, baseRef: null }] },
            },
          },
        ],
      },
      Date.now(),
      'mr',
      newId,
    );
    return { ok: true, created };
  });
  if (!got.ok) throw new Error('update refused');
}

if (mode === 'crash') {
  add(arg, 'written before the crash');
  process.stdout.write('written\n');
  process.kill(process.pid, 'SIGKILL');
} else {
  for (let i = 0; i < Number(arg); i += 1) add(newId(), `churn ${i}`);
  process.stdout.write('done\n');
}
