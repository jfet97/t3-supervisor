---
"@jfet97/t3-supervisor": patch
---

Remove the temporary separate-provider requirement for Supervisor helpers. Helpers
can inherit their root's normal provider, model and options while retaining native
ownership and completed-bootstrap checks. Same-provider helper reuse after parent
settlement requires a T3 build with upstream fix #23456, included in stable 0.1.7.
