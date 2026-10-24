#!/usr/bin/env node
// Хук `PreToolUse` разового хода без инструментов (`RunOptions.denyTools`, пинг
// тёплого кэша): любой вызов отклоняется ДО исполнения. Код 2 — блок по
// протоколу хуков Claude Code, текст stderr уходит модели объяснением; он
// работает, даже если вывод не разберётся как JSON. Ввод (описание вызова)
// дочитываем: CLI пишет его в stdin, и ранний выход рвал бы ему трубу.
/* global process, setTimeout */
process.stdin.on('data', () => undefined);
process.stdin.on('end', deny);
process.stdin.on('error', deny);
// Ввода нет вовсе (stdin закрыт с начала) — не ждём его дольше секунды.
setTimeout(deny, 1_000).unref();

function deny() {
  process.stderr.write('Tools are disabled for this keep-alive turn: reply with one word.\n');
  process.exit(2);
}
