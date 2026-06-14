---
id: 9
project: "[[example-project/example-project]]"
status: done
tags: [task]
created: 2026-06-14
created_at: 2026-06-14T19:41:12+03:00
updated: 2026-06-14
closed_at: 2026-06-14T16:44:02.305Z
sp: 2
rice_reach: 6
rice_impact: 3
rice_confidence: 100
rice_effort: 0.4
summary: "Перенести фильтры и полировку дашборда из шаблона"
roles: [reviewer, techwriter]
model_tier: junior
---

## Что нужно сделать
Перенести обновления дашборда из upstream-коммитов `515c862` и `0f04cad`, сохранив локальное исправление апрува из задачи #8.

## Почему важно
Фильтры, грейд-маркеры и счётчики делают рабочий дашборд нагляднее, а редкое автообновление не прерывает взаимодействие.

## Критерии готовности (DoD)
- [x] Дашборд показывает грейд-маркеры, фильтры и счётчики за сегодня
- [x] Автообновление страницы выполняется не чаще одного раза в 2 минуты
- [x] Апрув сохраняет `sp` и соседние поля frontmatter
- [x] Основные и новые страницы дашборда отвечают без ошибок
- [x] Пользовательские проекты и задачи сохранены

## Пререквизиты
[[fix-dashboard-approval-frontmatter]]

## Вопросы
нет

## Заметки
Upstream head на момент проверки: `0f04cad`. Файл `projects/example-project/tasks/replace-example.md` намеренно не переносится как пользовательские данные vault.
`dashboard/README.md` совпадает с upstream. `dashboard/serve.js` отличается только однострочным исправлением апрува из #8. Проверены `/`, `/kanban`, `/rice`, `/inbox`, `/analytics`, `/search`, `/t/9`, `/p/meal-planner` — HTTP 200; API-регрессия сохранила `sp` и `rice_reach`.
