# Pi Research project instructions

- Before resuming implementation, read `docs/handover.md` and `docs/project-plan.md`. The plan is the full approved scope; the handover records actual code, drafts, missing modules and verification limits.
- Use the existing configured subagent types and their model/thinking defaults. **Do not supply model or thinking overrides**, switch providers, or launch replacement workers because one stalls or is interrupted. Report an explicit provider failure separately from a stall.
- The user intends to update the global Implement configuration themselves. Do not edit global agent definitions on their behalf.
- Delegate concrete deliverables with one file owner and explicit interfaces. Avoid oversized investigation/test-scaffolding assignments; implement the component first, then perform proportional verification.
- Commit each coherent milestone as it is ready. Do not leave all implementation work for one final commit. State precisely what checks establish; an incomplete component is not a completed system.
- Preserve unfinished work. `docs/drafts/*.ts.txt` are deliberately non-runnable handover material, not verified code to copy blindly.
- Dependencies are already installed and pinned; do not repeat environment discovery/scaffolding. Project-local dependency installation was approved; live paid research calls and global configuration changes were not.
