import type { Profile } from '@agentdeck/contracts/core/records';
import type { StackRow } from './profile.types.ts';
import { joinRel, type ViewIndex } from './view.ts';

/**
 * Версии рантаймов, которые просит проект (04:89-90): `.nvmrc` / `.node-version` / engines /
 * volta, `go.mod` go + toolchain, `.python-version` / runtime.txt / requires-python / poetry /
 * Pipfile, Gradle toolchain и Maven release, `global.json`, `rust-toolchain`. Порт чтения
 * панельного `runtimes.ts` (первая значащая строка, `.tool-versions` asdf/mise) — только
 * файлы проекта; где эта версия стоит на машине, решает подготовка копии (G7), не профиль.
 * Ключ — инструмент; для корня стека не в корне репозитория — `инструмент@корень`.
 */

type Runtimes = Profile['runtimes'];

function firstLine(text: string | undefined): string | undefined {
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (line) return line;
  }
  return undefined;
}

function toolVersions(text: string | undefined, names: readonly string[]): string | undefined {
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const [name, version] = raw.replace(/#.*/, '').trim().split(/\s+/);
    if (name && version && names.includes(name)) return version;
  }
  return undefined;
}

function nodeNeed(view: ViewIndex, root: string): { version: string; from: string } | undefined {
  for (const name of ['.nvmrc', '.node-version']) {
    const v = firstLine(view.text(joinRel(root, name)));
    if (v) return { version: v.replace(/^v/, ''), from: joinRel(root, name) };
  }
  const tv = toolVersions(view.text(joinRel(root, '.tool-versions')), ['nodejs', 'node']);
  if (tv) return { version: tv, from: joinRel(root, '.tool-versions') };
  const pkg = view.json(joinRel(root, 'package.json'));
  const volta = (pkg?.volta as { node?: unknown } | undefined)?.node;
  if (typeof volta === 'string') return { version: volta, from: joinRel(root, 'package.json') };
  const engines = (pkg?.engines as { node?: unknown } | undefined)?.node;
  if (typeof engines === 'string') return { version: engines, from: joinRel(root, 'package.json') };
  return undefined;
}

function pythonNeed(view: ViewIndex, root: string): { version: string; from: string } | undefined {
  const pinned = firstLine(view.text(joinRel(root, '.python-version')));
  if (pinned) return { version: pinned, from: joinRel(root, '.python-version') };
  const tv = toolVersions(view.text(joinRel(root, '.tool-versions')), ['python']);
  if (tv) return { version: tv, from: joinRel(root, '.tool-versions') };
  const rt = /^python-(\d[\w.]*)/m.exec(view.text(joinRel(root, 'runtime.txt')) ?? '')?.[1];
  if (rt) return { version: rt, from: joinRel(root, 'runtime.txt') };
  const pyproject = view.text(joinRel(root, 'pyproject.toml')) ?? '';
  const req = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1];
  if (req) return { version: req, from: joinRel(root, 'pyproject.toml') };
  const poetry = /\[tool\.poetry\.dependencies\][^[]*?^\s*python\s*=\s*["']([^"']+)["']/ms.exec(
    pyproject,
  )?.[1];
  if (poetry) return { version: poetry, from: joinRel(root, 'pyproject.toml') };
  const pip = /^\s*python_version\s*=\s*["']([^"']+)["']/m.exec(
    view.text(joinRel(root, 'Pipfile')) ?? '',
  )?.[1];
  if (pip) return { version: pip, from: joinRel(root, 'Pipfile') };
  return undefined;
}

function goNeed(view: ViewIndex, root: string): { version: string; from: string } | undefined {
  const text = view.text(joinRel(root, 'go.mod'));
  if (!text) return undefined;
  // `toolchain` точнее `go`: директива go — нижняя граница языка, toolchain — чем собирать.
  const tc = /^\s*toolchain\s+go(\d[\w.]*)/m.exec(text)?.[1];
  const go = /^\s*go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(text)?.[1];
  const v = tc ?? (go ? `>=${go}` : undefined);
  return v ? { version: v, from: joinRel(root, 'go.mod') } : undefined;
}

function javaNeed(view: ViewIndex, root: string): { version: string; from: string } | undefined {
  for (const name of ['build.gradle.kts', 'build.gradle']) {
    const v = /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(
      view.text(joinRel(root, name)) ?? '',
    )?.[1];
    if (v) return { version: v, from: joinRel(root, name) };
  }
  const pom = view.text(joinRel(root, 'pom.xml')) ?? '';
  const v =
    /<maven\.compiler\.release>\s*([\d.]+)\s*</.exec(pom)?.[1] ??
    /<java\.version>\s*([\d.]+)\s*</.exec(pom)?.[1] ??
    /<maven\.compiler\.source>\s*([\d.]+)\s*</.exec(pom)?.[1];
  return v ? { version: v, from: joinRel(root, 'pom.xml') } : undefined;
}

function dotnetNeed(view: ViewIndex, root: string): { version: string; from: string } | undefined {
  for (const dir of [root, '']) {
    const sdk = (view.json(joinRel(dir, 'global.json'))?.sdk as { version?: unknown } | undefined)
      ?.version;
    if (typeof sdk === 'string') return { version: sdk, from: joinRel(dir, 'global.json') };
  }
  return undefined;
}

function rustNeed(view: ViewIndex, root: string): { version: string; from: string } | undefined {
  const toml = view.text(joinRel(root, 'rust-toolchain.toml'));
  const ch = toml ? /^\s*channel\s*=\s*["']([^"']+)["']/m.exec(toml)?.[1] : undefined;
  if (ch) return { version: ch, from: joinRel(root, 'rust-toolchain.toml') };
  const plain = firstLine(view.text(joinRel(root, 'rust-toolchain')));
  return plain ? { version: plain, from: joinRel(root, 'rust-toolchain') } : undefined;
}

/**
 * Ключ — имя инструмента, которое несут проверки в `tools` (ключ проверки ищет версию по нему):
 * у Rust это `cargo` — им гоняются все его проверки, версию задаёт тулчейн.
 */
const READERS: Partial<Record<StackRow['stack'], [string, typeof nodeNeed]>> = {
  'js-ts': ['node', nodeNeed],
  python: ['python', pythonNeed],
  go: ['go', goNeed],
  jvm: ['java', javaNeed],
  dotnet: ['dotnet', dotnetNeed],
  rust: ['cargo', rustNeed],
};

export function detectRuntimes(
  view: ViewIndex,
  stacks: readonly StackRow[],
  packageManager: Profile['packageManager'] = null,
): Runtimes {
  const out: Runtimes = {};
  for (const s of stacks) {
    const reader = READERS[s.stack];
    if (!reader) continue;
    const [tool, read] = reader;
    const got = read(view, s.root);
    if (got) out[s.root === '' ? tool : `${tool}@${s.root}`] = got;
  }
  // Менеджер пакетов — тоже инструмент проверок JS; версия — из `packageManager`, если объявлена.
  if (packageManager && packageManager.version !== '')
    out[packageManager.name] = { version: packageManager.version, from: 'package.json' };
  return out;
}
