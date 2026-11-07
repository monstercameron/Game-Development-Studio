# Linting and formatting

Forge uses ESLint for JavaScript and React Hooks, Prettier for supported web and documentation files, and Ruff for Python. The style and behavioral rules are in [AGENTS.md](../AGENTS.md). The configurations are `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, and `ruff.toml`.

## Install

From the repository root, install the JavaScript dependencies with `pnpm install --frozen-lockfile` or `npm ci`. Use Node 24 or newer. For Python checks, create a separate development environment with native Windows Python; do not install developer tools into a model's environment:

```powershell
py -3.12 -m venv .venv-dev
.\.venv-dev\Scripts\python.exe -m pip install -r requirements-dev.txt
```

If `py` is unavailable, invoke an installed Python 3.12 executable directly. `.venv-dev` is local and ignored by Git. These tools do not load model weights or require a GPU.

## Check and fix

```powershell
pnpm lint                  # ESLint, all JavaScript/JSX
pnpm format:check          # Prettier, supported files
pnpm lint:python           # Ruff, runtime and test Python
pnpm format:python:check   # Ruff formatting check

# Focus on files you are changing:
pnpm exec eslint src/Example.jsx runtime/example.js
pnpm exec prettier --check src/Example.jsx src/example.css
.\.venv-dev\Scripts\python.exe -m ruff check runtime/example.py
.\.venv-dev\Scripts\python.exe -m ruff format --check runtime/example.py
```

Replace example paths with existing files. `npm run` and `npx` equivalents also work. The Python package scripts target the Windows development environment above. Ruff uses a Python 3.10 syntax target for compatibility; the development tool itself runs in Python 3.12.

To format a specific file, use `pnpm exec prettier --write path/to/file` or `.\.venv-dev\Scripts\python.exe -m ruff format path/to/file.py`. `pnpm format`, `pnpm format:python`, and `pnpm lint:fix` modify files across their configured scope; inspect the changes and do not run them over unrelated work. Ruff's `check --fix` also changes files. The ignore files protect generated state and lockfiles from the broad Prettier command.

The broad JavaScript checks include JavaScript and JSX fixtures under `test/fixtures`; the Python Ruff scripts cover Python files under both `runtime` and `test`, including Python fixtures. There is no separate fixture-only lint or format command. Tests use selected fixtures as subprocess, service, engine, and recovery stand-ins; their presence does not establish coverage for every runtime behavior.

Run the relevant checks after changes; their results reflect the current worktree and may change as the project evolves. ESLint uses its recommended correctness rules, additional control-flow rules, and React Hooks rules; Ruff checks syntax, common errors, bug-prone constructs, and import order. Style rules that are not machine-checkable remain review requirements. Neither tool verifies model inference, security, accessibility, or output quality.
