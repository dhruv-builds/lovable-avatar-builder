---
name: commit-and-log
description: End-of-session skill. Reviews what changed, writes a new build entry to MEMORY.md, and commits everything to git. Run this at the end of every session to maintain project context.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
---

# Commit and Log

You are closing out a development session on the **Lovable Voice Builder** Chrome extension. Your job is to capture what happened, update the project memory, and commit cleanly to git.

## Steps

### 1. Assess what changed

Run these commands to understand the session's work:

```bash
cd "/Users/dhruv.sondhi/Documents/CLAUDE_CODE/Facetime App Builder/lovable-voice-builder"
git status
git diff HEAD
git log --oneline -5
```

If `git status` shows no modified, added, or untracked files, tell the user **"Nothing to commit — working tree clean"** and stop. Do not proceed to the remaining steps.

### 2. Read current MEMORY.md

Read `MEMORY.md` to find:
- The last build number (e.g. "Build 4")
- What was previously done
- Any open issues or next steps carried forward

**If MEMORY.md does not exist**, create it with this content and proceed with Build 1:

```markdown
# Project Memory — Lovable Voice Builder

Track of major build milestones. Updated after each significant session.

---

<!-- Add new builds below this line -->
```

### 3. Write a new build entry

Determine today's date by running:

```bash
date +%Y-%m-%d
```

Use the output as the date in the entry and commit message. Never hardcode a date.

Insert the new build entry immediately **above** the `<!-- Add new builds below this line -->` comment at the end of MEMORY.md. The entry should end with `---`, a blank line, then the sentinel comment.

If the sentinel comment is missing from MEMORY.md, append the new entry at the very end of the file, followed by the sentinel comment.

Use this format:

```markdown
## Build N — <short title> (YYYY-MM-DD)

### What was built / changed
- <bullet list of concrete changes made this session>

### Key decisions
- <any architectural or approach decisions worth remembering>

### Known issues / next steps
- <anything broken, deferred, or worth picking up next time>

---

<!-- Add new builds below this line -->
```

Determine the correct build number by incrementing from the last entry in MEMORY.md.
Keep entries factual and concise — this is a developer log, not prose.

### 4. Stage and commit

Run `git status --porcelain` to get the list of changed and untracked files. From that list, **exclude** any file matching these patterns (they contain secrets or are not meant to be committed):

- `config.js`
- `.env`
- `*.log`
- `node_modules/*`

Stage the remaining files **explicitly by name**:

```bash
cd "/Users/dhruv.sondhi/Documents/CLAUDE_CODE/Facetime App Builder/lovable-voice-builder"
git add <file1> <file2> ...
git status
```

If no files remain to stage after exclusions, tell the user and stop.

Verify `config.js` and `.env` are **NOT** in the staged files (belt-and-suspenders safety check). If they appear, unstage them with `git reset HEAD <file>` before committing.

Then commit:

```bash
git commit -m "$(cat <<'EOF'
Build N — <one-line summary> (YYYY-MM-DD)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### 5. Confirm

Print to the user:
- The commit hash (`git log --oneline -1`)
- A short diffstat (`git diff --stat HEAD~1`) showing files changed, insertions, and deletions
- The full MEMORY.md entry you wrote
- A reminder to run `git push` if they want to sync to GitHub
