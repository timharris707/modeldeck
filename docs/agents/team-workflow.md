# Team workflow — repo bindings (partial)

<!-- Partial binding of the team-workflow pack (timharris707/skills): only the
     adversarial-review skill is bound so far, at Tim's direction (2026-08-07).
     ModelDeck's own machinery (docs/lane-routing-policy.md, lane briefs,
     docs/HANDOFF.md) remains authoritative for everything else; a full pack
     setup interview has not run. Refresh via the pack's setup skill. -->

_Pack version at binding: team-workflow v1.3.0 · Bound: 2026-08-07_

## The decider

- **Decider**: Tim Harris

## Adversarial review (team-workflow `adversarial-review` skill)

- **Defect-class file**: [docs/agents/defect-classes.md](defect-classes.md) —
  seeded empty; grows only via live reproduction, proposed in the fixing PR.
  The hand-written per-review attack briefs (`.claude/lane-briefs/`) remain the
  instrument for high-stakes release stacks; this skill is the everyday floor.
- **Layers**: floor + orchestrator close-out (this repo runs orchestrated lanes).
- **Mandatory lenses**: **security** on anything touching credentials, Keychain,
  auth/renewal, or spawned-session env (the #199/#224 auth-override gate class);
  **UI/accessibility** on deck-row presentation (explicit accessibility labels
  suppressing child elements has bitten in #65, #113, #272); **compatibility**
  on daemon↔UI protocol or persisted-state changes.
- **Live-probe policy**: probes may drive local daemon/tests; **never** run
  `claude -p` or anything that spends provider quota, never touch the live
  Keychain or a running session, placeholder identities only (standing rule
  from this repo's review briefs).
- **Substantiality rules**: changes touching auth, renewal, routing, or the
  shell-env writer are always substantial.
