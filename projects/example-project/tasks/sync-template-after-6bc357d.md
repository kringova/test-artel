---
id: 13
project: "[[example-project/example-project]]"
status: review
tags: [task]
created: 2026-06-15
created_at: 2026-06-15T09:13:40+03:00
updated: 2026-06-15
closed_at:
sp: 3
rice_reach: 6
rice_impact: 3
rice_confidence: 85
rice_effort: 0.6
summary: "Подтянуть шаблоны docs и скилл charter после 6bc357d"
roles: [reviewer, techwriter]
model_tier: middle
---

## Что нужно сделать
Перенести из `kringova/artelush/main` commit `6bc357d`: новые шаблоны `brief.md`, `decisions.md`, `scenarios.md`, шаблон `roadmap.md`, новый скилл `charter`, а также обновление `docs/reference.md` и ссылок на новые артефакты.

## Почему важно
Шаблон Артели расширился на жизненный цикл проекта с брифом и стартовым каркасом. Без этого новый проектный канон и справка будут отставать от upstream.

## Критерии готовности (DoD)
- [x] В `_templates/docs/` есть `brief.md`, `decisions.md` и `scenarios.md`
- [x] В `_templates/` есть `roadmap.md`
- [x] В `skills/` есть `charter/SKILL.md` и он описан в справке
- [x] `docs/reference.md` перечисляет новые шаблоны и скилл
- [x] Локальные проектные документы и текущие задачи не перезаписаны

## Пререквизиты
нет

## Вопросы
нет

## Заметки
Сравнение идёт с архивом commit `6bc357d09fd3446357e48e372497fcb518df9909`. Локальные расширения `doc-canon.md` и существующий канон vault не откатывать.
