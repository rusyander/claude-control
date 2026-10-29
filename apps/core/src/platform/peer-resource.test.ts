import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { peerFromTable, peerPid } from './peer-pid.ts';
import {
  containersByLabel,
  diffDir,
  diffListeners,
  listWorktrees,
  listeningPorts,
  listenersOfTree,
  parseDockerPs,
  snapshotDir,
} from './resource-scan.ts';
import { parseLsofTcp, parseProcNetTcp, parseWinTcp, type TcpEntry } from './tcp-table.ts';
import { currentOs, hasValue } from './os-kind.ts';
import { identityOfPid } from './process-identity.ts';
import { samePath } from './paths.ts';
import type { runTool } from './run-tool.ts';

let root = '';
const children: ChildProcess[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'peer resource ü '));
});
afterAll(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((done, fail) => {
    let text = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      const at = text.indexOf('\n');
      if (at >= 0) done(text.slice(0, at).trim());
    });
    child.once('exit', (code) => fail(new Error(`exited ${code} before a line`)));
  });
}

describe('P107 peer pid of a loopback connection', () => {
  it('P107 a real loopback client in another process → the OS names that process as the peer', async () => {
    const server: Server = createServer();
    const accepted = new Promise<Socket>((done) => server.once('connection', done));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const client = spawn(
      process.execPath,
      [
        '-e',
        `const s=require('net').connect(${address.port},'127.0.0.1',()=>console.log('up'));s.on('error',()=>{});setTimeout(()=>{},60000)`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    children.push(client);
    const socket = await accepted;
    const found = await peerPid({ serverPort: address.port, clientPort: socket.remotePort ?? 0 });
    expect(found).toEqual({ value: client.pid });
    // F-16: полный запрос (адреса обоих концов + pid ядра) сходится с написанием адресов этой ОС.
    const exact = await peerPid({
      serverPort: address.port,
      clientPort: socket.remotePort ?? 0,
      serverAddress: socket.localAddress ?? '',
      clientAddress: socket.remoteAddress ?? '',
      serverPid: process.pid,
    });
    expect(exact).toEqual({ value: client.pid });
    client.kill('SIGKILL');
    socket.destroy();
    server.close();
  }, 30_000);

  it('P107 table unreadable → unknown with the reason, never a guessed pid', async () => {
    const found = await peerPid({ serverPort: 5178, clientPort: 50000 }, currentOs(), async () => ({
      unknown: 'helper blocked',
    }));
    expect(found).toEqual({ unknown: 'helper blocked' });
  });

  it('P107 no client row / owner hidden → unknown; only the client row (local = client port) counts', () => {
    const rows: TcpEntry[] = [
      // Строка сервера: local = порт ядра — её владелец ядро, не звонящий.
      {
        state: 'established',
        localAddress: '127.0.0.1',
        localPort: 5178,
        remoteAddress: '127.0.0.1',
        remotePort: 50000,
        pid: 1,
      },
      {
        state: 'established',
        localAddress: '127.0.0.1',
        localPort: 50000,
        remoteAddress: '127.0.0.1',
        remotePort: 5178,
        pid: 4242,
      },
      {
        state: 'established',
        localAddress: '127.0.0.1',
        localPort: 50001,
        remoteAddress: '127.0.0.1',
        remotePort: 5178,
      },
    ];
    expect(peerFromTable(rows, { serverPort: 5178, clientPort: 50000 })).toEqual({ value: 4242 });
    expect(peerFromTable(rows, { serverPort: 5178, clientPort: 50001 })).toEqual({
      unknown: 'owner not exposed by the OS',
    });
    expect(peerFromTable(rows, { serverPort: 5178, clientPort: 50002 })).toMatchObject({
      unknown: expect.stringContaining('no client row'),
    });
  });

  it('P107 per-OS parsers over recorded outputs: GetExtendedTcpTable lines, /proc/net/tcp{,6}, lsof -F', () => {
    expect(
      parseWinTcp('5 127.0.0.1 50000 127.0.0.1 5178 4242\r\n2 :: 5178 :: 0 77\r\nbad\r\n'),
    ).toEqual([
      {
        state: 'established',
        localAddress: '127.0.0.1',
        localPort: 50000,
        remoteAddress: '127.0.0.1',
        remotePort: 5178,
        pid: 4242,
      },
      {
        state: 'listen',
        localAddress: '::',
        localPort: 5178,
        remoteAddress: '::',
        remotePort: 0,
        pid: 77,
      },
    ]);
    const proc = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:143A 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0',
      '   1: 0100007F:C350 0100007F:143A 01 00000000:00000000 00:00000000 00000000  1000        0 67890 1 0',
    ].join('\n');
    expect(parseProcNetTcp(proc)).toEqual([
      {
        state: 'listen',
        localAddress: '127.0.0.1',
        localPort: 5178,
        remoteAddress: '0.0.0.0',
        remotePort: 0,
        inode: '12345',
      },
      {
        state: 'established',
        localAddress: '127.0.0.1',
        localPort: 50000,
        remoteAddress: '127.0.0.1',
        remotePort: 5178,
        inode: '67890',
      },
    ]);
    const proc6 =
      'header\n   0: 00000000000000000000000001000000:143A 00000000000000000000000000000000:0000 0A 0 0 0 0 0 0 555 1 0\n';
    expect(parseProcNetTcp(proc6)[0]).toMatchObject({
      localAddress: '::1',
      localPort: 5178,
      state: 'listen',
    });
    const lsof =
      'p4242\nf9\nn127.0.0.1:50000->127.0.0.1:5178\nTST=ESTABLISHED\np77\nf3\nn[::1]:5178\nTST=LISTEN\n';
    expect(parseLsofTcp(lsof)).toEqual([
      {
        state: 'established',
        localAddress: '127.0.0.1',
        localPort: 50000,
        remoteAddress: '127.0.0.1',
        remotePort: 5178,
        pid: 4242,
      },
      {
        state: 'listen',
        localAddress: '::1',
        localPort: 5178,
        remoteAddress: '',
        remotePort: 0,
        pid: 77,
      },
    ]);
  });
});

/** Корень → внук, который слушает порт; корень печатает порт внука. */
const LISTENER_TREE = `
const { spawn } = require('child_process');
const g = spawn(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port));setTimeout(()=>{},60000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
g.stdout.on('data', (d) => process.stdout.write(d));
setTimeout(() => {}, 60000);
`;

describe('P90 resources made by a session are found at step end', () => {
  it('P90 a port opened by a grandchild → found in the tree listeners and in the before/after diff', async () => {
    const before = await listeningPorts();
    if (!hasValue(before)) throw new Error(JSON.stringify(before));
    const tree = spawn(process.execPath, ['-e', LISTENER_TREE], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    children.push(tree);
    const port = Number(await firstLine(tree));
    const rootId = await identityOfPid(tree.pid ?? -1);
    if (!hasValue(rootId)) throw new Error('no identity');
    const ofTree = await listenersOfTree(rootId.value);
    if (!hasValue(ofTree)) throw new Error(JSON.stringify(ofTree));
    expect(ofTree.value.map((row) => row.port)).toContain(port);
    const after = await listeningPorts();
    if (!hasValue(after)) throw new Error(JSON.stringify(after));
    expect(diffListeners(before.value, after.value).map((row) => row.port)).toContain(port);
    expect(diffListeners(after.value, after.value)).toEqual([]);
  }, 30_000);

  it('P90 TMPDIR file made / changed / removed → named by the dir diff; missing dir → absent, not empty', () => {
    const dir = mkdtempSync(join(root, 'tmp-'));
    writeFileSync(join(dir, 'kept.txt'), 'a');
    writeFileSync(join(dir, 'gone.txt'), 'a');
    const before = snapshotDir(dir);
    if (!hasValue(before)) throw new Error('no snapshot');
    writeFileSync(join(dir, 'kept.txt'), 'abc');
    writeFileSync(join(dir, 'новый файл.log'), 'x');
    rmSync(join(dir, 'gone.txt'));
    const after = snapshotDir(dir);
    if (!hasValue(after)) throw new Error('no snapshot');
    const diff = diffDir(before.value, after.value);
    expect(diff.added.map((row) => row.name)).toEqual(['новый файл.log']);
    expect(diff.changed.map((row) => row.name)).toEqual(['kept.txt']);
    expect(diff.removed).toEqual(['gone.txt']);
    expect(snapshotDir(join(dir, 'nope'))).toMatchObject({ absent: true });
  });

  it('P90 a worktree added by a session → listed by git with its branch, path in the core spelling', async () => {
    const repo = join(root, 'repo ü');
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: repo,
        stdio: 'ignore',
      });
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
    git('commit', '-q', '--allow-empty', '-m', 'init');
    const wt = join(root, 'wt задача');
    git('worktree', 'add', '-q', '-b', 'task-1', wt);
    const listed = await listWorktrees(repo);
    if (!hasValue(listed)) throw new Error(JSON.stringify(listed));
    const added = listed.value.find((tree) => samePath(tree.path, wt));
    expect(added).toMatchObject({ branch: 'refs/heads/task-1', detached: false });
    expect(listed.value).toHaveLength(2);
  }, 30_000);

  it('P90 containers by task label: engine absent / engine down → unknown, never «none left»', async () => {
    const absent = (async () => ({
      ok: false,
      reason: 'spawn docker ENOENT',
      timedOut: false,
    })) as typeof runTool;
    const down = (async () => ({
      ok: false,
      reason: 'exit 1',
      timedOut: false,
      code: 1,
      stderr: 'error during connect: the docker daemon is not running\n',
    })) as typeof runTool;
    const up = (async () => ({
      ok: true,
      code: 0,
      stdout: 'abc123\tagentdeck-t1-db\trunning\n\n',
      stderr: '',
      timedOut: false,
    })) as typeof runTool;
    expect(await containersByLabel('t1', 'docker', absent)).toEqual({
      unknown: 'engine-absent: spawn docker ENOENT',
    });
    expect(await containersByLabel('t1', 'docker', down)).toMatchObject({
      unknown: expect.stringMatching(/^engine-down: error during connect/),
    });
    expect(await containersByLabel('t1', 'docker', up)).toEqual({
      value: [{ id: 'abc123', name: 'agentdeck-t1-db', state: 'running' }],
    });
    expect(parseDockerPs('\n')).toEqual([]);
  });
});
