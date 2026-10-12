/**
 * Демо-проекты бэкенда для проверок окна «Окружение» и запуска не-Node стеков.
 *
 * Каждый проект — минимальный, но НАСТОЯЩИЙ по разметке: те же файлы, по которым
 * панель угадывает стек у живого проекта (go.mod + cmd/<x>/main.go, uv.lock +
 * app/main.py с `FastAPI(`, manage.py, build.gradle со Spring Boot). Go-сервис
 * ещё и запускается по-настоящему (`go run`), если Go стоит: печатает адрес так,
 * как печатают Go-серверы без схемы (`listening on :PORT`), — это проверка
 * разбора вывода, а не только угадывания команды.
 *
 * Использование: `seedBackendProjects(dir)` → `{ go, fastapi, django, spring, plain, taskfile }`
 * с абсолютными путями.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function put(root, rel, text) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

/** Go-модуль: две программы в cmd/, Makefile с run, конфиг air для горячей перезагрузки. */
export function seedGoService(root, { port = 18091 } = {}) {
  put(root, 'go.mod', 'module example.com/orders\n\ngo 1.22\n');
  put(
    root,
    'cmd/api/main.go',
    `package main

import (
\t"fmt"
\t"net/http"
\t"os"
)

func main() {
\tport := os.Getenv("PORT")
\tif port == "" {
\t\tport = "${port}"
\t}
\thttp.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
\t\tw.Header().Set("Content-Type", "application/json")
\t\tfmt.Fprint(w, \`{"status":"ok"}\`)
\t})
\tfmt.Printf("orders api listening on :%s\\n", port)
\tif err := http.ListenAndServe("127.0.0.1:"+port, nil); err != nil {
\t\tfmt.Fprintln(os.Stderr, err)
\t\tos.Exit(1)
\t}
}
`,
  );
  put(
    root,
    'cmd/worker/main.go',
    `package main

import (
\t"fmt"
\t"time"
)

func main() {
\tfor {
\t\tfmt.Println("worker: tick")
\t\ttime.Sleep(5 * time.Second)
\t}
}
`,
  );
  put(root, 'internal/orders/orders.go', 'package orders\n\nfunc Count() int { return 0 }\n');
  put(root, 'Makefile', 'run:\n\tgo run ./cmd/api\n\ntest:\n\tgo test ./...\n');
  return root;
}

/** FastAPI на uv: приложение в app/main.py, lock-файл uv. */
export function seedFastApi(root) {
  put(
    root,
    'pyproject.toml',
    '[project]\nname = "billing"\nversion = "0.1.0"\ndependencies = ["fastapi", "uvicorn"]\n',
  );
  put(root, 'uv.lock', 'version = 1\n');
  put(root, 'app/__init__.py', '');
  put(
    root,
    'app/main.py',
    'from fastapi import FastAPI\n\napp = FastAPI(title="Billing")\n\n\n@app.get("/health")\ndef health():\n    return {"status": "ok"}\n',
  );
  return root;
}

/** Django: manage.py в корне. */
export function seedDjango(root) {
  put(root, 'requirements.txt', 'django>=5\n');
  put(
    root,
    'manage.py',
    '#!/usr/bin/env python\nimport os, sys\n\nif __name__ == "__main__":\n    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "shop.settings")\n    from django.core.management import execute_from_command_line\n    execute_from_command_line(sys.argv)\n',
  );
  put(root, 'shop/__init__.py', '');
  // Makefile с `run` — у такого проекта два способа запуска, и выбор между
  // ними в поповере проверяется на нём.
  put(root, 'Makefile', 'run:\n\tpython manage.py runserver\n');
  return root;
}

/** Spring Boot на Gradle с обёрткой gradlew. */
export function seedSpring(root) {
  put(
    root,
    'build.gradle.kts',
    'plugins {\n    id("org.springframework.boot") version "3.3.0"\n    java\n}\n',
  );
  put(root, 'settings.gradle.kts', 'rootProject.name = "catalog"\n');
  put(root, 'gradlew', '#!/bin/sh\necho gradle wrapper stub\n');
  put(root, 'gradlew.bat', '@echo gradle wrapper stub\r\n');
  return root;
}

/**
 * Скрипт на чистом Python без зависимостей: запускается где угодно, где есть
 * Python, и печатает адрес как uvicorn. Нужен, чтобы живой запуск Python-цели
 * проверялся без установки пакетов из сети.
 */
export function seedPlainPython(root, { port = 18092 } = {}) {
  put(
    root,
    'main.py',
    `import http.server, os, socketserver

PORT = int(os.environ.get("PORT", "${port}"))


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


if __name__ == "__main__":
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Serving on http://127.0.0.1:{PORT}")
        httpd.serve_forever()
`,
  );
  put(root, 'requirements.txt', '');
  return root;
}

/**
 * Сервис, который запускается только задачей Taskfile. На машине без `task`
 * это негатив: цель не запускаемая, и программа названа до запуска.
 */
function seedTaskfile(root) {
  put(root, 'Taskfile.yml', "version: '3'\ntasks:\n  dev:\n    cmds:\n      - echo dev\n");
  return root;
}

/**
 * Короткий транскрипт разговора в проекте: вкладка «Проекты» в чате строится по
 * транскриптам Claude Code, а не по реестру панели, — без него проекта там нет.
 */
export function seedChatTranscript(cfg, project, sessionId = randomUUID()) {
  const dir = join(cfg, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - 60_000).toISOString();
  const base = { sessionId, cwd: project, timestamp: at };
  const lines = [
    { ...base, type: 'user', uuid: 'u1', message: { role: 'user', content: 'Подними сервис' } },
    {
      ...base,
      type: 'assistant',
      uuid: 'a1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Готово.' }] },
    },
  ];
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    'utf8',
  );
}

/** Все демо-проекты в подкаталогах `dir`. */
export function seedBackendProjects(dir) {
  return {
    go: seedGoService(join(dir, 'orders-go')),
    fastapi: seedFastApi(join(dir, 'billing-fastapi')),
    django: seedDjango(join(dir, 'shop-django')),
    spring: seedSpring(join(dir, 'catalog-spring')),
    plain: seedPlainPython(join(dir, 'echo-python')),
    taskfile: seedTaskfile(join(dir, 'jobs-taskfile')),
  };
}
