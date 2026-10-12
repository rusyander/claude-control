import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findComposeFile } from './compose-file.ts';
import { mergeServices, parseConfig, parsePs } from './parse.ts';
import { ComposeBusyError, ComposeRegistry, appendTail, composeArgs } from './registry.ts';
import { ComposeReader } from './compose.ts';
import type { DockerExec, DockerJobProcess, ExecResult } from './docker.ts';

/**
 * Ответы docker сняты с настоящего Docker 29.7 / Compose v5.3 на стеке из двух
 * сервисов (web со здоровьем и портом, job, вышедший с кодом 3) — лишние поля
 * (`Labels`, `Command`…) вырезаны, форма та же.
 */
const CONFIG = JSON.stringify({
  name: 'agentdeck-fx',
  services: {
    job: { command: ['sh', '-c', 'exit 3'], entrypoint: null, image: 'alpine' },
    web: {
      depends_on: { job: { condition: 'service_started', required: true } },
      healthcheck: { test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:3000'] },
      image: 'node:22-alpine',
      ports: [
        {
          mode: 'ingress',
          host_ip: '127.0.0.1',
          target: 3000,
          published: '18431',
          protocol: 'tcp',
        },
      ],
    },
    api: { build: { context: '.' }, depends_on: { web: {} }, ports: [{ target: 8080 }] },
  },
  volumes: { pgdata: { name: 'agentdeck-fx_pgdata' } },
});

const PS = [
  '{"ExitCode":3,"Health":"","Name":"agentdeck-fx-job-1","Project":"agentdeck-fx","Publishers":[],"Service":"job","State":"exited","Status":"Exited (3) 7 seconds ago"}',
  '{"ExitCode":0,"Health":"healthy","Name":"agentdeck-fx-web-1","Project":"agentdeck-fx","Publishers":[{"URL":"127.0.0.1","TargetPort":3000,"PublishedPort":18431,"Protocol":"tcp"}],"Service":"web","State":"running","Status":"Up 7 seconds (healthy)"}',
].join('\n');

describe('compose: разбор ответов docker', () => {
  it('config: образ, сборка, опубликованные порты, зависимости, тома', () => {
    const stack = parseConfig(CONFIG);
    expect(stack.projectName).toBe('agentdeck-fx');
    expect(stack.volumes).toEqual(['pgdata']);
    const web = stack.services.find((service) => service.name === 'web');
    expect(web).toEqual({
      name: 'web',
      image: 'node:22-alpine',
      build: false,
      ports: [{ host: '127.0.0.1', published: 18431, target: 3000, protocol: 'tcp' }],
      dependsOn: ['job'],
      environment: {},
    });
    // Порт без `published` наружу не выходит — ссылки на него не будет.
    expect(stack.services.find((service) => service.name === 'api')).toMatchObject({
      build: true,
      ports: [],
    });
  });

  it('ps: объект на строку, здоровье, код выхода, порт', () => {
    const rows = parsePs(PS);
    expect(rows).toEqual([
      {
        service: 'job',
        state: 'exited',
        status: 'Exited (3) 7 seconds ago',
        exitCode: 3,
        ports: [],
      },
      {
        service: 'web',
        state: 'running',
        health: 'healthy',
        status: 'Up 7 seconds (healthy)',
        exitCode: 0,
        ports: [{ host: '127.0.0.1', published: 18431, target: 3000, protocol: 'tcp' }],
      },
    ]);
  });

  it('ps: старый формат — один массив; порт IPv4+IPv6 — одна строка; неопубликованный — без ссылки', () => {
    const rows = parsePs(
      JSON.stringify([
        {
          Service: 'db',
          State: 'running',
          Publishers: [
            { URL: '0.0.0.0', TargetPort: 5432, PublishedPort: 5433, Protocol: 'tcp' },
            { URL: '::', TargetPort: 5432, PublishedPort: 5433, Protocol: 'tcp' },
            { URL: '', TargetPort: 9000, PublishedPort: 0, Protocol: 'tcp' },
          ],
        },
      ]),
    );
    expect(rows[0]?.ports).toEqual([
      { host: '0.0.0.0', published: 5433, target: 5432, protocol: 'tcp' },
    ]);
  });

  it('ps: пустой ответ — контейнеров нет; неизвестное состояние не ломает разбор', () => {
    expect(parsePs('\n')).toEqual([]);
    expect(parsePs('{"Service":"x","State":"removing"}')[0]?.state).toBe('exited');
  });

  it('слияние: порядок подъёма, «не создан», порты работающего — живые, остальных — из файла', () => {
    const services = mergeServices(parseConfig(CONFIG), parsePs(PS));
    expect(services.map((service) => service.name)).toEqual(['job', 'web', 'api']);
    const [job, web, api] = services;
    expect(job).toMatchObject({ state: 'exited', exitCode: 3 });
    expect(web).toMatchObject({ state: 'running', health: 'healthy' });
    expect(web?.exitCode).toBeUndefined();
    expect(api).toMatchObject({ state: 'absent', build: true, ports: [] });
  });

  it('слияние: цикл зависимостей не вешает разбор', () => {
    const stack = parseConfig(
      JSON.stringify({ services: { a: { depends_on: ['b'] }, b: { depends_on: ['a'] } } }),
    );
    expect(
      mergeServices(stack, [])
        .map((service) => service.name)
        .sort(),
    ).toEqual(['a', 'b']);
  });
});

describe('compose: где лежит файл', () => {
  const dirs: string[] = [];
  const temp = (): string => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-compose-')));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('нет файла — нет Compose', () => {
    expect(findComposeFile(temp())).toBeUndefined();
  });

  it('корень раньше docker/; override рядом попадает в список', () => {
    const root = temp();
    mkdirSync(join(root, 'docker'));
    writeFileSync(join(root, 'docker', 'compose.yaml'), 'services: {}');
    expect(findComposeFile(root)?.file).toBe('docker/compose.yaml');
    expect(findComposeFile(root)?.dir).toBe(join(root, 'docker'));

    writeFileSync(join(root, 'docker-compose.yml'), 'services: {}');
    writeFileSync(join(root, 'docker-compose.override.yml'), 'services: {}');
    expect(findComposeFile(root)).toMatchObject({
      dir: root,
      file: 'docker-compose.yml',
      files: ['docker-compose.yml', 'docker-compose.override.yml'],
    });
  });

  it('каталог с именем compose.yaml — не файл', () => {
    const root = temp();
    mkdirSync(join(root, 'compose.yaml'));
    expect(findComposeFile(root)).toBeUndefined();
  });
});

describe('compose: команды', () => {
  it('сервис сужает up/stop/restart; down всегда над стеком; тома — только -v', () => {
    const flags = ['compose', '--ansi', 'never', '--progress', 'plain'];
    expect(composeArgs('up', 'web')).toEqual([...flags, 'up', '-d', 'web']);
    expect(composeArgs('stop')).toEqual([...flags, 'stop']);
    expect(composeArgs('restart', 'db')).toEqual([...flags, 'restart', 'db']);
    expect(composeArgs('down', 'web')).toEqual([...flags, 'down']);
    expect(composeArgs('down-volumes')).toEqual([...flags, 'down', '-v']);
  });

  it('хвост вывода — не больше 200 строк, последние', () => {
    const big = Array.from({ length: 450 }, (_, i) => `line ${i}`).join('\n');
    const tail = appendTail('', big).split('\n');
    expect(tail).toHaveLength(200);
    expect(tail.at(-1)).toBe('line 449');
  });
});

interface FakeJob extends DockerJobProcess {
  args: string[];
  cwd: string;
  emit(chunk: string): void;
  exit(code: number | null, missing?: boolean): void;
  killed: boolean;
}

function fakeSpawn(): { jobs: FakeJob[]; spawn: (args: string[], cwd: string) => FakeJob } {
  const jobs: FakeJob[] = [];
  return {
    jobs,
    spawn: (args, cwd) => {
      let onOutput: (chunk: string) => void = () => {};
      let onExit: (code: number | null, missing: boolean) => void = () => {};
      const job: FakeJob = {
        args,
        cwd,
        killed: false,
        onOutput: (listener) => {
          onOutput = listener;
        },
        onExit: (listener) => {
          onExit = listener;
        },
        kill: () => {
          job.killed = true;
        },
        emit: (chunk) => onOutput(chunk),
        exit: (code, missing = false) => onExit(code, missing),
      };
      jobs.push(job);
      return job;
    },
  };
}

describe('compose: реестр действий', () => {
  it('одно действие на проект: второе — отказ, после конца — можно', () => {
    const fake = fakeSpawn();
    const registry = new ComposeRegistry(fake.spawn);
    const job = registry.start('/p', '/p/docker', 'up');
    expect(fake.jobs[0]?.cwd).toBe('/p/docker');
    expect(() => registry.start('/p', '/p/docker', 'down')).toThrow(ComposeBusyError);
    // Другой проект — свой стек, не ждёт.
    registry.start('/q', '/q', 'up');

    fake.jobs[0]?.emit(' Container x  Started\r\n');
    fake.jobs[0]?.exit(0);
    expect(registry.jobOf('/p')).toMatchObject({ id: job.id, status: 'done' });
    expect(registry.jobOf('/p')?.output).toBe(' Container x  Started');
    expect(registry.start('/p', '/p/docker', 'stop').action).toBe('stop');
  });

  it('отказ docker — failed с причиной в выводе; нет программы — так и сказано', () => {
    const fake = fakeSpawn();
    const finished: string[] = [];
    const registry = new ComposeRegistry(fake.spawn, (_path, job) => finished.push(job.status));
    registry.start('/p', '/p', 'up', 'web');
    fake.jobs[0]?.emit('Error: port is already allocated\n');
    fake.jobs[0]?.exit(1);
    expect(registry.jobOf('/p')).toMatchObject({ status: 'failed', service: 'web' });
    expect(registry.jobOf('/p')?.output).toContain('port is already allocated');

    registry.start('/p', '/p', 'up');
    fake.jobs[1]?.exit(null, true);
    expect(registry.jobOf('/p')?.output).toContain('docker: command not found');
    expect(finished).toEqual(['failed', 'failed']);
  });

  it('down не сужается сервисом; выход панели гасит идущий docker', () => {
    const fake = fakeSpawn();
    const registry = new ComposeRegistry(fake.spawn);
    const job = registry.start('/p', '/p', 'down', 'web');
    expect(job.service).toBeUndefined();
    registry.stopAll();
    expect(fake.jobs[0]?.killed).toBe(true);
  });
});

describe('compose: чтение стека', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const project = (): string => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-compose-read-')));
    dirs.push(dir);
    writeFileSync(join(dir, 'compose.yaml'), 'services: {}');
    return dir;
  };

  /** Docker по сценарию: ответ на `info`, `config` и `ps`; считает вызовы. */
  const fakeExec = (answers: Partial<Record<'info' | 'config' | 'ps', ExecResult>>) => {
    const calls: string[] = [];
    const exec: DockerExec = async (args) => {
      const kind = args[0] === 'info' ? 'info' : (args[1] as 'config' | 'ps');
      calls.push(kind);
      return answers[kind] ?? { code: 0, stdout: '', stderr: '' };
    };
    return { exec, calls };
  };

  it('нет docker — сказано, файл назван, ничего больше не спрашиваем', async () => {
    const dir = project();
    const { exec, calls } = fakeExec({
      info: { code: null, stdout: '', stderr: '', missing: true },
    });
    const info = await new ComposeReader(exec).describe(dir);
    expect(info).toMatchObject({ docker: 'missing', file: 'compose.yaml', services: [] });
    expect(calls).toEqual(['info']);
  });

  it('демон стоит — состав и тома из файла видны, контейнеров не спрашиваем', async () => {
    const dir = project();
    const { exec, calls } = fakeExec({
      info: { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' },
      config: { code: 0, stdout: CONFIG, stderr: '' },
    });
    const info = await new ComposeReader(exec).describe(dir);
    expect(info).toMatchObject({
      docker: 'stopped',
      dockerDetail: 'Cannot connect to the Docker daemon',
      projectName: 'agentdeck-fx',
      volumes: ['pgdata'],
      services: [],
    });
    expect(calls).toEqual(['info', 'config']);
  });

  it('файл не принят — ошибка docker дословно', async () => {
    const dir = project();
    const { exec } = fakeExec({
      config: {
        code: 15,
        stdout: '',
        stderr: 'validating compose.yaml: services.web additional property foo is not allowed',
      },
    });
    const info = await new ComposeReader(exec).describe(dir);
    expect(info.configError).toContain('additional property foo');
  });

  it('всё работает — сервисы с живым состоянием; config кэшируется до изменения файла', async () => {
    const dir = project();
    const { exec, calls } = fakeExec({
      config: { code: 0, stdout: CONFIG, stderr: '' },
      ps: { code: 0, stdout: PS, stderr: '' },
    });
    let now = 0;
    const reader = new ComposeReader(exec, () => now);
    const first = await reader.describe(dir);
    expect(first.services.map((service) => `${service.name}:${service.state}`)).toEqual([
      'job:exited',
      'web:running',
      'api:absent',
    ]);
    now = 5_000;
    await reader.describe(dir);
    expect(calls).toEqual(['info', 'config', 'ps', 'ps']);

    // Файл тронули — config снова; через 10 с — и info снова.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'compose.yaml'), later, later);
    now = 11_000;
    await reader.describe(dir);
    expect(calls).toEqual(['info', 'config', 'ps', 'ps', 'info', 'config', 'ps']);
  });

  it('config не ответил за отведённое время — не запоминаем, спросим снова', async () => {
    const dir = project();
    const { exec, calls } = fakeExec({ config: { code: null, stdout: '', stderr: 'timeout' } });
    const reader = new ComposeReader(exec);
    await reader.describe(dir);
    await reader.describe(dir);
    expect(calls.filter((call) => call === 'config')).toHaveLength(2);
  });
});
