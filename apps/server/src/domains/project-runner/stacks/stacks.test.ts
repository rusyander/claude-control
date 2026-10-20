import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectCandidates, pickCandidate } from './stacks.ts';
import { justRecipes, makeTargets, taskfileTasks } from './task-runners.ts';
import { describeRunner, listRunnerTargets } from '../targets.ts';
import { extractBusyPort, extractServerPort } from '../output.ts';
import { resolveRunCommand } from '../stack.ts';

const IS_WINDOWS = process.platform === 'win32';
const everyTool = () => true;
const noTool = () => false;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stacks-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function put(rel: string, text = ''): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

const GO_MAIN = 'package main\n\nfunc main() {}\n';
const commands = (dir = root) =>
  detectCandidates({ dir, root }, everyTool).map((candidate) => candidate.display);

describe('Go: программа = package main внутри модуля', () => {
  it('cmd/<x> запускается из корня модуля, доказательства — go.mod и main.go', () => {
    put('go.mod', 'module example.com/x\n');
    put('cmd/api/main.go', GO_MAIN);
    const [candidate] = detectCandidates({ dir: join(root, 'cmd/api'), root }, everyTool);
    expect(candidate?.display).toBe('go run ./cmd/api');
    expect(candidate?.cwd).toBe(root);
    expect(candidate?.evidence).toEqual([join(root, 'go.mod'), join(root, 'cmd/api/main.go')]);
  });

  it('корень с main — go run .; без main — Go не предлагается', () => {
    put('go.mod', 'module x\n');
    put('main.go', GO_MAIN);
    expect(commands()).toEqual(['go run .']);
    rmSync(join(root, 'main.go'));
    put('lib.go', 'package x\n');
    expect(commands()).toEqual([]);
  });

  it('тестовый файл с main программой не считается', () => {
    put('go.mod', 'module x\n');
    put('main_test.go', GO_MAIN);
    expect(commands()).toEqual([]);
  });

  it('.air.toml — air первым, go run вторым', () => {
    put('go.mod', 'module x\n');
    put('main.go', GO_MAIN);
    put('.air.toml', '');
    expect(commands()).toEqual(['air', 'go run .']);
  });
});

describe('Python: интерпретатор так, как его взял бы проект', () => {
  const fastapi = 'from fastapi import FastAPI\n\napp = FastAPI()\n';

  it('uv.lock → uv run uvicorn модуль:объект', () => {
    put('pyproject.toml');
    put('uv.lock');
    put('app/main.py', fastapi);
    const [candidate] = detectCandidates({ dir: root, root }, everyTool);
    expect(candidate?.display).toBe('uv run uvicorn app.main:app --reload');
    expect(candidate?.framework).toBe('FastAPI');
    expect(candidate?.pinPort?.(8001)).toEqual({ args: ['--port', '8001'] });
  });

  it('src-раскладка: модуль от src и --app-dir src', () => {
    put('pyproject.toml');
    put('poetry.lock');
    put('src/billing/main.py', 'from fastapi import FastAPI\napi: FastAPI = FastAPI()\n');
    expect(commands()[0]).toBe('poetry run uvicorn billing.main:api --reload --app-dir src');
  });

  it('без менеджера — системный python и uvicorn модулем', () => {
    put('requirements.txt');
    put('main.py', fastapi);
    const system = IS_WINDOWS ? 'python' : 'python3';
    expect(commands()[0]).toBe(`${system} -m uvicorn main:app --reload`);
  });

  it('.venv проекта главнее системного python и доступен по файлу', () => {
    put('requirements.txt');
    put('manage.py', 'import sys\n');
    const exe = IS_WINDOWS ? '.venv/Scripts/python.exe' : '.venv/bin/python';
    put(exe);
    const [candidate] = detectCandidates({ dir: root, root }, noTool);
    expect(candidate?.file).toBe(join(root, exe));
    expect(candidate?.available).toBe(true);
    expect(candidate?.framework).toBe('Django');
    expect(candidate?.pinPort?.(9000)).toEqual({ args: ['127.0.0.1:9000'] });
  });

  it('Flask и простой скрипт с __main__', () => {
    put('requirements.txt');
    put('app.py', 'from flask import Flask\napp = Flask(__name__)\n');
    put('serve.py', 'print(1)\n');
    put('main.py', 'if __name__ == "__main__":\n    pass\n');
    const system = IS_WINDOWS ? 'python' : 'python3';
    expect(commands()).toEqual([
      `${system} -m flask --app app:app run --debug`,
      `${system} main.py`,
    ]);
  });

  it('объект внутри функции (фабрика) — не приложение модуля', () => {
    put('requirements.txt');
    put('app.py', 'from flask import Flask\ndef create():\n    app = Flask(__name__)\n');
    expect(commands()).toEqual([]);
  });

  it('без файлов-признаков Python не предлагается', () => {
    put('main.py', 'if __name__ == "__main__":\n    pass\n');
    expect(commands()).toEqual([]);
  });
});

describe('Задачи сборщиков: только «запускающие» имена', () => {
  it('Makefile: run и dev, но не build и не присваивание', () => {
    expect(
      makeTargets('CC := gcc\nbuild:\n\tgo build\nrun: build\n\tgo run .\n.PHONY: run\n'),
    ).toEqual(['build', 'run']);
    put('Makefile', 'build:\n\tx\nup:\n\tdocker compose up\nrun:\n\tx\ndev:\n\tx\n');
    expect(commands()).toEqual(['make dev', 'make run']);
  });

  it('Taskfile и justfile', () => {
    expect(taskfileTasks('version: "3"\ntasks:\n  serve:\n    cmds: [x]\n')).toEqual(['serve']);
    expect(justRecipes('run port="8080":\n  go run .\n@dev:\n  x\n')).toEqual(['run', 'dev']);
    put('Taskfile.yml', 'version: "3"\ntasks:\n  start:\n    cmds: [x]\n');
    put('justfile', 'serve:\n  x\n');
    expect(commands()).toEqual(['task start', 'just serve']);
  });

  it('скрипт package.json идёт раньше Makefile', () => {
    put('package.json', JSON.stringify({ scripts: { dev: 'vite' } }));
    put('Makefile', 'run:\n\tx\n');
    expect(commands()).toEqual(['npm run dev', 'make run']);
  });
});

describe('Rust, JVM, .NET', () => {
  it('Cargo: пакет с src/main.rs — cargo run; библиотека — нет', () => {
    put('Cargo.toml', '[package]\nname = "x"\n');
    put('src/lib.rs');
    expect(commands()).toEqual([]);
    put('src/main.rs', 'fn main() {}');
    expect(commands()).toEqual(['cargo run']);
  });

  it('Gradle-подпроект Spring Boot: обёртка корня и путь задачи', () => {
    put('services/api/build.gradle.kts', 'plugins { id("org.springframework.boot") }\n');
    put(IS_WINDOWS ? 'gradlew.bat' : 'gradlew');
    const [candidate] = detectCandidates({ dir: join(root, 'services/api'), root }, noTool);
    // POSIX: файл без права на исполнение (как после коммита с Windows) — через sh.
    expect(candidate?.file).toBe(IS_WINDOWS ? join(root, 'gradlew.bat') : 'sh');
    expect(candidate?.args).toEqual([
      ...(IS_WINDOWS ? [] : [join(root, 'gradlew')]),
      ':services:api:bootRun',
    ]);
    expect(candidate?.cwd).toBe(root);
    expect(candidate?.available).toBe(true);
    expect(candidate?.framework).toBe('Spring Boot');
    expect(candidate?.pinPort?.(8081)).toEqual({ env: { SERVER_PORT: '8081' } });
  });

  it.skipIf(IS_WINDOWS)('обёртка с правом на исполнение запускается сама', () => {
    put('pom.xml', '<plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin>');
    put('mvnw');
    chmodSync(join(root, 'mvnw'), 0o755);
    const [candidate] = detectCandidates({ dir: root, root }, noTool);
    expect(candidate?.file).toBe(join(root, 'mvnw'));
    expect(candidate?.args).toEqual(['spring-boot:run']);
  });

  it('Gradle без Spring и без application — не запускаемое', () => {
    put('build.gradle', 'plugins { id "java-library" }\n');
    expect(commands()).toEqual([]);
  });

  it('Maven без обёртки — системный mvn, недоступен без PATH', () => {
    put('pom.xml', '<plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin>');
    const [candidate] = detectCandidates({ dir: root, root }, noTool);
    expect(candidate?.display).toBe('mvn spring-boot:run');
    expect(candidate?.available).toBe(false);
  });

  it('ASP.NET Core: порт аргументом приложения', () => {
    put('Api.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>');
    const [candidate] = detectCandidates({ dir: root, root }, everyTool);
    expect(candidate?.display).toBe('dotnet run');
    expect(candidate?.pinPort?.(5005)).toEqual({ args: ['--', '--urls', 'http://localhost:5005'] });
  });
});

describe('выбор: первый доступный, иначе первый', () => {
  it('нет make — выбирается go run, make остаётся в списке', () => {
    put('go.mod', 'module x\n');
    put('main.go', GO_MAIN);
    put('Makefile', 'run:\n\tgo run .\n');
    const found = detectCandidates({ dir: root, root }, (tool) => tool === 'go');
    expect(found.map((c) => [c.display, c.available])).toEqual([
      ['make run', false],
      ['go run .', true],
    ]);
    expect(pickCandidate(found)?.display).toBe('go run .');
    expect(resolveRunCommand(root, undefined, root, (tool) => tool === 'go').display).toBe(
      'go run .',
    );
  });
});

describe('describeRunner: стек, варианты, недостающая программа', () => {
  it('Go-модуль: цели cmd/*, у корня без main — причина без упоминания одного package.json', () => {
    put('go.mod', 'module x\n');
    put('cmd/api/main.go', GO_MAIN);
    put('cmd/worker/main.go', GO_MAIN);
    const info = describeRunner(
      root,
      () => undefined,
      (tool) => tool === 'go',
    );
    expect(info.targets.map((t) => t.dir)).toEqual(['', 'cmd/api', 'cmd/worker']);
    // Цели найдены сканом каталогов, а не «один пакет — корень».
    expect(info.workspaceSource).toBe('scan');
    const [rootTarget, api] = info.targets;
    expect(rootTarget?.runnable).toBe(false);
    expect(rootTarget?.candidates).toEqual([]);
    expect(api).toMatchObject({
      runnable: true,
      stack: 'go',
      command: 'go run ./cmd/api',
      evidence: ['go.mod', 'cmd/api/main.go'],
      inGroup: false,
    });
  });

  it('программы нет — цель не запускаемая и программа названа', () => {
    put('Cargo.toml', '[package]\nname = "x"\n');
    put('src/main.rs');
    const [target] = describeRunner(root, () => undefined, noTool).targets;
    expect(target).toMatchObject({ runnable: false, missingTool: 'cargo', command: 'cargo run' });
  });

  it('свою команду не проверяем по PATH; стек custom; отметка набора из памяти', () => {
    put('Cargo.toml', '[package]\nname = "x"\n');
    put('src/main.rs');
    const [target] = describeRunner(
      root,
      () => ({ command: 'cargo watch -x run', inGroup: true }),
      noTool,
    ).targets;
    expect(target).toMatchObject({ runnable: true, stack: 'custom', inGroup: true });
    expect(target?.candidates.map((c) => c.command)).toEqual(['cargo run']);
  });

  it('команда, выбранная из найденных, остаётся находкой: стек, каталог запуска, порт стека', () => {
    put('go.mod', 'module x\n');
    put('cmd/api/main.go', GO_MAIN);
    put('Makefile', 'run:\n\tgo run ./cmd/api\n');
    const api = join(root, 'cmd', 'api');
    const memory = () => ({ command: 'go run ./cmd/api' });
    const [, target] = describeRunner(root, memory, () => true).targets;
    expect(target).toMatchObject({
      runnable: true,
      stack: 'go',
      evidence: ['go.mod', 'cmd/api/main.go'],
    });
    const spec = resolveRunCommand(api, 'go run ./cmd/api', root, () => true);
    expect(spec.cwd).toBe(root);

    put('manage.py');
    put('pyproject.toml', '[project]\nname = "x"\ndependencies = ["django"]\n');
    // Находка зовёт системный Python так, как он называется на этой ОС (python.ts).
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const django = resolveRunCommand(root, `${py} manage.py runserver`, root, () => true);
    expect(django.pinPort?.(8123)).toEqual({ args: ['127.0.0.1:8123'] });
    // Строка, которой среди находок нет, — своя команда без чужих правил порта.
    expect(resolveRunCommand(root, `${py} manage.py runserver 0:9`, root).pinPort).toBeUndefined();
  });
});

describe('listRunnerTargets: бэкенд-сервисы рядом с воркспейсами', () => {
  it('services/* со стеком и программы Go-модуля внутри сервиса', () => {
    put('package.json', JSON.stringify({ workspaces: ['apps/*'] }));
    put('apps/web/package.json', JSON.stringify({ name: 'web', scripts: { dev: 'vite' } }));
    put('services/billing/pyproject.toml');
    put('services/billing/manage.py');
    put('services/orders/go.mod', 'module orders\n');
    put('services/orders/cmd/api/main.go', GO_MAIN);
    put('services/docs/README.md');
    const dirs = listRunnerTargets(root).targets.map((t) => t.dir);
    expect(dirs).toEqual(['', 'apps/web', 'services/billing', 'services/orders/cmd/api']);
  });

  it('каталог, найденный воркспейсами, второй раз не добавляется', () => {
    put('pnpm-workspace.yaml', 'packages:\n  - services/*\n');
    put('services/api/package.json', JSON.stringify({ scripts: { dev: 'node .' } }));
    expect(listRunnerTargets(root).targets.map((t) => t.dir)).toEqual(['', 'services/api']);
  });
});

describe('вывод бэкендов: адрес без схемы и занятый порт', () => {
  it.each([
    ['orders api listening on :18091', 18091],
    ['[GIN-debug] Listening and serving HTTP on :8080', 8080],
    ['⇨ http server started on [::]:1323', 1323],
    ['Tomcat started on port 8080 (http) with context path', 8080],
    ['Tomcat started on port(s): 8081 (http)', 8081],
    ['Netty started on port 9090', 9090],
    ['listening on 127.0.0.1:3000', 3000],
    ['Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)', 8000],
  ])('%s → %i', (line, port) => {
    expect(extractServerPort(line)).toBe(port);
  });

  it.each([
    'Server started at 10:45:00',
    'worker started on 2026-10-12',
    'running 12 migrations',
    'worker: tick',
  ])('не порт: %s', (line) => {
    expect(extractServerPort(line)).toBeUndefined();
  });

  it('Go и Spring жалуются на занятый порт по-своему', () => {
    expect(extractBusyPort('listen tcp 127.0.0.1:8080: bind: address already in use')).toBe(8080);
    expect(
      extractBusyPort(
        'listen tcp :9000: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted.',
      ),
    ).toBe(9000);
    expect(extractBusyPort('Web server failed to start. Port 8080 was already in use.')).toBe(8080);
  });
});
