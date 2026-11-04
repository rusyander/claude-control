import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateFieldsSchema } from '@agentdeck/contracts/core/estimate';
import type { ChatEvent } from '../chat/chat-events.ts';
import { ChatRunRegistry, type RunLike } from '../chat/ChatRunRegistry/ChatRunRegistry.ts';
import { carryOfRunOptions } from '../chat/core-run/session-carry.ts';
import type { RunOptions } from '../chat/run-options/run-options.ts';
import { localLayerRun, writeLayerMode } from './local-layer.ts';
import { sectionSha, splitSections } from './sections.ts';
import type { TeamPlace } from './team-layer.ts';

/**
 * Путь локального слоя до поля сеанса ядра (s10 G14 p6), без подмен внутри: настоящий проект в
 * git, настоящая сборка слоя (`localLayerRun`), настоящий реестр прогонов с резолвером, как его
 * ставит runtime, и настоящий перенос `carryOfRunOptions`, проверенный схемой полей задачи ядра.
 * Режим карточки решает, едет ли слой: «Вкл.» — да, «Выкл.» — нет, «Авто» — только с выгодой.
 * Как поле раскладывается в команду claude и что видит модель — живая проба ядра
 * apps/core/src/adapters/claude/claude.local-layer.live.integration.test.ts.
 */

let base: string;
let root: string;
let place: TeamPlace;

const write = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Прогон, который только запоминает параметры старта — сам CLI здесь не нужен. */
class CapturingRun implements RunLike {
  started?: RunOptions;
  start(options: RunOptions, _onEvent: (event: ChatEvent) => void): Promise<void> {
    this.started = options;
    return new Promise<void>(() => undefined);
  }
  stop(): void {}
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-local-layer-carry-')));
  root = join(base, 'proj');
  mkdirSync(root, { recursive: true });
  place = {
    home: homedir(),
    configDir: join(base, 'config'),
    caseless: process.platform === 'win32',
  };
  write(join(place.configDir, 'settings.json'), '{}');
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  write(join(root, '.gitignore'), '.agent/\n');
  write(
    join(root, 'CLAUDE.md'),
    `# Team\n\nTEAM_MD\n\n## Build\n\nBUILD_LONG\n${'x'.repeat(600)}\n`,
  );
  write(
    join(root, '.claude', 'skills', 'team-skill', 'SKILL.md'),
    '---\nname: team-skill\ndescription: x\n---\nbody\n',
  );
  write(
    join(root, '.claude', 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(npm test:*)'], deny: ['Bash(rm -rf:*)'] },
      env: { TEAM_ENV: 'team' },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo TEAM_HOOK' }] }],
      },
    }),
  );
  git('add', '-A');
  git('commit', '-qm', 'team');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Старт хода через реестр с резолвером слоя, как в runtime, → перенос в ядро. */
function carryOfStart(extra: Partial<RunOptions> = {}) {
  const run = new CapturingRun();
  const registry = new ChatRunRegistry(() => run);
  registry.setLocalLayerResolver((cwd) => localLayerRun(cwd, place));
  registry.start('c1', { prompt: 'hi', cwd: root, ...extra }, {});
  expect(run.started).toBeDefined();
  const carried = carryOfRunOptions(run.started as RunOptions);
  if (!carried.ok) throw new Error(carried.reason);
  // Ядро примет ровно то, что пройдёт его схему полей задачи (сеанс — её часть).
  const parsed = estimateFieldsSchema.safeParse({
    title: 't',
    request: 'r',
    repos: [{ path: root, baseRef: null }],
    scenario: { preset: 'chat' },
    launchPolicy: 'confirm',
    ciWait: false,
    session: carried.carry.session,
  });
  expect(parsed.error?.issues ?? []).toEqual([]);
  return carried.carry;
}

describe('локальный слой → поле сеанса ядра', () => {
  it('«Вкл.»: источники без project, слой целиком в session.localLayer', () => {
    writeLayerMode(root, 'on');
    const { session } = carryOfStart();
    expect(session.settingSources).toEqual(['user', 'local']);
    const layer = session.localLayer;
    expect(layer?.instructions).toContain('TEAM_MD');
    expect(layer?.instructions).toContain('BUILD_LONG');
    expect(
      layer?.plugin && existsSync(join(layer.plugin, 'skills', 'team-skill', 'SKILL.md')),
    ).toBe(true);
    expect(JSON.stringify(layer?.hooks)).toContain('TEAM_HOOK');
    expect(layer?.permissions).toEqual({ allow: ['Bash(npm test:*)'], deny: ['Bash(rm -rf:*)'] });
    expect(layer?.env).toEqual({ TEAM_ENV: 'team' });
    // Слой не уходит флагами панели мимо поля: ни плагина слоя, ни дописки с его текстом.
    expect(session.plugins ?? []).not.toContain(layer?.plugin);
    expect(session.append ?? '').not.toContain('TEAM_MD');
  });

  it('«Выкл.»: ни поля, ни снятия источников — командный слой как есть', () => {
    writeLayerMode(root, 'off');
    const { session } = carryOfStart();
    expect(session.localLayer).toBeUndefined();
    expect(session.settingSources).toBeUndefined();
  });

  it('«Авто»: без выгоды слоя нет, со свежим сжатием — едет сжатым', () => {
    writeLayerMode(root, 'auto');
    expect(carryOfStart().session.localLayer).toBeUndefined();
    const section = splitSections(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).find(
      (item) => item.heading === '## Build',
    );
    write(
      join(root, '.agent', 'local-layer', 'compressed', 'build.md'),
      `---\nsource: CLAUDE.md\nsection: "## Build"\nsha: ${sectionSha(section?.text ?? '')}\n---\n## Build\nSHORT_MARK\n`,
    );
    const { session } = carryOfStart();
    expect(session.settingSources).toEqual(['user', 'local']);
    expect(session.localLayer?.instructions).toContain('SHORT_MARK');
    expect(session.localLayer?.instructions).not.toContain('BUILD_LONG');
  });

  it('песочница со своим каталогом слоя не получает даже при «Вкл.»', () => {
    writeLayerMode(root, 'on');
    const { session } = carryOfStart({ configDir: join(base, 'sandbox') });
    expect(session.localLayer).toBeUndefined();
  });
});
