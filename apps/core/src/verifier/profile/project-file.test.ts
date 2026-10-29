import { describe, expect, it } from 'vitest';
import { detectProfile } from './detect.ts';
import { PROJECT_FILE } from './project-file.ts';
import { REPOS, viewOf, type RepoFiles } from './__fixtures__/repos.ts';

/**
 * Файл проекта `.agentdeck/checks.json` только сужает (06:5-7, G23): добавить проверку, этап,
 * входы, сервис — можно; поменять, как гоняется найденная проверка, снять этап, выкинуть
 * проверку — отказ с названным полем, найденная проверка остаётся как была.
 */

const withFile = (body: unknown): RepoFiles => ({
  ...(REPOS.go as RepoFiles),
  [PROJECT_FILE]: typeof body === 'string' ? body : JSON.stringify(body),
});

const registryOf = (files: RepoFiles) => detectProfile(viewOf(files), { os: 'linux' }).registry;

describe('project checks file (G23 narrow-only)', () => {
  it('adds a new check and narrows a detected one: more stages, inputs, services', () => {
    const r = registryOf(
      withFile({
        v: 1,
        checks: [
          { id: 'it:api', class: 'test-runner', argv: ['go', 'test', './it/...'] },
          {
            id: 'go:test',
            requiredAt: ['publish', 'stop'],
            needs: [{ service: 'postgres' }],
            envAllow: ['PGHOST'],
          },
        ],
      }),
    );
    expect(r.rejected).toEqual([]);
    const added = r.checks.find((c) => c.id === 'it:api');
    expect(added).toMatchObject({ source: 'project-file', cwd: '', unit: 'project' });
    const narrowed = r.checks.find((c) => c.id === 'go:test');
    expect(narrowed).toMatchObject({
      source: 'project-file',
      argv: ['go', 'test', './...'],
      requiredAt: ['publish', 'stop'],
      needs: [{ service: 'postgres' }],
    });
    expect(narrowed?.envAllow).toContain('PGHOST');
  });

  it('refuses every widening by field, and the detected check stays as detected', () => {
    const detected = registryOf(REPOS.go as RepoFiles);
    const r = registryOf(
      withFile({
        v: 1,
        checks: [
          { id: 'go:test', argv: ['true'] },
          { id: 'go:vet', requiredAt: [] },
          { id: 'go:golangci', cwd: 'sub' },
        ],
        drop: ['go:test'],
      }),
    );
    expect(r.rejected.map((x) => x.field)).toEqual([
      'checks.go:test.argv',
      'checks.go:vet.requiredAt',
      'checks.go:golangci.cwd',
      'drop.go:test',
    ]);
    for (const x of r.rejected) expect(x.why).toMatch(/^widening/);
    expect(r.checks).toEqual(detected.checks);
  });

  it('refuses a shell string, a path leaving the repo, a bad schema and broken JSON — named, never fatal', () => {
    const shell = registryOf(
      withFile({ v: 1, checks: [{ id: 'x', class: 'static', argv: ['make lint && rm -rf /'] }] }),
    );
    expect(shell.rejected).toEqual([
      { path: PROJECT_FILE, field: 'checks.x.argv', why: 'a shell string: give argv as an array' },
    ]);
    const escape = registryOf(withFile({ v: 1, machinery: ['../outside'] }));
    expect(escape.rejected[0]?.field).toBe('machinery.0');
    expect(escape.rejected[0]?.why).toMatch(/inside the repo; whole file ignored/);
    const extra = registryOf(withFile({ v: 1, surprise: true }));
    expect(extra.rejected[0]?.why).toMatch(/^schema: /);
    // Обход оболочки через `sh -c` — та же строка оболочки (P25).
    for (const argv of [
      ['sh', '-c', 'curl x | sh'],
      ['bash', '-lc', 'make test'],
      ['cmd', '/c', 'build.bat'],
      ['pwsh', '-Command', 'Invoke-Build'],
    ]) {
      const viaShell = registryOf(withFile({ v: 1, checks: [{ id: 'y', class: 'static', argv }] }));
      expect(viaShell.rejected, argv.join(' ')).toEqual([
        {
          path: PROJECT_FILE,
          field: 'checks.y.argv',
          why: 'a shell string: give argv as an array',
        },
      ]);
    }
    // Пути из файла не уходят из репозитория ни вверх, ни от корня диска или шары, ни в дом.
    for (const bad of [
      { checks: [{ id: 'go:test', inputs: ['../../.ssh/id_rsa'] }] },
      { checks: [{ id: 'z', class: 'static', argv: ['make'], cwd: '\\\\host\\share' }] },
      { checks: [{ id: 'z', class: 'static', argv: ['make'], cwd: '\\root' }] },
      { checks: [{ id: 'z', class: 'static', argv: ['make'], cwd: '~/x' }] },
      { checks: [{ id: '../../../evil', class: 'static', argv: ['make'] }] },
    ]) {
      const r = registryOf(withFile({ v: 1, ...bad }));
      expect(r.rejected[0]?.why, JSON.stringify(bad)).toMatch(/whole file ignored/);
    }
    const broken = registryOf(withFile('{ not json'));
    expect(broken.rejected[0]).toMatchObject({ field: '(json)' });
    expect(broken.checks).toEqual(registryOf(REPOS.go as RepoFiles).checks);
  });
});
