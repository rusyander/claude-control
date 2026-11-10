/**
 * Режимы прав Kimi Code: то, что пишет панель, принимает НАСТОЯЩИЙ Kimi 2.4.1.
 *
 * Модульные тесты сверяют писатель с нашим же набором `KIMI_MODES` — это круг. Здесь
 * судья внешний: `kimi doctor config` из образа `--clis` у `tools/core-linux.mjs` (та же
 * схема, что грузит запуск; сам запуск недопустимый ключ молча выбрасывает, поэтому
 * зелёный старт сеанса ничего бы не доказал). Обе стороны:
 *
 *   1. каждый режим из `KIMI_MODES` — серверным писателем `writeKimiPermissions` (с нуля и
 *      поверх файла с [[hooks]] и правилом) → доктор: OK, выход 0;
 *   2. кандидаты вне набора (`default`/`plan` — словарь ACP, `bogus`) → доктор: «Invalid
 *      input», выход 1; а наш `readKimiMode` на том же файле отказывает С ПРИЧИНОЙ
 *      (раздел только для чтения), не подменяя значение молча;
 *   3. итог: множество принятых доктором значений РАВНО `KIMI_MODES` — ни лишнего, ни
 *      недостающего.
 *
 * Только временный каталог и одноразовый контейнер (`--rm`, метка `claude.ephemeral`);
 * настройки человека не читаются и не меняются. Нет docker или образа — провал с
 * названной причиной (молчаливый пропуск выглядел бы зелёным).
 *
 * Запуск: `node tools/qa/check-kimi-permission-modes.mjs` (Node 22.6+; стенд не нужен;
 * образ — `node tools/core-linux.mjs --clis` один раз).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Тот же образ, что строит core-linux.mjs (версии прибиты в имени).
const IMAGE = 'agentdeck-core-linux:22-clis-g0.66.0-k2.4.1';
const ROOT = join(import.meta.dirname, '..', '..');
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? '✓' : '✕'} ${what}`);
  if (!ok) failures.push(what);
};

const { KIMI_MODES, KIMI_ACP_MODES } = await load('packages/contracts/src/vocabulary.ts');
const { writeKimiPermissions, readKimiMode } = await load('apps/server/src/lib/kimi-toml.ts');

const BASE = [
  'model = "m"',
  '',
  '[[hooks]]',
  'event = "PreToolUse"',
  'matcher = ""',
  'command = "h || exit 2"',
  'timeout = 600',
  '',
].join('\n');
const RULES = [{ decision: 'deny', pattern: 'Bash(git push*)' }];
const outside = [...new Set([...KIMI_ACP_MODES, 'bogus'])].filter((m) => !KIMI_MODES.includes(m));

const work = mkdtempSync(join(tmpdir(), 'cc-kimi-modes-'));
try {
  const image = spawnSync('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], {
    encoding: 'utf8',
  });
  if (image.status !== 0) {
    check(false, `образ ${IMAGE} есть (нет — node tools/core-linux.mjs --clis)`);
    throw new Error('stop');
  }

  /** Файлы на суд: имя → { mode, ждём ли принятия }. */
  const cases = new Map();
  for (const mode of KIMI_MODES) {
    writeFileSync(join(work, `fresh-${mode}.toml`), writeKimiPermissions('', mode, []));
    writeFileSync(join(work, `over-${mode}.toml`), writeKimiPermissions(BASE, mode, RULES));
    cases.set(`fresh-${mode}.toml`, { mode, accept: true });
    cases.set(`over-${mode}.toml`, { mode, accept: true });
  }
  for (const mode of outside) {
    // Писатель такой режим не выдаст (проверено ниже) — файл собирается руками, как у человека.
    writeFileSync(join(work, `stale-${mode}.toml`), `default_permission_mode = "${mode}"\n${BASE}`);
    cases.set(`stale-${mode}.toml`, { mode, accept: false });
  }

  // Файлы уходят в контейнер потоком tar через stdin, как в core-linux.mjs, а не монтированием
  // папки: монтирование диска Windows в Docker Desktop ломается само (`mkdir /run/desktop/mnt/host/c:
  // file exists`) до его перезапуска, а поток от этого не зависит.
  const tar = spawnSync(
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar',
    ['-cf', '-', '-C', work, '.'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (tar.status !== 0) {
    check(false, `архив файлов на суд собран (tar вышел с ${tar.status})`);
    throw new Error('stop');
  }
  const script =
    'mkdir -p /tmp/cfg && tar -xf - -C /tmp/cfg && ' +
    'for f in /tmp/cfg/*.toml; do kimi doctor config "$f" >/tmp/o 2>&1; c=$?; ' +
    'printf "@@ %s %s %s\\n" "$(basename "$f")" "$c" "$(grep -c "Invalid input" /tmp/o)"; done';
  const run = spawnSync(
    'docker',
    [
      'run',
      '-i',
      '--rm',
      '--label',
      'claude.ephemeral=1',
      '--entrypoint',
      'sh',
      IMAGE,
      '-c',
      script,
    ],
    {
      input: tar.stdout,
      encoding: 'utf8',
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
      timeout: 300_000,
    },
  );
  const verdicts = new Map(
    [...run.stdout.matchAll(/^@@ (\S+) (\d+) (\d+)$/gm)].map((m) => [
      m[1],
      { code: Number(m[2]), invalid: Number(m[3]) > 0 },
    ]),
  );
  // Контейнер не стартовал (сломанное монтирование Docker Desktop и т. п.) — причина названа словами
  // docker, а не голым «0 вердиктов», иначе провал стенда не отличить от провала продукта.
  const dockerSaid =
    run.status === 0
      ? ''
      : ` — docker вышел с ${run.status}: ${(run.stderr ?? '').trim().split('\n')[0]}`;
  check(
    verdicts.size === cases.size,
    `доктор вынес вердикт по всем ${cases.size} файлам (${verdicts.size})${verdicts.size ? '' : dockerSaid}`,
  );

  const accepted = new Set();
  for (const [file, { mode, accept }] of cases) {
    const v = verdicts.get(file);
    if (!v) continue;
    if (accept) {
      check(v.code === 0 && !v.invalid, `${file}: писатель панели → kimi doctor OK`);
      check(
        readKimiMode(readFileSync(join(work, file), 'utf8')) === mode,
        `${file}: читается обратно как ${mode}`,
      );
    } else {
      check(v.code === 1 && v.invalid, `${file}: kimi doctor — Invalid input`);
      let reason = '';
      try {
        readKimiMode(readFileSync(join(work, file), 'utf8'));
      } catch (caught) {
        reason = caught instanceof Error ? caught.message : '';
      }
      check(
        reason.includes(`"${mode}"`),
        `${file}: панель отказывает с причиной, а не показывает manual`,
      );
      let written = true;
      try {
        writeKimiPermissions('', mode, []);
      } catch {
        written = false;
      }
      check(!written, `${file}: писатель панели режим ${mode} не выдаёт`);
    }
    if (v.code === 0) accepted.add(mode);
  }
  const same =
    accepted.size === KIMI_MODES.length && KIMI_MODES.every((mode) => accepted.has(mode));
  check(same, `принятое доктором = KIMI_MODES (${[...accepted].join(', ')})`);
} catch (caught) {
  if (!(caught instanceof Error && caught.message === 'stop')) throw caught;
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log(`\n✕ провалов: ${failures.length}`);
  process.exit(1);
}
console.log('\n✓ режимы прав Kimi: панель пишет только то, что принимает kimi 2.4.1');
