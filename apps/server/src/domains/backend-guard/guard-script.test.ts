import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, classifyCall, reasonText } from './guard-script.mjs';

/**
 * Правила защиты бэкенда. Таблица — обе стороны: что обязано спросить и что
 * обязано пройти (обычная работа бэкендера), иначе защиту выключат через день.
 */

const ASKS: ReadonlyArray<[string, string]> = [
  ['psql -c "DROP TABLE orders"', 'sql-drop'],
  ['psql -c "drop schema public cascade"', 'sql-drop'],
  ["mysql -e 'DROP DATABASE shop'", 'sql-drop'],
  ['psql -c "alter table users drop column email"', 'sql-drop'],
  ['dropdb shop', 'sql-drop'],
  ['redis-cli FLUSHALL', 'sql-drop'],
  ['mongosh --eval "db.orders.drop()"', 'sql-drop'],
  ['psql -c "TRUNCATE orders"', 'sql-truncate'],
  ['psql -c "truncate table only orders"', 'sql-truncate'],
  ['psql -c "delete from orders"', 'sql-unbounded'],
  ['psql -c "UPDATE users SET admin = true"', 'sql-unbounded'],
  ['psql <<SQL\ndelete from orders;\nSQL', 'sql-unbounded'],
  ['migrate -path db/migrations -database "$DB" down 1', 'migration-down'],
  ['goose -dir migrations postgres "$DB" reset', 'migration-down'],
  ['dbmate rollback', 'migration-down'],
  ['alembic downgrade -1', 'migration-down'],
  ['python manage.py migrate shop zero', 'migration-down'],
  ['python manage.py flush --noinput', 'migration-down'],
  ['bin/rails db:rollback STEP=2', 'migration-down'],
  ['npx prisma migrate reset --force', 'migration-down'],
  ['npx prisma db push --accept-data-loss', 'migration-down'],
  ['flyway clean', 'migration-down'],
  ['npx knex migrate:rollback', 'migration-down'],
  ['npm run migrate:down', 'migration-down'],
  ['sqlx database reset', 'migration-down'],
  ['dotnet ef database drop -f', 'migration-down'],
  ['php artisan migrate:fresh --seed', 'migration-down'],
  ['terraform apply -auto-approve', 'infra-change'],
  ['terraform -chdir=infra destroy', 'infra-change'],
  ['tofu state rm aws_instance.web', 'infra-change'],
  ['pulumi up --yes', 'infra-change'],
  ['kubectl delete ns staging', 'infra-change'],
  ['kubectl -n prod apply -f deploy.yaml', 'infra-change'],
  ['kubectl rollout undo deploy/api', 'infra-change'],
  ['kubectl exec -it api-0 -- sh', 'infra-change'],
  ['helm upgrade api ./chart', 'infra-change'],
  ['helm uninstall api', 'infra-change'],
  [
    'aws s3 rb s3://bucket --force && aws rds delete-db-instance --db-instance-identifier x',
    'infra-change',
  ],
  ['gcloud sql instances delete main', 'infra-change'],
  ['docker volume rm shop_data', 'volume-delete'],
  ['docker volume prune -f', 'volume-delete'],
  ['docker system prune -a --volumes', 'volume-delete'],
  ['docker compose down -v', 'volume-delete'],
  ['docker compose -f docker/compose.yaml down --volumes', 'volume-delete'],
  ['docker-compose down -v', 'volume-delete'],
  ['docker rm -fv db', 'volume-delete'],
];

const PASSES: readonly string[] = [
  'npm test',
  'go test ./...',
  'psql -c "select * from orders where id = 1"',
  'psql -c "delete from orders where id = 1"',
  'psql -c "update users set admin = false where id = 7"',
  'truncate -s 0 app.log',
  'migrate -path db/migrations -database "$DB" up',
  'goose -dir migrations postgres "$DB" status',
  'alembic upgrade head',
  'python manage.py migrate',
  'bin/rails db:migrate',
  'npx prisma migrate dev',
  'terraform plan',
  'terraform init',
  'kubectl get pods -l app=delete-me',
  'kubectl logs deploy/exec-svc',
  'kubectl describe pod api-0',
  'kubectl diff -f deploy.yaml',
  'helm list',
  'helm template api ./chart',
  'docker compose up -d',
  'docker compose down',
  'docker run --rm -v data:/data alpine ls',
  'docker volume ls',
  'aws s3 ls',
  'git commit -m "cleanup"',
];

describe('classify: что спрашивает', () => {
  it.each(ASKS)('%s → %s', (command, rule) => {
    expect(classify(command)?.rule).toBe(rule);
  });
});

describe('classify: что проходит без вопроса', () => {
  it.each(PASSES)('%s', (command) => {
    expect(classify(command)).toBeUndefined();
  });
});

describe('метки прода', () => {
  const config = { prodMarkers: ['db.prod.internal', '10.0.5.12', 'prod-cluster', 'pr'] };

  it('адрес, IP и имя контекста — спрашивает даже на чтении', () => {
    expect(classify('psql -h db.prod.internal -c "select 1"', config)).toEqual({
      rule: 'prod-target',
      match: 'db.prod.internal',
    });
    expect(classify('curl http://10.0.5.12:8080/health', config)?.rule).toBe('prod-target');
    expect(classify('kubectl --context prod-cluster get pods', config)?.rule).toBe('prod-target');
  });

  it('часть другого имени — не метка', () => {
    expect(classify('psql -h db.prod.internal2 -c "select 1"', config)).toBeUndefined();
    expect(classify('ping 10.0.5.123', config)).toBeUndefined();
    expect(classify('kubectl --context prod-cluster-test get pods', config)).toBeUndefined();
  });

  it('метка короче трёх знаков не действует — иначе «pr» ловил бы каждую команду', () => {
    expect(classify('gh pr list', config)).toBeUndefined();
  });

  it('прод — первая причина, раньше снова таблицы', () => {
    expect(classify('psql -h db.prod.internal -c "drop table x"', config)?.rule).toBe(
      'prod-target',
    );
  });
});

describe('выключенные правила и вызовы', () => {
  it('выключенное правило не спрашивает, остальные — да', () => {
    const config = { disabled: ['infra-change'] };
    expect(classify('kubectl delete ns staging', config)).toBeUndefined();
    expect(classify('docker volume rm x', config)?.rule).toBe('volume-delete');
  });

  it('MCP: SQL в любом поле аргументов, но не команды инфраструктуры', () => {
    expect(classifyCall('mcp__postgres__query', { sql: 'DROP TABLE orders' })?.rule).toBe(
      'sql-drop',
    );
    expect(classifyCall('mcp__notes__save', { text: 'kubectl delete ns x' })).toBeUndefined();
    expect(classifyCall('Read', { file_path: 'drop table.sql' })).toBeUndefined();
  });

  it('причина — словами, на языке настроек', () => {
    const hit = { rule: 'sql-drop' as const, match: 'DROP TABLE orders' };
    expect(reasonText(hit, 'ru')).toBe(
      'Защита бэкенда: снос таблицы, базы или схемы — DROP TABLE orders',
    );
    expect(reasonText(hit, 'en')).toContain('Backend guard: dropping a table');
  });
});

/**
 * Настоящий путь: скрипт, скопированный в `.claude/hooks/` проекта, исполнен
 * голым Node с событием в stdin — так его запускает Claude Code.
 */
describe('скрипт как хук', () => {
  const run = (event: unknown, config?: unknown) => {
    const root = mkdtempSync(join(tmpdir(), 'cc-guard-hook-'));
    try {
      mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
      const script = join(root, '.claude', 'hooks', 'backend-guard.mjs');
      copyFileSync(fileURLToPath(new URL('./guard-script.mjs', import.meta.url)), script);
      if (config)
        writeFileSync(join(root, '.claude', 'backend-guard.json'), JSON.stringify(config));
      const result = spawnSync(process.execPath, [script], {
        input: JSON.stringify(event),
        encoding: 'utf8',
        timeout: 15_000,
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('узнанная команда — «ask» с причиной', () => {
    const out = run(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'terraform destroy' },
      },
      { lang: 'en' },
    );
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'Backend guard: changing infrastructure — terraform destroy',
      },
    });
  });

  it('метка прода из файла настроек рядом со скриптом', () => {
    const out = run(
      { tool_name: 'Bash', tool_input: { command: 'psql -h db.prod.internal -c "select 1"' } },
      { prodMarkers: ['db.prod.internal'] },
    );
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecisionReason).toBe(
      'Защита бэкенда: команда обращается к проду — db.prod.internal',
    );
  });

  it('обычная команда и битый вход — молчание и код 0', () => {
    expect(run({ tool_name: 'Bash', tool_input: { command: 'npm test' } })).toMatchObject({
      status: 0,
      stdout: '',
    });
    const broken = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./guard-script.mjs', import.meta.url))],
      { input: 'not json', encoding: 'utf8', timeout: 15_000 },
    );
    expect(broken.status).toBe(0);
    expect(broken.stdout).toBe('');
  });
});
