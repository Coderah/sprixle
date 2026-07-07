# Contract docs — the prompt-set method

Method doc — last revised 2026-07-07. This is a cross-project *working convention*, not
an engine-source reference; it carries a plain revision date rather than an
`Engine ref:` stamp (see §4 on why the two dating conventions differ).

A **contract doc** is a prompt-driven spec that outlives the conversation that produced
it: a scope/design document a cold agent can pick up and build from, weeks later, without
the original context. The convention emerged on the `orrery` branch — the `orrery-*.md`
set at that project's repo root is the reference corpus (read `orrery-ops-selection.md`,
`orrery-tracker-song.md`, and `orrery-reconciliation-decisions.md` as worked examples).
Use this method whenever the user asks to "scope," "design," "write a spec," or "make a
doc" for a feature or phase of work.

## 1. Where they live and how they're named

- **At the project repo root**, named `<project>-<topic>.md` (`orrery-audio-bus.md`,
  `orrery-tracker-song.md`). They are *project artifacts* — the engine submodule
  (`src/sprixle/`) holds engine reference; contract docs are the game/app's own spec.
  (Root clutter is a known cost as a project accumulates docs; a `docs/` subfolder is a
  fine future call — decide per project, don't force it.)
- **Prompt-set letter prefixes.** Each doc/phase claims a namespace for its buildable
  units — orrery's history runs P (phase 2), U (phase 3), S/T, X, I/O, V, E. Keep the
  allocation monotonic and non-colliding; a new doc picks the next free letter and
  numbers within it (E1, E2, …). Later prose then cites units by their stable tag
  ("the P6 membership SCAR", "D12", "X12's fill-if-absent rule").

## 2. Anatomy of a contract doc

1. **Title** — `# PROJECT — <topic> (<prompt-range>)`, e.g. `# ORRERY — OP, selection,
   clipboard, MENU (O1–O4)`.
2. **Framing blockquote** (`>`) — the prime mover (why this, why now), and an honest
   statement of what is **assumed** vs **verified**. Say plainly whether the doc is a
   *proposal* (greenfield, marks its unknowns) or a *spec* (buildable, seams nailed
   down). `orrery-mixer-proposal.md`'s "§0 Framing correction" is the model for honesty.
3. **Cross-cutting locked decisions** — the load-bearing contract. Numbered (P1/G1/D1…),
   each a **bolded lead clause** then one decision. These are what a reader quotes and
   what later docs cite. One idea per entry; if an entry needs "and also," split it.
4. **Verified groundwork (date)** — `file:line` facts confirmed against HEAD *before*
   scoping, with a "re-confirm before editing, code drifts" caveat. This section is what
   makes a doc buildable by an agent with no prior context: it hands over the exact
   seams. Produce it by fanning out read-only Explore agents (see the master-agent
   working style in the engine CLAUDE.md) and citing what they found.
5. **Per-prompt specs** — one buildable unit each: its locked decisions, the exact
   insertion seams (`file:line`), edge cases, and an explicit list of what is
   *deferred*. A prompt should be forkable to a fresh implementation agent as-is.

## 3. The reconciliation-authority pattern

Docs written ahead of implementation *will* drift from the code that gets built. Resolve
it with one designated tie-breaker doc — `<project>-reconciliation-decisions.md` — that:

- states up front "treat this as the source of truth; where it contradicts an earlier
  doc, it wins",
- records each decision with its reasoning (not just the ruling), and
- lists the in-place edits to make in the superseded docs.

Then **reconcile in place**: edit the superseded doc where the stale claim lives and note
the supersession there ("SUPERSEDES … the pre-D12 state"), so a reader landing on the old
section isn't misled. Docs are a living change surface, exactly like the engine topic
docs (mirror the "Doc maintenance" rule in the engine CLAUDE.md).

## 4. Status, provenance, and dating markers

- **Completion** — `COMPLETE`, `DONE (YYYY-MM-DD)`, `DEFERRED`. Date the DONEs; a dated
  ledger is how the project's CLAUDE.md notes stay trustworthy.
- **`verify-FAILED`** — a negative result kept in the doc on purpose. When something was
  tried and didn't work (orrery's X7 slide: `accelerate` is consumed by nothing in the
  installed superdough), record it with the evidence. A proven dead-end is as valuable
  as a decision — it stops the next agent re-walking it.
- **✓** — a decision locked *with the user* in the authoring session (as opposed to a
  default the author chose). Marks the difference between "confirmed" and "proposed".
- **SCAR** — a hard-won gotcha that already bit us and must never be re-stepped-on.
  Always state *what broke and why*, not just the rule (orrery's "P6 membership SCAR":
  putting an optional component in a query's `includes` made every entity fail to match,
  emptying the sheet AND masking all audio to silence). SCARs are the highest-value lines
  in a doc; write them so the failure is unmistakable.
- **Dating conventions differ by doc kind, deliberately** (the resolution of a real
  inconsistency): engine topic docs carry `Engine ref: <commit> (<date>)` because they
  track drift against *engine source*; contract docs use **bare inline dates at the point
  of change** because they track *prompt/decision* history, not source drift. Method docs
  like this one use a plain "last revised" date. Don't cross-apply them.

## 5. Writing discipline

- **Verify before you scope.** Never write seams from memory — read the code (fan out
  Explore agents for breadth) and cite `file:line`. The groundwork section is the proof.
- **Proposal vs spec honesty.** Mark assumptions as assumptions. Hand load-bearing
  unknowns to the implementer *explicitly* ("open question for the builder: …") rather
  than guessing and burying the guess.
- **Keep decisions numbered and quotable.** The value compounds: a stable tag ("D9
  momentary contract") lets every later doc and CLAUDE.md note reference it in a few
  words instead of re-explaining.
- **Independence + build order.** State which units are file-disjoint (forkable in
  parallel) and which must serialize, and give a suggested order. This is what lets the
  master agent orchestrate the build (engine CLAUDE.md "Forked work").

## 6. Relationship to the project's CLAUDE.md

The two are different surfaces, and keeping the split clean is what makes both usable:

- **Contract docs are the SPEC** — the detailed, per-prompt reasoning and seams. Read
  on-demand when building that feature.
- **The project's root CLAUDE.md "project-specific notes" is the RUNNING LEDGER** —
  always-loaded, the current *truth*: what's DONE, what reconciled to what, the vocabulary
  as it actually stands. When a prompt-set completes, fold its headline decisions into
  the ledger (orrery's project notes are the reference — dense, dated, cross-linked).

So the flow is: scope a contract doc → build from it (forked) → reconcile the doc in
place against what got built → fold the headlines into CLAUDE.md. The doc records *how we
decided*; the ledger records *where we are*.

## Authoring checklist

1. Read this doc and the relevant reference examples (`orrery-*.md`).
2. Fan out read-only agents to gather `file:line` groundwork; synthesize.
3. Draft: title · framing blockquote · cross-cutting locked decisions · verified
   groundwork (dated) · per-prompt specs with seams, edge cases, deferrals.
4. Surface genuine forks to the user; mark their answers ✓.
5. State build order + which units are file-disjoint.
6. On completion of the work, reconcile in place and fold headlines into CLAUDE.md.
