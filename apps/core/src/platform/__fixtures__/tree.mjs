/**
 * Дерево процессов для тестов остановки (P53) и личности (P12). Голый node, без типов.
 * argv: <каталог состояния> <роль>. План в TREE_PLAN: `root>mid,mid>leaf,mid>orphan*`
 * (`*` — отвязанный ребёнок). Каждый пишет `<роль>.pid`; роль с `listen` в имени слушает
 * 127.0.0.1:0 и пишет `<роль>.port`; файл `<роль>.exit` — сигнал выйти.
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const [dir, role] = process.argv.slice(2);
const script = process.argv[1];
const plan = (process.env.TREE_PLAN ?? '').split(',').filter(Boolean);

for (const edge of plan.filter((item) => item.startsWith(`${role}>`))) {
  const kid = edge.slice(role.length + 1);
  const detached = kid.endsWith('*');
  const name = kid.replace('*', '');
  const child = spawn(process.execPath, [script, dir, name], {
    detached,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (detached) child.unref();
}

function ready() {
  writeFileSync(join(dir, `${role}.pid`), String(process.pid));
}

if (role.includes('listen')) {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    writeFileSync(join(dir, `${role}.port`), String(server.address().port));
    ready();
  });
} else {
  ready();
}

process.on('SIGTERM', () => {
  if (process.env.TREE_IGNORE_TERM === role) return;
  process.exit(0);
});

// Тест, убитый посреди прогона (таймаут раннера, мутант, ломающий саму остановку), не
// оставляет вечных процессов: каталог состояния удалён или срок вышел — выходим сами.
// Отвязанный слушатель Windows иначе жил часами (замер 28.10: 7 штук после прогонов мутантов).
const born = Date.now();
const maxMs = Number(process.env.TREE_MAX_MS ?? 180_000);
setInterval(() => {
  if (existsSync(join(dir, `${role}.exit`))) process.exit(0);
  if (!existsSync(dir) || Date.now() - born > maxMs) process.exit(0);
}, 50);
