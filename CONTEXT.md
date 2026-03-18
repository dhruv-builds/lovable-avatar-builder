# Lovable Voice Builder — LLM Context File

> Use this file to brief an LLM for demo strategy brainstorming.
> Last updated: Build 5 (2026-03-18)

---

## 1. Product Summary

**Lovable Voice Builder** (extension display name: "Facetime Lovable Builder") is a Chrome extension that lets you build apps on Lovable.dev using voice commands. You speak an instruction, an AI avatar (powered by Anam.ai) hears it, Claude (Anthropic) reformulates your casual speech into a precise Lovable prompt, and the prompt is automatically injected into Lovable's chat. Lovable builds the app, its response is captured from the page, and the avatar narrates it back to you. The full loop — speak → build → hear response — happens without touching the keyboard.

**Who it's for:** Non-technical users who want to build apps on Lovable but find typing precise prompts difficult. Also developers who want a hands-free workflow.

**Current demo-ready mode:** Text input (type instead of speak). Voice/avatar path is built but needs live testing with fresh Anam credentials.

---

## 2. Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension type | Chrome Manifest V3 |
| Language | Vanilla JavaScript (no build step, no bundler) |
| Avatar / TTS | Anam.ai JS SDK v4 (bundled locally as `sidepanel/anam-sdk.js`) |
| AI reformulation | Anthropic Claude API (`claude-haiku-4-5-20251001` by default) |
| Target site | lovable.dev (homepage + project pages) |
| UI | Side panel (Chrome's built-in side panel API) |
| Storage | `chrome.storage.session` (conversation history; clears on browser close) |
| Entry points | `background/service-worker.js`, `sidepanel/sidepanel.html`, `content/content-script.js` |

---

## 3. Core User Flow

```
1. User opens Chrome with a Lovable.dev tab open.
2. User opens the extension side panel ("Facetime Lovable Builder").
3. User speaks into the microphone (or types in the text input).
4. Anam avatar captures the speech → fires MESSAGE_HISTORY_UPDATED event.
5. sidepanel.js sends USER_SPEECH message to service worker.
6. service-worker.js calls Claude API with user speech + conversation history.
   → Claude returns [PROMPT]: <structured prompt>
     OR [CLARIFY]: <clarifying question>
7a. If [CLARIFY]: → service worker broadcasts CLARIFICATION to side panel
    → avatar narrates the question back → user answers → loop continues.
7b. If [PROMPT]: → service worker sends INJECT_PROMPT to content script.
8. content-script.js finds Lovable's chat input on the active tab.
   → Injects prompt text (synthetic paste event for TipTap/ProseMirror)
   → Clicks the send button.
9. Lovable receives the prompt and starts building.
10. MutationObserver on the page captures Lovable's response text.
11. content-script.js sends LOVABLE_RESPONSE to service worker.
12. service-worker.js adds response to conversation history,
    broadcasts SPEAK_RESPONSE to side panel.
13. Avatar narrates Lovable's response back to the user.
14. Activity log in side panel shows the full exchange.
```

---

## 4. Component Map

| Component | File | Role |
|-----------|------|------|
| Service Worker | `background/service-worker.js` | Message router; Claude API client; rate limiting (2s); conversation history; tab routing |
| Side Panel UI | `sidepanel/sidepanel.html` | Layout: avatar video, status bar, activity log, prompt display, controls, text input |
| Side Panel Logic | `sidepanel/sidepanel.js` | Anam SDK init; speech event handlers; UI state updates; text-only fallback |
| Side Panel Styles | `sidepanel/sidepanel.css` | Dark theme (black/purple); status indicator animations; activity log colors |
| Content Script | `content/content-script.js` | DOM injection into Lovable; MutationObserver for responses; build state detection |
| Anam SDK | `sidepanel/anam-sdk.js` | 97KB bundled UMD; provides `window.anam` for avatar/TTS |
| Config | `config.js` (gitignored) | All API keys + behavior tuning; created from `config.example.js` |
| Icons | `icons/` | 16x16, 48x48, 128x128 — AI avatar + speech wave design |

---

## 5. Message Protocol

All communication uses `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`.

| Message Type | Direction | Key Payload Fields | Purpose |
|---|---|---|---|
| `USER_SPEECH` | Panel → SW | `text` | User finished speaking; trigger Claude reformulation |
| `INJECT_PROMPT` | SW → Content | `prompt` | Inject reformulated prompt into Lovable chat |
| `LOVABLE_RESPONSE` | Content → SW | `text`, `messageId` | Lovable's reply captured from DOM |
| `LOVABLE_STATUS` | Content → SW | `status` (idle/building), `detail` | Build state changed |
| `CLARIFICATION` | SW → Panel | `text` | Claude asked a question; avatar should speak it |
| `SPEAK_RESPONSE` | SW → Panel | `text` | Lovable responded; avatar should narrate |
| `PROMPT_SENT` | SW → Panel | `prompt` | Prompt was injected; update display |
| `INJECTION_ERROR` | Content → Panel | `error` | Injection failed; show in activity log |
| `RESET_CONVERSATION` | Panel → SW | — | Clear history; start fresh |

---

## 6. Current State — What Works

| Feature | Status | Notes |
|---------|--------|-------|
| Text input → Claude → Lovable | ✅ Working | Full path confirmed in testing |
| Claude prompt reformulation | ✅ Working | Biases toward action; max 2 clarifying questions |
| Mock mode (no API keys) | ✅ Working | `CONFIG.MOCK_MODE = true` returns canned responses |
| Tab routing (multi-tab) | ✅ Working | Tries active tab, then all Lovable tabs in order |
| Activity log in side panel | ✅ Working | 20 entries, color-coded, auto-scroll |
| Rate limiting (2s cooldown) | ✅ Working | Prevents Claude API abuse |
| Conversation history | ✅ Working | Persisted to `storage.session`; multi-turn context |
| Text-only fallback mode | ✅ Working | No Anam key needed; text input always available |
| Debug log panel | ✅ Working | Toggle via `CONFIG.DEBUG_LOG = true` |
| TipTap/ProseMirror injection | ⚠️ Needs live test | Selectors confirmed; paste strategy untested on real page |
| Lovable response capture | ⚠️ Needs live test | MutationObserver logic written; not validated on current Lovable DOM |
| Build state detection | ⚠️ Speculative | Heuristic class-name matching; Lovable DOM may differ |
| Anam avatar (full voice loop) | ⚠️ Untested | SDK v4 flow written; free Anam minutes exhausted; needs fresh key |
| Anam TTS narration | ⚠️ Untested | `createTalkMessageStream()` wired up; not confirmed live |

---

## 7. Config Options

All in `config.js` (copy from `config.example.js`):

```javascript
const CONFIG = {
  // API credentials
  ANAM_API_KEY: '',              // Bearer token from Anam.ai dashboard
  ANAM_AVATAR_ID: '',            // UUID (e.g., Cara desk: 30fa96d0-...)
  ANAM_VOICE_ID: '',             // UUID (e.g., Lauren: d79f2051-...)
  ANTHROPIC_API_KEY: '',         // sk-ant-... key from Anthropic console
  ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',

  // Behavior tuning
  DEBOUNCE_MS: 1500,             // Wait for Lovable streaming to settle before capturing response
  MAX_SPEECH_LENGTH: 500,        // Truncate Lovable responses for TTS
  MAX_CONVERSATION_HISTORY: 10,  // Rolling window of messages sent to Claude

  // Development
  MOCK_MODE: false,              // Skip Claude API; return canned [PROMPT]: responses
  DEBUG_LOG: false               // Show debug log panel in side panel UI
};
```

---

## 8. Known Fragilities

1. **DOM selectors are heuristic** — `SELECTORS` in `content-script.js` were written by inspecting Lovable's current DOM. If Lovable updates their UI, injection and response capture may silently break. Fix: open DevTools on lovable.dev, inspect the chat input, update `SELECTORS`.

2. **Anam SDK is manually bundled** — `sidepanel/anam-sdk.js` is a local copy of `@anam-ai/js-sdk@4.11.0`. If Anam releases a breaking SDK update, requires manual redownload and re-bundle. Chrome MV3 CSP blocks remote script loading.

3. **Build state detection is speculative** — the stop-button and class-name heuristics for detecting "Lovable is building" haven't been validated on the live Lovable UI.

4. **API keys in client-side JS** — acceptable for personal use; not for shared or production deployment (would need a backend proxy).

5. **No persistent error logging** — extension errors visible in DevTools only; the activity log helps but doesn't survive a panel close.

6. **Anam mic access in sidepanel** — Chrome often silently denies mic permission in extension side panels. Non-fatal (text input still works), but means voice path may not work without an explicit `getUserMedia` grant from the side panel context.

---

## 9. Build History

| Build | Date | One-liner |
|-------|------|-----------|
| 1 | 2026-03-17 | MV3 skeleton — Anam avatar, Claude API, content script prompt injection |
| 2 | 2026-03-17 | MV3 CSP fix — moved `AnamAI` alias to JS file; pre-flight API diagnostics |
| 3 | 2026-03-17 | SDK v4 session token flow; homepage TipTap selectors; mic permission graceful fail |
| 4 | 2026-03-18 | Rebrand + new icon; rate limiting; mock mode; conversation history persistence; debug log panel |
| 5 | 2026-03-18 | Tab routing overhaul; echo suppression; activity log; text-only mode; TipTap paste injection |

---

## 10. Demo-Relevant Notes

### What you can demo TODAY without Anam
- Set `MOCK_MODE: false`, provide only `ANTHROPIC_API_KEY`
- Text input → Claude reformulation → prompt injected into Lovable
- Activity log shows the full exchange in the side panel
- Status bar changes color with each state (listening → processing → building → done)
- Reset button clears conversation and starts fresh

### Safe demo without any API keys
- Set `MOCK_MODE: true` in `config.js`
- All Claude calls return canned `[PROMPT]:` responses
- Full UI flow demonstrated without hitting any external APIs
- Activity log, status transitions, and injection all work

### Screen share tips
- Side panel is visible next to the Lovable page — easy to show both simultaneously
- Activity log (max 20 entries) shows color-coded exchange: You / Sent / Lovable / Error
- Status bar dot animates (green glow = listening, blue = building, purple = narrating)

### Full voice demo (needs fresh Anam key)
- Sign up / refresh Anam free tier at https://anam.ai
- Get new API key, paste into `config.js`
- Avatar: Cara (desk variant, ID in MEMORY.md Build 1)
- Voice: Lauren, empathetic US female (ID in MEMORY.md Build 1)
- Extension name shown to user: "Facetime Lovable Builder"

### Unique selling points for the pitch
1. **Zero-keyboard app building** — describe what you want in plain English, avatar builds it
2. **Prompt engineering handled automatically** — Claude translates vague speech into precise Lovable prompts
3. **Conversational loop** — if your request is ambiguous, the avatar asks a clarifying question
4. **No install friction** — load unpacked in Chrome; one `config.js` file to edit
5. **Works on every Lovable page** — homepage new-project creation AND in-project iterative changes

---

## 11. File Tree

```
lovable-voice-builder/
├── manifest.json               # MV3 config — permissions, host policies, entry points
├── config.js                   # GITIGNORED — your API keys (copy from config.example.js)
├── config.example.js           # Committed placeholder template
├── background/
│   └── service-worker.js       # Core logic: Claude API, message routing, rate limiting
├── content/
│   └── content-script.js       # Runs on lovable.dev: injection, observer, build state
├── sidepanel/
│   ├── sidepanel.html          # UI layout
│   ├── sidepanel.js            # Anam init, speech events, UI logic
│   ├── sidepanel.css           # Dark theme styles
│   └── anam-sdk.js             # Bundled Anam SDK (97KB, MV3 CSP compliant)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── MEMORY.md                   # Developer build log
└── CONTEXT.md                  # This file
```
