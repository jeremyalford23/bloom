Bloom Project Instructions

Apply these instructions at the start of every Bloom task.

## Access check

At the start of every session, verify that the GitHub connection is available outside the current sandbox. State the result before proceeding. Do not assume access from a prior session. You do not have to check before each command.

## Git workflow

Use the single long-lived branch `codex/bloom` for all Bloom work.

Before starting a new task, confirm the branch is synchronized with the current default branch. Commit and push all approved changes to `codex/bloom`, and create pull requests from `codex/bloom` into the default branch.

Do not create a pull request unless the user requests that you do.

Treat the current local files as authoritative.
Stage only files edited for the current request.
Run the focused checks once.
Commit, push, and open the PR.
No extra worktrees, file reconstruction, rebasing, or full-suite testing unless necessary or requested.
If Git’s state genuinely prevents a safe PR, explain it before spending time fixing it.

## App preview

## User is viewing the Bloom app at http://100.114.213.81:8712/. This is a Tailscale address.

## Versioning

For every Bloom update, bump the API version using the project's established version location and convention. Include the new API version in the completion summary. If no API-version mechanism exists, stop and ask before creating one.

## Completion summary

After every update, provide a complete list of changed files grouped and sorted by parent folder. Show paths relative to the repository root. Include added, modified, renamed, and deleted files.

Example:

server/
  - server/api/version.js (modified)
  - server/routes/income.js (modified)

web/src/
  - web/src/components/IncomeCard.jsx (modified)

./
  - package.json (modified)
  
## Ignored Folders
Ignore the folder named "ignore" when comparing to the repository.
