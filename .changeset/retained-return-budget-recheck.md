---
"@jfet97/t3-supervisor": patch
---

A status-only workflow write no longer fails with `pinned_definition_context_mismatch` after a new task agreed the same fixed workflow whose return kept its retained budget: the stored plan is rechecked against the pinned definitions with its own occurrences as the baseline, so a budget the service deliberately retained on a return is treated as that occurrence's identity rather than a candidate edit. Occurrence ids, the retained budget and its used count stay unchanged; a stale binding is still refused, and a budget id edited on a retained return is not adopted (the plan is normalized to the retained identity).
