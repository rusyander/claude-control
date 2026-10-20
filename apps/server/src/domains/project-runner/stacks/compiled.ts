import { join } from 'node:path';
import { isExecutableFile } from '../../../lib/path-lookup.mjs';
import { findUp, isFile, listDir, readText, relPath, shownPath } from './fs-probe.ts';
import type { PinPort, StackCandidate, StackProbe } from './stacks.types.ts';

/**
 * Rust, JVM (Gradle и Maven) и .NET — стеки, где запуск идёт через сборщик.
 *
 * Обёртки `gradlew`/`mvnw` из проекта предпочтительнее системных gradle/mvn:
 * версия сборщика зашита в проект, и системная может его просто не собрать.
 * Обёртка — файл проекта, поэтому её «наличие» проверяется по диску, а не по PATH.
 */

const IS_WINDOWS = process.platform === 'win32';

/** Spring Boot берёт порт из `SERVER_PORT` — `PORT` он не читает. */
const springPort: PinPort = (port) => ({ env: { SERVER_PORT: String(port) } });

export function rustCandidates({ dir }: StackProbe): StackCandidate[] {
  const manifest = join(dir, 'Cargo.toml');
  const text = readText(manifest);
  if (!text || !/^\[package\]/m.test(text)) return [];
  const main = join(dir, 'src', 'main.rs');
  if (!isFile(main) && !/^\[\[bin\]\]/m.test(text)) return [];
  return [
    {
      stack: 'rust',
      evidence: isFile(main) ? [manifest, main] : [manifest],
      file: 'cargo',
      args: ['run'],
      display: 'cargo run',
      tool: 'cargo',
    },
  ];
}

/**
 * Обёртка сборщика от каталога цели вверх до корня: `{ dir, path, run }` или undefined.
 * `run` — файл и первые аргументы запуска: обёртка без права на исполнение (закоммичена
 * с Windows как 100644, распакована из zip) идёт через `sh` — иначе spawn EACCES.
 */
function wrapper(dir: string, root: string, posix: string, windows: string) {
  const name = IS_WINDOWS ? windows : posix;
  const at = findUp(dir, root, [name]);
  if (!at) return undefined;
  const path = join(at, name);
  const run =
    IS_WINDOWS || isExecutableFile(path) ? { file: path, args: [] } : { file: 'sh', args: [path] };
  return { dir: at, path, run };
}

function gradleCandidates({ dir, root }: StackProbe): StackCandidate[] {
  const buildFile = ['build.gradle.kts', 'build.gradle'].map((n) => join(dir, n)).find(isFile);
  if (!buildFile) return [];
  const text = readText(buildFile) ?? '';
  const spring = /org\.springframework\.boot/.test(text);
  const application = /\bapplication\b/.test(text) && /plugins|apply\s+plugin/.test(text);
  if (!spring && !application) return [];
  const task = spring ? 'bootRun' : 'run';

  const wrap = wrapper(dir, root, 'gradlew', 'gradlew.bat');
  // Подпроект запускается из корня обёртки задачей с путём: `:services:api:bootRun`.
  const taskRef =
    wrap && wrap.dir !== dir ? `:${relPath(wrap.dir, dir).split('/').join(':')}:${task}` : task;
  const shown = wrap ? shownPath(wrap.dir, wrap.path) : 'gradle';
  return [
    {
      stack: 'java',
      ...(spring ? { framework: 'Spring Boot' } : {}),
      evidence: [buildFile, ...(wrap ? [wrap.path] : [])],
      file: wrap ? wrap.run.file : 'gradle',
      args: [...(wrap ? wrap.run.args : []), taskRef],
      ...(wrap ? { cwd: wrap.dir, toolPath: wrap.path } : { tool: 'gradle' }),
      display: `${shown} ${taskRef}`,
      ...(spring ? { pinPort: springPort } : {}),
    },
  ];
}

function mavenCandidates({ dir, root }: StackProbe): StackCandidate[] {
  const pom = join(dir, 'pom.xml');
  const text = readText(pom);
  if (!text || !/spring-boot-maven-plugin/.test(text)) return [];
  const wrap = wrapper(dir, root, 'mvnw', 'mvnw.cmd');
  const shown = wrap ? shownPath(dir, wrap.path) : 'mvn';
  return [
    {
      stack: 'java',
      framework: 'Spring Boot',
      evidence: [pom, ...(wrap ? [wrap.path] : [])],
      file: wrap ? wrap.run.file : 'mvn',
      args: [...(wrap ? wrap.run.args : []), 'spring-boot:run'],
      ...(wrap ? { toolPath: wrap.path } : { tool: 'mvn' }),
      display: `${shown} spring-boot:run`,
      pinPort: springPort,
    },
  ];
}

export function jvmCandidates(probe: StackProbe): StackCandidate[] {
  return [...gradleCandidates(probe), ...mavenCandidates(probe)];
}

export function dotnetCandidates({ dir }: StackProbe): StackCandidate[] {
  const project = listDir(dir).find((name) => name.endsWith('.csproj'));
  if (!project) return [];
  const file = join(dir, project);
  const text = readText(file) ?? '';
  const web = /Microsoft\.NET\.Sdk\.Web/.test(text);
  if (!web && !/<OutputType>\s*Exe\s*<\/OutputType>/i.test(text)) return [];
  return [
    {
      stack: 'dotnet',
      ...(web ? { framework: 'ASP.NET Core' } : {}),
      evidence: [file],
      file: 'dotnet',
      args: ['run'],
      display: 'dotnet run',
      tool: 'dotnet',
      // launchSettings.json задаёт адрес своей переменной и перекрыл бы наш —
      // аргумент приложения `--urls` главнее обоих.
      pinPort: (port) => ({ args: ['--', '--urls', `http://localhost:${port}`] }),
    },
  ];
}
