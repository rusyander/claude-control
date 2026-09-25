/**
 * "Server A" for the restart test: a real registry + real ledger in its own
 * process, so the test can kill it the way `node --watch` / the dev watcher does
 * on Windows (TerminateProcess, no shutdown handlers).
 *
 * argv: <appDataDir> <cwd> <command> <prompt>. Prints one line `IDLE <json>`
 * once the turn is over and the ledger holds the waiting session, then idles
 * until killed. `REGISTRY_DIR` points at another chat domain folder (red-before
 * runs it against the pre-relay code).
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [appData, cwd, command, prompt] = process.argv.slice(2);
const dir = process.env.REGISTRY_DIR ?? join(import.meta.dirname, '..');
const registryModule = (await import(
  pathToFileURL(join(dir, 'ChatRunRegistry.ts')).href
)) as typeof import('../ChatRunRegistry.ts');
const ledgerModule = (await import(
  pathToFileURL(join(dir, 'run-ledger.ts')).href
)) as typeof import('../run-ledger.ts');

const registry = new registryModule.ChatRunRegistry();
const ledger = new ledgerModule.RunLedger(appData as string);
registry.setLedger(ledger);
let text = '';
registry.start('new-r', { prompt: prompt as string, cwd: cwd as string, command }, {});
registry.attach('new-r', 0, {
  send: (buffered) => {
    if (buffered.event.kind === 'text') text += buffered.event.text;
  },
  close: () => undefined,
});

const until = Date.now() + 20_000;
for (;;) {
  const entry = ledger.read().find((item) => item.key === 'new-r' || item.sessionId);
  // EARLY=1: report as soon as the ledger knows every pid, mid-turn included.
  const idle = process.env.EARLY === '1' || !registry.isRunning('new-r');
  const settled = idle && (entry?.pids?.length ?? 0) > 0 && Boolean(entry?.sessionId);
  // Pre-relay code never writes `pids`; it is done once the turn is over.
  const legacy = process.env.REGISTRY_DIR && !registry.isRunning('new-r');
  if (settled || legacy || Date.now() > until) {
    process.stdout.write(`IDLE ${JSON.stringify({ text, entries: ledger.read() })}\n`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
// Any stdin line = graceful exit, the way `runtime.shutdown` runs on Ctrl+C,
// SIGTERM or a normal exit (W3-4a). With stdin ignored this never fires.
process.stdin.on('data', () => {
  registry.detachAll();
  process.exit(0);
});
setInterval(() => undefined, 60_000);
