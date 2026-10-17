import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shotCommandOf } from './shot-command.ts';

/**
 * Готовая команда снимков проекта (3.5 плана экономии). В одном чате группы
 * снимки съели 174 вызова: скрипт «до» перезапускался шесть раз, пока
 * подбирались вход и селекторы, — а у проекта уже была `npm run qa:shot` с
 * сохранённой сессией (e2e-кит, 300 разовых `ba-*.mjs` рядом).
 */
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-shotcmd-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const pkg = (dir: string, scripts: Record<string, string>) => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name: 'x', scripts }));
};

describe('shotCommandOf', () => {
  /** Путь основного checkout прямыми косыми: строку запускает Bash группы. */
  const home = () => root.replace(/\\/g, '/');

  it('кит во вложенной папке: cd в основной checkout (кит и сессия вне git), описание — сам скрипт', () => {
    pkg('', { test: 'vitest' });
    pkg('e2e', { 'qa:login': 'node ai-scripts/login.mjs', 'qa:shot': 'node ai-scripts/shot.mjs' });
    expect(shotCommandOf(root)).toEqual({
      run: `cd "${home()}/e2e" && npm run qa:shot --`,
      usage: `${home()}/e2e/ai-scripts/shot.mjs`,
    });
  });

  /** Ревью B1-F17: `$` и обратная кавычка в имени папки раскрывались Bash внутри `cd "…"`. */
  it('папка с `$` и обратной кавычкой: Bash переходит именно в неё, ничего не выполняя', () => {
    const odd = 'kit$HOME`echo x`';
    pkg(odd, { 'qa:shot': 'node shot.mjs' });
    const run = shotCommandOf(root)!.run;
    const cd = run.slice(0, run.indexOf(' && '));
    const shell = spawnSync('bash', ['-c', `${cd} && basename "$PWD"`], { encoding: 'utf8' });
    expect(shell.stderr).toBe('');
    expect(shell.stdout.trim()).toBe(odd);
  });

  it('в корне с pnpm — pnpm; не node-скрипт — описание в package.json', () => {
    pkg('', { shot: 'playwright test shots' });
    writeFileSync(join(root, 'pnpm-lock.yaml'), '');
    expect(shotCommandOf(root)).toEqual({
      run: `cd "${home()}" && pnpm run shot --`,
      usage: `${home()}/package.json`,
    });
  });

  it('qa:shot главнее shot; корень главнее вложенной папки', () => {
    pkg('', { shot: 'node a.mjs', 'qa:shot': 'node b.mjs' });
    pkg('e2e', { 'qa:shot': 'node c.mjs' });
    expect(shotCommandOf(root)?.usage).toBe(`${home()}/b.mjs`);
  });

  it('гейт снимков справки (`shots`), скрытые и вложенные глубже папки — не команда снимков', () => {
    pkg('', { shots: 'node tools/help-shots/check.mjs' });
    pkg('node_modules/kit', { 'qa:shot': 'node x.mjs' });
    pkg('.cache', { 'qa:shot': 'node x.mjs' });
    expect(shotCommandOf(root)).toBeUndefined();
  });

  it('нет package.json, битый JSON, нет каталога — нет команды', () => {
    expect(shotCommandOf(root)).toBeUndefined();
    writeFileSync(join(root, 'package.json'), '{oops');
    expect(shotCommandOf(root)).toBeUndefined();
    expect(shotCommandOf(join(root, 'missing'))).toBeUndefined();
  });
});
