# Справочник по структуре

```
AGENTS.md            канонические правила для агента (вендор-нейтрально)
CLAUDE.md            шим @AGENTS.md для Claude Code
_rules.md            полная методология
_dashboard.md        Dataview-сводка: проекты, беклог по RICE, канбан
_templates/
  task.md            шаблон задачи
  project.md         шаблон карточки проекта
_inbox/              сырые записи «на разбор», по файлу на запись
projects/
  <slug>/
    <slug>.md        карточка проекта
    roadmap.md       фазы с чекбоксами
    tasks/
      tasks.md       Dataview-индекс задач проекта
      <имя>.md       задачи
skills/
  sync/SKILL.md      контекст всех проектов в сессию
  backlog/SKILL.md   завести задачу
  close/SKILL.md     закрыть задачу (done + лог); постфактум-задача
  recap/SKILL.md     итоги за период
  inbox/SKILL.md     разобрать инбокс
docs/
  methodology.md     принципы, проекты, задачи, RICE, жизненный цикл
  roles.md           роли команды и их включение по RICE
  workflow.md        жизненный цикл и гейты
  doc-canon.md       канон документации проекта, карта APC
  styleguide.md      как писать доку (APC, против воды)
  reference.md       эта страница — структура и поля
  skills.md · faq.md · installation.md
```

## Frontmatter задачи

```yaml
---
id: 42                      # сквозной номер тикета (max по vault + 1)
project: "[[slug/slug]]"    # wiki-ссылка на карточку проекта
status: todo                # todo | doing | done | blocked | cancelled
tags: [task]                # + bug для багов/инцидентов
created: 2026-06-12
updated: 2026-06-12         # обновлять при каждом изменении
sp: 3                       # Story Points — размер (Фибоначчи 1/2/3/5/8/13), не время
rice_reach: 5               # 1–10
rice_impact: 3              # 1–5
rice_confidence: 80         # 50–100
rice_effort: 0.6            # sp / 5, минимум 0.1
summary: "Одна строка для индексов"
roles: [reviewer, techwriter]  # опц.: роли, выведенные из RICE-порогов (см. roles.md)
model_tier: middle          # грейд модели по природе задачи (см. methodology.md)
---
```

Разделы тела: «Что нужно сделать», «Почему важно», «Критерии готовности (DoD)», «Пререквизиты», «Вопросы», «Заметки». Семантика каждого — в [methodology.md](methodology.md).

Поле `roles` — какие роли Артели включаются на задаче; выводится из компонентов RICE (пороги — в [roles.md](roles.md) и [workflow.md](workflow.md)).

Поле `sp` — размер задачи в Story Points (Фибоначчи), первичная оценка вместо времени; `rice_effort = sp/5`. Поле `model_tier` — грейд модели по природе задачи. Оба — в [methodology.md](methodology.md). Старые задачи могут иметь `est_days` вместо `sp` (переходный период).

## Frontmatter проекта

```yaml
---
status: active              # idea | active | paused | done
type: product               # свободная типизация: product, tool, research…
priority: medium            # high | medium | low
tags: [project]
audience: "кто пользуется"
repo: "https://github.com/..."
local: "/path/to/code"
updated: 2026-06-12
---
```

## Запись инбокса

```yaml
---
created: 2026-06-12T13:09:13.195Z   # ISO-дата
project: financeush                  # slug; можно опустить — агент определит
tags: [inbox]
---

текст мысли как есть
```

Имя файла любое уникальное, например `2026-06-12-1309-ab12.md`.

## Индекс задач проекта (tasks.md)

Dataview-запрос (готовый — в `projects/example-project/tasks/tasks.md`; при копировании поменяйте путь в `FROM`). Сортировка: активные по убыванию RICE, затем done/cancelled; их RICE отображается как «—».

## Dataview-поля, на которых всё держится

Сводки строятся из frontmatter, поэтому критично: `tags` содержит `project`/`task`, `status` из фиксированного набора, числовые `rice_*` заполнены. Сломанный frontmatter = задача выпала из дашборда.
