# Project Memory — Lovable Voice Builder

Track of major build milestones. Updated after each significant session.

---

## Build 1 — Initial Setup (2026-03-17)

### What was built
- Chrome MV3 extension skeleton: manifest, service worker, side panel, content script
- Anam.ai avatar in side panel — captures speech, displays video, narrates responses
- Claude API integration — reformulates casual speech into structured Lovable prompts
- Content script — injects prompts into lovable.dev chat, captures responses via MutationObserver

### Key decisions
- **No build step** — vanilla JS only, loads directly into Chrome
- **Anam brainType `CUSTOMER_CLIENT_V1`** — bring-your-own-intelligence mode; Claude does all reasoning
- **MV3 CSP fix** — Anam SDK was originally loaded from CDN (`cdn.jsdelivr.net`). Chrome MV3 blocks remote scripts. Fixed by downloading SDK locally as `sidepanel/anam-sdk.js` (from `@anam-ai/js-sdk@4.11.0`, `dist/umd/anam.js`). Added global alias: `var AnamAI = window.anam`
- **Avatar**: Cara (ID: `30fa96d0-26c4-4e55-94a0-517025942e18`, desk variant, female)
- **Voice**: Lauren — Empathetic and Encouraging, US female (ID: `d79f2051-3a89-4fcc-8c71-cf5d53f9d9e0`). Original voice ID `15518586-...` was invalid (404); replaced via Anam API voice list

### API keys validated
- Anthropic: HTTP 200
- Anam session token: HTTP 200 (issued successfully)
- Anam avatar ID: HTTP 200
- Anam voice ID: HTTP 200 (after fix)

### Repo hardening
- `.gitignore` — excludes `config.js`, `.env`, `.DS_Store`, `.vscode/`
- `config.example.js` — placeholder template for sharing
- `.env.example` — documents required env vars
- `generate-config.sh` — generates `config.js` from `.env`
- `README.md` — comprehensive setup, usage, troubleshooting, architecture notes

### Known issues / next steps
- DOM selectors in `content/content-script.js` are heuristic — may break if Lovable updates their UI. If injection stops working, inspect lovable.dev in DevTools and update the `SELECTORS` object
- No error logging beyond console — consider adding a debug log panel in side panel for production use
- API keys are in client-side JS (acceptable for personal use; proxy calls through backend for production)

---

## Build 2 — MV3 CSP fix, diagnostics, git/skill tooling (2026-03-17)

### What was built / changed
- **`sidepanel/sidepanel.js`**: Moved `var AnamAI = window.anam` from an inline `<script>` tag into the JS file — inline scripts are blocked by Chrome MV3 CSP, this was causing the avatar connection to silently fail
- **`sidepanel/sidepanel.js`**: Added pre-flight diagnostic `fetch` to `api.anam.ai/v1/session` before SDK init — surfaces clear error messages (HTTP status + body) instead of a generic "Failed to connect avatar"
- **`sidepanel/sidepanel.js`**: Improved catch block — now shows the actual error message in the status bar and avatar label instead of a generic fallback
- **`sidepanel/sidepanel.html`**: Removed the inline `<script>var AnamAI = window.anam;</script>` tag (moved to sidepanel.js)
- **`.claude/skills/commit-and-log.md`**: New end-of-session skill — reviews git diff, writes MEMORY.md entry, stages and commits. Invoke with `/commit-and-log`
- **Git repo**: Initialized, `.gitignore` protecting secrets, pushed to `https://github.com/dhruv-builds/lovable-avatar-builder` (private)

### Key decisions
- `var AnamAI = window.anam` must live in a `.js` file, not an inline `<script>` — MV3 CSP blocks all inline scripts in extension pages
- Pre-flight API check gives faster, clearer feedback when Anam credentials are wrong vs when the SDK itself fails

### Known issues / next steps
- Avatar connection still needs live testing with the extension loaded in Chrome — pre-flight fetch added but full SDK stream not yet confirmed working end-to-end
- DOM selectors in `content/content-script.js` remain fragile — test prompt injection on lovable.dev
- `/commit-and-log` skill requires a session restart to be auto-discovered by Claude Code

---

## Build 3 — SDK v4 session token flow & homepage selectors (2026-03-17)

### What was built / changed
- **`sidepanel/sidepanel.js`**: Replaced `unsafe_createClientWithApiKey` with production session-token flow — fetches token from `api.anam.ai/v1/auth/session-token`, then calls `AnamAI.createClient(sessionToken)`. Fixes engine 500 errors caused by the legacy session type
- **`sidepanel/sidepanel.js`**: Switched from `.on()` event pattern to SDK v4 `addListener` + `AnamEvent` enum (`MESSAGE_HISTORY_UPDATED`, `CONNECTION_ESTABLISHED`, `CONNECTION_CLOSED`, `MIC_PERMISSION_GRANTED`, `MIC_PERMISSION_DENIED`)
- **`sidepanel/sidepanel.js`**: Replaced guessed `sendMessage`/`speak`/`streamText` calls with SDK v4 `createTalkMessageStream()` API for BYO-brain TTS
- **`sidepanel/sidepanel.js`**: Added upfront `getUserMedia({ audio: true })` check with graceful fallback — mic blocked in extension sidepanels doesn't crash init, text input still works
- **`content/content-script.js`**: Expanded `SELECTORS.chatInput` with homepage-specific selectors (`textarea[placeholder*="create"]`, `textarea[placeholder*="build"]`), rich-text contenteditable variants, and data-testid fallbacks
- **`content/content-script.js`**: Expanded `SELECTORS.sendButton` with "Create", "Start", and submit test-id selectors
- **`content/content-script.js`**: Added diagnostic logging — on inject, logs page context (homepage vs project) and all matching selectors to console for debugging

### Key decisions
- Session token exchange (`/v1/auth/session-token`) is the correct production flow for Anam SDK v4 — `unsafe_createClientWithApiKey` uses a legacy session type that triggers server 500s
- `llmId: 'CUSTOMER_CLIENT_V1'` replaces `brainType` in the persona config for the token endpoint
- Mic permission failure is non-fatal — sidepanels often can't access mic, but voice output and text input still work

### Known issues / next steps
- Full end-to-end avatar streaming still needs live testing in Chrome
- Homepage selector coverage is speculative — needs validation on actual lovable.dev homepage DOM
- `MESSAGE_HISTORY_UPDATED` event needs testing to confirm it fires on user speech completion as expected

---

## Build 4 — Rebrand, new icon, rate limiting & debug tooling (2026-03-18)

### What was built / changed
- **Rebrand**: Renamed extension from "Lovable Voice Builder" to "Facetime Lovable Builder" in `manifest.json` (name + default_title)
- **New icon**: Replaced placeholder solid-color icons with AI avatar + speech wave design (generated via Google Image FX / Nano Banana Pro), resized to 16x16, 48x48, 128x128
- **`manifest.json`**: Added `storage` permission for session persistence
- **`background/service-worker.js`**: Added rate limiting (2s cooldown between Claude API calls), mock mode for testing without API keys, conversation history persistence via `chrome.storage.session`, proper multi-turn context (Claude responses stored separately from Lovable responses), extracted `processUserSpeech()` for cleaner message handling
- **`sidepanel/sidepanel.js`**: Added speech debouncing (500ms) to prevent Anam SDK rapid-fire events, debug log panel (toggled via `CONFIG.DEBUG_LOG`), mock mode status indicator, improved startup validation (skips API key check in mock mode)
- **`sidepanel/sidepanel.html`**: Added debug log panel UI (hidden by default, shown when `CONFIG.DEBUG_LOG` is true)
- **`content/content-script.js`**: Deduplicated candidate elements in `extractLatestResponse()` using a `Set` to prevent duplicate processing

### Key decisions
- Rate limiting at the service worker level (not panel) — prevents API abuse regardless of input source
- Mock mode (`CONFIG.MOCK_MODE`) enables full UI testing without Anthropic/Anam API keys
- Conversation history persisted to `chrome.storage.session` — survives service worker restarts but clears on browser close
- Claude's own responses now tracked as `from: 'claude'` in history for accurate multi-turn context

### Known issues / next steps
- Full end-to-end avatar streaming still needs live testing in Chrome
- `config.js` needs `MOCK_MODE` and `DEBUG_LOG` fields added to `config.example.js`
- Homepage selector coverage on lovable.dev still needs validation

---

<!-- Add new builds below this line -->
