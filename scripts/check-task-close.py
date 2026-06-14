#!/usr/bin/env python3
"""Гейт закрытия задач (Артель): агент не может закоммитить переход в `done`.

`done` ставит только человек — через апрув-поверхность адоптера (например,
кнопку в его дашборде), чей апрув-сервис коммитит с переменной окружения
ARTEL_APPROVE=1 (тогда хук пропускает). Любой другой коммит, переводящий
задачу в `done`, блокируется.

Запуск: как git pre-commit hook (по умолчанию проверяет staged-изменения).
Honest-ограничение: коммиты делает агент, поэтому хук гарантирует ритуал и
аудит-след, а не криптостойкость — обойти флагом можно, но это явная улика.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

TASK_RE = re.compile(r"^projects/[^/]+/tasks/[^/]+\.md$")
STATUS_RE = re.compile(r"^status:\s*([A-Za-z_-]+)\s*$", re.MULTILINE)


def git(args: list[str]) -> str:
    return subprocess.run(
        ["git", *args], capture_output=True, text=True
    ).stdout


def status_of(blob: str) -> str | None:
    """Вытащить status из frontmatter (первый блок до второго '---')."""
    if not blob:
        return None
    parts = blob.split("---", 2)
    fm = parts[1] if len(parts) >= 3 else blob
    m = STATUS_RE.search(fm)
    return m.group(1) if m else None


def staged_files() -> list[str]:
    out = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    return [f for f in out.splitlines() if TASK_RE.match(f)]


def main() -> int:
    # Апрув-поток (апрув-поверхность адоптера) — единственный легальный путь в done.
    if os.environ.get("ARTEL_APPROVE"):
        return 0

    offenders = []
    for f in staged_files():
        new = git(["show", f":{f}"])       # staged-версия
        old = git(["show", f"HEAD:{f}"])   # версия в HEAD (пусто, если новый файл)
        new_status = status_of(new)
        if new_status == "done" and status_of(old) != "done":
            offenders.append(f)

    if offenders:
        sys.stderr.write(
            "\n✋ Закрытие задачи заблокировано (гейт Артели).\n\n"
            "Агент не ставит `done` — это делает человек через апрув-поверхность\n"
            "адоптера (например, кнопку в дашборде); апрув-сервис коммитит с\n"
            "ARTEL_APPROVE=1. Потолок агента — `review`.\n\n"
            "Переведено в done без апрува:\n"
            + "".join(f"  · {f}\n" for f in offenders)
            + "\nЧто делать: верни статус в `review`, предъяви работу и жди апрува\n"
            "пользователя. См. навык `close`.\n\n"
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
