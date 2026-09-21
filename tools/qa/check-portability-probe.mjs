/**
 * ПРИЁМОЧНАЯ ПРОБА целиком (П2.4): дорога от пробной записи до наблюдения.
 *
 * Юниты рядом (`probe.test.ts`) держат таблицу приговоров: по готовому разговору
 * с заглушкой они решают, что считать совпадением. Здесь проверяется то, чего
 * таблица не может, — ВСЯ дорога: временный дом, настоящие эмиттеры, настоящий
 * процесс цели, настоящая заглушка вместо модели и разбор того, что до неё
 * доехало.
 *
 * Цель играет ПОДДЕЛЬНЫЙ CLI (`probe-fake-cli.mjs`): девяти настоящих на машине
 * нет (§9 плана), а проба обязана уметь краснеть уже сегодня. Подделка не
 * изображает поведение Claude Code — она добросовестно исполняет ровно те
 * механизмы, о которых спрашивает проба.
 *
 * ДВА УТВЕРЖДЕНИЯ:
 *
 *  1. **Целый перенос даёт шесть совпадений.** Ни одной строки «не проверено»:
 *     подделка установлена, рецепт есть, заглушка ответила.
 *  2. **Испорченный перенос даёт красный ИМЕННО на своём слое.** Шесть порч,
 *     по одной на слой; каждая удаляет свой файл (или свой ключ в
 *     `settings.json`) с диска УЖЕ ПОСЛЕ эмиссии, и красной обязана стать ровно
 *     одна строка. Проба, которая не может покраснеть, — украшение.
 *
 * Запуск: `node tools/qa/check-portability-probe.mjs`
 * Самопроверка: `node tools/qa/check-portability-probe.mjs --selftest` — она же
 * второе утверждение: без неё первое доказывает лишь, что что-то зелёное.
 */
import { fileURLToPath } from 'node:url';

const selftest = process.argv.includes('--selftest');
const fakeCli = fileURLToPath(new URL('./probe-fake-cli.mjs', import.meta.url));

const failures = [];

function check(name, ok, detail) {
  if (!ok) failures.push(detail ? `${name} — ${detail}` : name);
}

/** Строка отчёта по слою — по имени, а не по месту. */
function row(report, layer) {
  return report.rows.find((candidate) => candidate.layer === layer);
}

/** Одна строка о слое для отчёта проверки. */
function describe(candidate) {
  return candidate
    ? `${candidate.layer}: обещано ${candidate.promised}, ждали ${candidate.expected}, видели ${candidate.observed}${candidate.skip ? ` (${candidate.skip})` : ''}`
    : 'строки нет';
}

async function main() {
  const { runProbe } = await import(
    new URL('../../apps/server/src/domains/portability/probe.ts', import.meta.url).href
  );
  const { claudeProvider } = await import(
    new URL('../../apps/server/src/providers/claude.ts', import.meta.url).href
  );

  const run = (poison) =>
    runProbe({
      target: claudeProvider,
      scope: 'global',
      cliOverride: poison
        ? [process.execPath, fakeCli, '--poison', poison]
        : [process.execPath, fakeCli],
      timeoutMs: 60_000,
    });

  if (!selftest) {
    const report = await run(null);
    check('цель считается установленной', report.cliInstalled, `команда: ${report.cliCommand}`);
    check(
      'ни одной строки «не проверено»',
      report.summary.notChecked === 0,
      report.rows
        .filter((candidate) => candidate.skip)
        .map(describe)
        .join('; '),
    );
    check(
      'шесть совпадений',
      report.summary.match === 6 && report.summary.mismatch === 0,
      report.rows
        .filter((candidate) => candidate.verdict !== 'match')
        .map(describe)
        .join('; '),
    );
    report.rows.forEach((candidate) => {
      process.stdout.write(`  ${describe(candidate)} → ${candidate.verdict}\n`);
    });
  } else {
    for (const layer of ['hook', 'skill', 'permission', 'mcpServer', 'envVar', 'command']) {
      const report = await run(layer);
      const broken = report.rows.filter((candidate) => candidate.verdict === 'mismatch');
      check(
        `порча слоя «${layer}» красит его строку`,
        row(report, layer)?.verdict === 'mismatch',
        describe(row(report, layer)),
      );
      check(
        `порча слоя «${layer}» не красит чужие`,
        broken.length === 1,
        broken.map(describe).join('; '),
      );
      process.stdout.write(
        `  порча ${layer}: красных ${broken.length} — ${broken.map((candidate) => candidate.layer).join(',')}\n`,
      );
    }
  }

  if (failures.length > 0) {
    process.stdout.write(`\nПРОБА: ${failures.length} расхождений\n`);
    for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(
    selftest ? '\nПРОБА: самопроверка прошла — проба умеет краснеть\n' : '\nПРОБА: дорога цела\n',
  );
}

await main();
