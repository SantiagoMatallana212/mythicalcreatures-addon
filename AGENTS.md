# AGENTS.md

## Project

Mythical Creatures is a Minecraft Bedrock add-on composed of a Behavior Pack (`mythical_BP`) and Resource Pack (`mythical_RP`).

JavaScript uses the Minecraft Script API directly. There is currently no build step.

## Task workflow

At the start of every task:

1. Read `MEMORY.md`.
2. Inspect the relevant existing code before making changes.
3. Check current local changes when they may overlap with the task.
4. Use the smallest process appropriate to the work.

At the end of every completed task:

1. Verify the change appropriately.
2. Update `MEMORY.md` with the new operational state.
3. Remove obsolete information from `MEMORY.md`.
4. Move stable knowledge to `AGENTS.md` or dedicated documentation when appropriate.
5. Keep `MEMORY.md` at approximately 50 lines or fewer.

Do not use `MEMORY.md` as a changelog. Git is the development history.

## Working rules

- Understand existing code and project patterns before changing unfamiliar systems.
- Prefer the smallest change that solves the requested problem.
- Reuse existing project systems and conventions before introducing new abstractions.
- Prefer native Bedrock components when they express the mechanic cleanly; use Script API when native behavior is insufficient or orchestration/state is required.
- Do not refactor unrelated code while implementing a feature.
- Preserve unrelated local changes.
- Do not upgrade `format_version`, manifests or API dependencies without a concrete reason.
- Treat Behavior Pack and Resource Pack behavior as connected when properties, events, animations or controllers cross that boundary.

## Sources

For Bedrock behavior, schemas and APIs, prefer official sources:

1. Minecraft Creator Documentation on Microsoft Learn.
2. Mojang `bedrock-samples`, using the stable branch/release matching the project target.
3. Official Minecraft Bedrock release and Creator changelogs.

Do not rely on old examples or community documentation when current official documentation contradicts them.

Preview/Beta documentation should only be used when explicitly evaluating preview functionality.

## Verification

Use the lightest verification appropriate to the change.

Automated tests and diagnostics can validate data and script logic, but they do not prove that native Bedrock AI, physics, animations or gameplay behave correctly.

Changes involving gameplay behavior must be verified in-game when practical.

A failing test may represent a stale expectation. Understand the intended current behavior before modifying production code just to satisfy a test.

## Documentation

- `AGENTS.md`: stable project-wide rules and workflow.
- `MEMORY.md`: current operational context only; keep it at approximately 50 lines or fewer.
- Stable system knowledge belongs in dedicated documentation when needed.
- Git is the development history.

Do not create documentation, skills, agents, tests or tooling preemptively. Add them when repeated work or project complexity demonstrates a real need.