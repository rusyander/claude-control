// Подставной раннер модели: настоящий процесс, отвечает модельными путями через общую библиотеку
// `@agentdeck/stub-model` (11 R:PR-09; не через tools/qa — их нет в копии для Linux-прогона) и
// «занимает память карты»: пишет `<pid>.json` с байтами в FAKE_VRAM_DIR. Подставное чтение
// памяти в тесте суммирует байты ЖИВЫХ раннеров — сирота держит память, как настоящая.
//
// `--orphan`: двойной запуск — посредник поднимает настоящего раннера отвязанным и БЕЗ метки
// дерева, передаёт его строку готовности и выходит. Такого раннера не видит ни обход дерева
// (родитель умер), ни поиск по метке — ровно сирота случая владельца 12.09.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubModel } from '@agentdeck/stub-model';

const args = process.argv.slice(2);
if (args[0] === '--orphan') {
  const env = { ...process.env };
  delete env.AGENTDECK_TREE;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args.slice(1)], {
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  let seen = '';
  child.stdout.on('data', (chunk) => {
    seen += chunk;
    const line = /READY \d+\n/.exec(seen)?.[0];
    if (!line) return;
    process.stdout.write(line, () => {
      child.stdout.destroy();
      child.unref();
      process.exit(0);
    });
  });
} else {
  const [alias, bytes] = args;
  const stub = await startStubModel({
    models: [alias],
    script: () => ({ text: 'function merge() {}' }),
  });
  writeFileSync(
    join(process.env.FAKE_VRAM_DIR, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      bytes: Number(bytes),
      port: stub.port,
      writtenAt: Date.now(),
    }),
  );
  process.stdout.write(`READY ${stub.port}\n`);
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 60_000);
}
