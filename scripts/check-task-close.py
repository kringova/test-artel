#!/usr/bin/env python3
"""Гейт закрытия задач (Артель): механически блокирует некорректные коммиты задач.

Четыре гейта:
1. DONE-апрув: агент не может закоммитить переход в `done` — только через апрув-
   поверхность адоптера (ставит ARTEL_APPROVE=1).
2. created_at обязателен: при создании задачи и переходе в review/done.
3. Дубли id: блокирует коммит, если два task-файла имеют одинаковый `id`.
4. Вход в работу: прыжок `todo → review/done` без `doing` блокируется.

Запуск: как git pre-commit hook (core.hooksPath .githooks).
Honest-ограничение: коммиты делает агент, поэтому хук гарантирует ритуал и
аудит-след, а не криптостойкость — обойти флагом можно, но это явная улика.

Намеренно НЕ перенесено из llmush-адаптера (Claude-специфичное, не канон):
- cost_by_model / тиринг-чекпойнт: способ фиксировать стоимость задачи зависит
  от агента; канон Артели только требует маркер `doing`, а не конкретного механизма.
- Гейт делегирования (not_delegated): проверка junior/middle на Opus-только cost
  и поле delegation_note — привязка к Claude API, за рамками канона шаблона.
- LLMUSH_APPROVE: в шаблоне флаг называется ARTEL_APPROVE (адаптер переименовывает).
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

TASK_RE = re.compile(r"^projects/[^/]+/tasks/[^/]+\.md$")
STATUS_RE = re.compile(r"^status:\s*([A-Za-z_-]+)\s*$", re.MULTILINE)
CREATED_AT_RE = re.compile(r"^created_at:[^\S\n]*(.*)$", re.MULTILINE)
ID_RE = re.compile(r"^id:[^\S\n]*([0-9]+)\s*$", re.MULTILINE)


def git(args: list[str]) -> str:
    return subprocess.run(
        ["git", *args], capture_output=True, text=True
    ).stdout


def frontmatter_of(blob: str) -> str:
    """Вырезать frontmatter (между первым и вторым '---')."""
    if not blob:
        return ""
    parts = blob.split("---", 2)
    return parts[1] if len(parts) >= 3 else blob


def status_of(blob: str) -> str | None:
    """Вытащить status из frontmatter."""
    fm = frontmatter_of(blob)
    m = STATUS_RE.search(fm)
    return m.group(1) if m else None


def created_at_of(blob: str) -> str:
    """Значение created_at из frontmatter (пусто, если поля нет/пустое)."""
    if not blob:
        return ""
    fm = frontmatter_of(blob)
    m = CREATED_AT_RE.search(fm)
    return m.group(1).strip().strip('"') if m else ""


def id_of(blob: str) -> str | None:
    """Числовой id из frontmatter задачи."""
    if not blob:
        return None
    fm = frontmatter_of(blob)
    m = ID_RE.search(fm)
    return m.group(1) if m else None


def staged_files() -> list[str]:
    out = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    return [f for f in out.splitlines() if TASK_RE.match(f)]


def duplicate_ids(staged: list[str]) -> list[tuple[str, list[str]]]:
    """Дубли id по всему индексу.

    Читает все task-файлы из git-индекса (staged + committed), не с диска —
    то есть проверяет то, что реально войдёт в коммит. Блокируем только дубли,
    хотя бы один файл которых затронут этим коммитом (иначе хук не пропустит
    ни одного коммита в репо с уже существующим дублем).

    glob `projects/*/tasks/*.md` — стандартная структура Артели; адаптер с
    другим layout-ом должен скорректировать TASK_RE и эту строку.
    """
    # ls-files не принимает glob в позиционном аргументе на всех платформах,
    # поэтому фильтруем через TASK_RE сами.
    index_files = [
        f for f in git(["ls-files"]).splitlines() if TASK_RE.match(f)
    ]
    by_id: dict[str, list[str]] = {}
    for f in index_files:
        tid = id_of(git(["show", f":{f}"]))
        if tid:
            by_id.setdefault(tid, []).append(f)
    staged_set = set(staged)
    dups = []
    for tid, files in by_id.items():
        if len(files) > 1 and any(f in staged_set for f in files):
            dups.append((tid, sorted(files)))
    return dups


def main() -> int:
    # ARTEL_APPROVE=1 выставляет ТОЛЬКО апрув-поверхность (дашборд/CI), не агент.
    # Агент, ставящий флаг сам, обходит потолок review — это нарушение канона,
    # даже если технически проходит.
    # Флаг разблокирует ТОЛЬКО гейт 1 (done-апрув); гейты 2, 3, 4 работают всегда.
    approved = bool(os.environ.get("ARTEL_APPROVE"))

    staged = staged_files()

    offenders: list[str] = []    # переход в done без апрува
    no_created: list[str] = []   # нет created_at при создании / переходе в review/done
    skipped_doing: list[str] = []  # прыжок todo → review/done без doing

    for f in staged:
        new = git(["show", f":{f}"])       # staged-версия (что войдёт в коммит)
        old = git(["show", f"HEAD:{f}"])   # версия в HEAD (пусто, если новый файл)
        new_status = status_of(new)
        old_status = status_of(old)
        is_added = not old.strip()
        entering = new_status in ("review", "done") and old_status not in ("review", "done")

        # Гейт 1 — done только через апрув-поверхность.
        # ARTEL_APPROVE=1 разблокирует только этот гейт.
        if new_status == "done" and old_status != "done" and not approved:
            offenders.append(f)

        # Гейт 2 — created_at обязателен.
        # При создании задачи (новый файл) и при переходе в review/done.
        if (is_added or entering) and not created_at_of(new):
            no_created.append(f)

        # Гейт 4 — вход в работу: прыжок todo → review/done блокируется.
        # Новый файл сразу в review (постфактум-задача) — исключение: doing там нет.
        # Escape: поле `enter_note:` во frontmatter (обход с явным обоснованием).
        if (
            entering
            and old_status == "todo"
            and not is_added
            and "enter_note:" not in new
        ):
            skipped_doing.append(f)

    # Гейт 3 — дубли id (читается после staged_files для переиспользования списка).
    dups = duplicate_ids(staged)

    # --- вывод ошибок ---

    if no_created:
        sys.stderr.write(
            "\n✋ Дата создания обязательна (гейт Артели).\n\n"
            "У задачи должна быть непустая `created_at` — при заведении и при\n"
            "переходе в review/done. Пусто здесь:\n"
            + "".join(f"  · {f}\n" for f in no_created)
            + "\nЧто делать: проставь `created_at` (ISO-дата или дата-время создания).\n"
            "Новые задачи заводи из `_templates/task.md` — они пишут created_at сразу.\n\n"
        )

    if dups:
        sys.stderr.write(
            "\n✋ Дубликат id задачи (гейт Артели).\n\n"
            "У этих задач совпадает `id` — ссылки `#id` и апрув-поверхность берут\n"
            "первый файл, остальные становятся недоступны (частая причина —\n"
            "параллельные процессы, оба взявшие max+1):\n"
            + "".join(f"  · id {tid}: {', '.join(files)}\n" for tid, files in dups)
            + "\nЧто делать: перенумеруй один файл на свободный id (max+1 по\n"
            "projects/*/tasks/) и поправь ссылки на него.\n\n"
        )

    if skipped_doing:
        sys.stderr.write(
            "\n✋ Вход в работу: пропущен `doing` (гейт Артели).\n\n"
            "Эти задачи прыгнули `todo → review/done`, не пройдя через `doing`.\n"
            "Следствие: прогресс был невидим на канбане «В работе»:\n"
            + "".join(f"  · {f}\n" for f in skipped_doing)
            + "\nКанон Артели: вход в работу = перевод задачи в `doing` ДО начала\n"
            "работы. Разовый обход (правка статуса вне сессии / постфактум / нет\n"
            "промежуточного коммита) — добавь в задачу строку:\n"
            "  enter_note: <причина, почему doing не было отдельным коммитом>\n\n"
        )

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

    return 1 if (offenders or no_created or dups or skipped_doing) else 0


if __name__ == "__main__":
    sys.exit(main())
