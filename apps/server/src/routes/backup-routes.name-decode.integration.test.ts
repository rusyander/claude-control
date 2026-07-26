import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerBackupRoutes } from './backup-routes.ts';

/**
 * Имя копии в адресе кодируется РОВНО один раз.
 *
 * Клиент шлёт `encodeURIComponent(name)`, Fastify раскодирует параметр пути сам,
 * а маршрут делал это ещё раз. Скилл с процентом в имени (`50%off` — id такое
 * разрешает) давал копию `skills-50%off.<метка>.bak`: повторный разбор спотыкался
 * о «%of» и отвечал 500 вместо отката, а `%2520` схлопывался в пробел и уводил
 * к «Копия не найдена».
 */
describe('backup-routes: имя копии с процентом', () => {
  let root: string;
  let app: FastifyInstance;
  let backupDir: string;
  let skillsDir: string;

  const SKILL = '50%off';
  const NAME = `skills-${SKILL}.2026-01-01T00-00-00-000Z.bak`;
  /** Так адрес собирает клиент (BackupsCard). */
  const url = (suffix = ''): string => `/api/backups/${encodeURIComponent(NAME)}${suffix}`;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-backup-name-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });
    skillsDir = join(root, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    const store = new AppStore(join(root, 'claude-control'));
    backupDir = store.backupDir;
    mkdirSync(backupDir, { recursive: true });

    // Копия папки скилла: внутри старое содержимое, на диске — новое.
    mkdirSync(join(backupDir, NAME), { recursive: true });
    writeFileSync(
      join(backupDir, NAME, 'SKILL.md'),
      `---\nname: ${SKILL}\ndescription: x\n---\n\nстарое\n`,
    );
    mkdirSync(join(skillsDir, SKILL), { recursive: true });
    writeFileSync(
      join(skillsDir, SKILL, 'SKILL.md'),
      `---\nname: ${SKILL}\ndescription: x\n---\n\nновое\n`,
    );

    const ctx = {
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: skillsDir,
          mcpConfig: join(root, '.claude.json'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          appData: join(root, 'claude-control'),
        },
      },
      store,
      applyIoSettings: () => {},
    } as unknown as ServerContext;

    app = Fastify();
    registerBackupRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('откат находит копию и возвращает содержимое, а не падает с 500', async () => {
    const response = await app.inject({ method: 'POST', url: url('/restore'), payload: {} });

    expect(response.statusCode).toBe(200);
    expect(readFileSync(join(skillsDir, SKILL, 'SKILL.md'), 'utf8')).toContain('старое');
  });

  it('удаление копии с процентом отвечает 200 и убирает её с диска', async () => {
    const response = await app.inject({ method: 'DELETE', url: url() });

    expect(response.statusCode).toBe(200);
    expect(existsSync(join(backupDir, NAME))).toBe(false);
  });
});
