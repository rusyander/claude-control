// Where the AgentDeck panel is on THIS machine: its URL, its credential file and its data dir. Flags always win;
// then what the panel itself says; then the stock layout. A machine with another port, an overridden config dir or
// no Claude config at all (data under ~/.agentdeck) used to get the stock paths and read nothing.
//   URL         --base > AGENTDECK_URL > http://127.0.0.1:${PORT || 5178}   (the server listens on PORT)
//   credential  --token-file > ~/.agentdeck/api-token > the pre-rename home's api-token (the panel's own fallback)
//   data dir    --app-data > --config-root <dir>/agentdeck > GET /api/location paths.appData > <config root>/agentdeck
// The credential is read here and never printed; a missing file is fine (no remote gate on loopback).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configRoot, nativePath } from '../../../watchdog/scripts/lib/core.mjs';

/** The panel's home before the rename, built from parts like the panel's brand module (never a literal). */
const LEGACY_HOME = `.${['claude', 'control'].join('-')}`;

export const panelBase = (o = {}, env = process.env) => String(o.base || env.AGENTDECK_URL || `http://127.0.0.1:${env.PORT || 5178}`).replace(/\/+$/, '');

export function panelTokenFile(o = {}, home = os.homedir()) {
  if (o['token-file']) return nativePath(o['token-file']);
  const fresh = path.join(home, '.agentdeck', 'api-token');
  if (fs.existsSync(fresh)) return fresh;
  const legacy = path.join(home, LEGACY_HOME, 'api-token');
  return fs.existsSync(legacy) ? legacy : fresh;
}

export function readToken(file) {
  try {
    return fs.readFileSync(nativePath(file), 'utf8').trim();
  } catch {
    return '';
  }
}

/** The panel's data dir and where it came from (`flag` · `config-root` · `panel` · `default`). One read-only GET. */
export async function discoverAppData(o = {}, { fetchImpl = globalThis.fetch, timeoutMs = 1500, home } = {}) {
  if (o['app-data']) return { dir: path.resolve(nativePath(o['app-data'])), from: 'flag' };
  if (o['config-root']) return { dir: path.resolve(configRoot(o), 'agentdeck'), from: 'config-root' };
  try {
    const token = readToken(panelTokenFile(o, home));
    const res = await fetchImpl(`${panelBase(o)}/api/location`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const dir = (await res.json())?.paths?.appData;
      if (typeof dir === 'string' && dir) return { dir: path.resolve(dir), from: 'panel' };
    }
  } catch {
    /* panel down or another service on the port: the stock layout */
  }
  return { dir: path.resolve(configRoot(o), 'agentdeck'), from: 'default' };
}
