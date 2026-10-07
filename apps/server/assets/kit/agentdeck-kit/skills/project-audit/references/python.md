# Python canon — audit playbook

Modern Python (3.11+ assumed unless the project pins lower): typed, ruff-clean, pyproject-driven.

## A. Project & tooling baseline

- `pyproject.toml` is the single config source (deps, tool configs); `setup.py`/scattered cfg = P3.
- Locked env: uv/poetry/pip-tools lockfile present; bare `requirements.txt` without pins = P2.
- `ruff` (lint + format) configured; `mypy` or `pyright` configured — absence of any type checking
  on a non-script codebase = P2.
- src-layout (`src/<pkg>/`) for packages; tests importing via installed package, not path hacks.

## B. Typing & data boundaries

- Public functions fully annotated; `Any` leaks and untyped dict-passing across module boundaries
  = P2. Modern syntax: `list[str]`, `X | None`.
- IO boundaries validated: pydantic / dataclass + explicit parse at the edge; raw `dict` threaded
  through business logic = P2.
- `@dataclass(frozen=True)` or NamedTuple for value objects; mutable default argument = P1 classic.

## C. Correctness idioms

- Specific exceptions caught; bare `except:` / `except Exception: pass` = P1 (swallows KeyboardInterrupt
  / hides bugs). Custom exception hierarchy for domain errors.
- Resources via context managers (`with`); manual open/close pairs = P2.
- `pathlib.Path` over `os.path` strings; f-strings over %/format; comprehensions over map/filter
  chains where clearer.
- `logging` (structured where the stack has it) — `print` in library/service code = P3.
- Concurrency: asyncio code awaits everything it creates (orphan tasks = P1); blocking calls inside
  async paths (requests, time.sleep) = P1; GIL-bound CPU work claimed "async" = P2 mislabel.

## D. Structure

- Module size and function complexity per radon artifact; god-modules importing half the project
  flagged with the cycles artifact.
- Circular imports resolved by layering, not by mid-function imports (mid-function import as a cycle
  workaround = P2; as a lazy-load optimization — note only).
- Global singletons / module-level state initialized at import time = P2 (import order coupling,
  untestable).

## E. Tests

- pytest idiom: fixtures over setUp classes, parametrize over copy-paste, plain asserts.
- Tests isolated from network/clock/fs unless marked integration; monkeypatch/fakes at boundaries.
