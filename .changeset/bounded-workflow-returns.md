---
"@jfet97/t3-supervisor": patch
---

Workflow returns require `back_to(n)`, a maximum of successful backward jumps. An exhausted return stays visible instead of starting another attempt, and an enclosing return resets only strictly nested replay budgets.
