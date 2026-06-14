---
tags: [index]
---

# Задачи example-project

```dataview
TABLE WITHOUT ID
  file.link AS "Задача",
  status AS "Статус",
  choice(contains(list("todo","doing"), status),
    string(round((rice_reach * rice_impact * rice_confidence / 100) / rice_effort, 2)),
    "—") AS "RICE",
  summary AS "Описание"
FROM "projects/example-project/tasks"
WHERE file.name != "tasks"
SORT choice(contains(list("todo","doing"), status),
  (rice_reach * rice_impact * rice_confidence / 100) / rice_effort,
  -1) DESC
```
