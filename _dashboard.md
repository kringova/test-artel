---
tags: [dashboard]
---

# Обзор

## Проекты

```dataview
TABLE status, type, priority, audience, updated
FROM "projects"
WHERE contains(tags, "project")
SORT priority ASC
```

---

## Задачи по RICE

```dataview
TABLE project, status,
  (rice_reach * rice_impact * rice_confidence / 100 / rice_effort) AS "RICE"
FROM "projects"
WHERE contains(tags, "task") AND status != "done" AND status != "cancelled"
SORT (rice_reach * rice_impact * rice_confidence / 100 / rice_effort) DESC
```

---

## Канбан

### Todo
```dataview
LIST WITHOUT ID "**" + file.link + "** — " + project
FROM "projects"
WHERE contains(tags, "task") AND status = "todo"
SORT (rice_reach * rice_impact * rice_confidence / 100 / rice_effort) DESC
```

### В работе
```dataview
LIST WITHOUT ID "**" + file.link + "** — " + project
FROM "projects"
WHERE contains(tags, "task") AND status = "doing"
SORT updated DESC
```

### Готово (последние 10)
```dataview
LIST WITHOUT ID "**" + file.link + "** — " + project
FROM "projects"
WHERE contains(tags, "task") AND status = "done"
LIMIT 10
SORT updated DESC
```
