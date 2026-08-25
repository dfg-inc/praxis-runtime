---
name: propose-rule-from-findings
description: Turn repeated quality findings into a knowledge rule proposal for human owners (WBS 6.8 / 2.5).
---

# Propose rule from findings

1. Group identical finding fingerprints across reviews/audits.
2. If count ≥ 2, call knowledge `prepareFindingProposal` with `kind: repeated-choice` (or map architecture/override kinds).
3. Present the proposal to the knowledge-area owner — **do not auto-merge**.
4. On reject, persist reason so the same fingerprint is suppressed.
