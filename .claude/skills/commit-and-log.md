---
name: commit-and-log
description: End-of-session skill. Reviews what changed, writes a new build entry to MEMORY.md, and commits everything to git. Run this at the end of every session to maintain project context.
allowed-tools:
  - Bash
  - Read
  - Edit
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

### 2. Read current MEMORY.md

Read `MEMORY.md` to find:
- The last build number (e.g. "Build 1")
- What was previously done
- Any open issues or next steps carried forward

### 3. Write a new build entry

Append a new entry to `MEMORY.md` **before** the `<!-- Add new builds below this line -->` comment — insert it after the last `---` separator.

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
```

Determine the correct build number by incrementing from the last entry in MEMORY.md.
Use today's date: 2026-03-17 (update to actual current date).
Keep entries factual and concise — this is a developer log, not prose.

### 4. Stage and commit

```bash
cd "/Users/dhruv.sondhi/Documents/CLAUDE_CODE/Facetime App Builder/lovable-voice-builder"
git add -A
git status
```

Verify `config.js` and `.env` are NOT in the staged files (they are gitignored — this is a safety check).

Then commit:

```bash
git commit -m "Build N — <one-line summary> (YYYY-MM-DD)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

### 5. Confirm

Print to the user:
- The commit hash (`git log --oneline -1`)
- The full MEMORY.md entry you wrote
- A reminder to run `git push` if they want to sync to GitHub
