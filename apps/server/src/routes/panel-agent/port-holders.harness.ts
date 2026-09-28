import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';

/**
 * Держатели портов для проверок `free_port` (U4a). Сирота — процесс, чей
 * родитель уже вышел: в дерево процесса панели (здесь — процесса теста) он не
 * входит, и агент вправе предложить его погасить. Прямой ребёнок — наоборот,
 * часть дерева панели, и отказ обязателен.
 */

export async function freeTcpPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as { port: number }).port;
  await new Promise((done) => probe.close(done));
  return port;
}

const listenCode = (port: number) =>
  `require('node:net').createServer().listen(${port}, '127.0.0.1'); setInterval(() => {}, 1 << 30);`;

function accepts(port: number): Promise<boolean> {
  return new Promise((settle) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const done = (ok: boolean) => {
      socket.destroy();
      settle(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

/** Ждать, пока порт начнёт (или перестанет) принимать соединения. */
export async function waitListening(port: number, listening = true): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await accepts(port)) === listening) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`port ${port} never became ${listening ? 'busy' : 'free'}`);
}

/** Сирота на порту: посредник запускает отвязанного слушателя и выходит. */
export async function spawnOrphanListener(port: number): Promise<number> {
  const launcher = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
    listenCode(port),
  )}], { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); console.log(c.pid);`;
  const pid = await new Promise<number>((done, fail) => {
    const middle = spawn(process.execPath, ['-e', launcher], {
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    let out = '';
    middle.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    middle.once('error', fail);
    middle.once('exit', () => {
      const value = Number(out.trim());
      if (Number.isInteger(value) && value > 0) done(value);
      else fail(new Error(`orphan launcher printed «${out}»`));
    });
  });
  await waitListening(port);
  return pid;
}

/** Прямой ребёнок процесса теста на порту — часть дерева «панели». */
export async function spawnChildListener(port: number) {
  const child = spawn(process.execPath, ['-e', listenCode(port)], {
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitListening(port);
  return child;
}

export function killQuietly(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // уже вышел
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
