/**
 * Сверка пары из командной строки — приёмка в чате переноса и проверка руками:
 *
 *   node --experimental-strip-types apps/server/src/domains/global-layer/cli.ts <pair>
 *     [--config-dir <dir>] [--proposal <dir>] [--json]
 *
 * Печатает таблицу по ситам и ошибки каждой стороны. Код выхода 0 — корпус
 * зелёный на ОБЕИХ сторонах, 1 — хоть одна сторона ошиблась, 2 — пары нет.
 * Ничего не пишет: предложение меряется копией слоя (`--proposal`).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runComparison } from './compare.ts';
import { loadRegistry } from './registry.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const pairId = args.find(
  (arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'),
);
const pair = loadRegistry().find((entry) => entry.id === pairId);
if (!pair) {
  console.error(
    `unknown pair ${pairId ?? '(none)'}; known: ${loadRegistry()
      .map((entry) => entry.id)
      .join(', ')}`,
  );
  process.exit(2);
}

const configRoot =
  option('--config-dir') ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const proposalDir = option('--proposal');
const result = await runComparison({ pair, configRoot, ...(proposalDir ? { proposalDir } : {}) });

if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(
    `pair ${pair.id}: ${result.cases} cases, config ${configRoot}${proposalDir ? ` + proposal ${proposalDir}` : ''}`,
  );
  for (const row of result.rows) {
    console.log(
      `${row.sieve.padEnd(22)} both ${row.both}  panel-only ${row.panelOnly}  global-only ${row.globalOnly}  neither ${row.neither}  → ${row.verdict}`,
    );
    for (const item of row.cases.filter((entry) => entry.outcome !== 'both')) {
      const side = (name: string, miss?: { missed: string[]; extra: string[] }) =>
        miss ? ` ${name}: missed [${miss.missed.join(', ')}] extra [${miss.extra.join(', ')}]` : '';
      console.log(`    ${item.caseId}:${side('panel', item.panel)}${side('global', item.global)}`);
    }
  }
  for (const [name, state] of [
    ['panel', result.panel],
    ['global', result.global],
  ] as const) {
    console.log(
      `${name}: ${state.failing} failing case(s)${state.error ? `, error: ${state.error}` : ''}`,
    );
  }
}
process.exit(
  result.panel.failing === 0 && result.global.failing === 0 && result.panel.ok && result.global.ok
    ? 0
    : 1,
);
