---
name: lovable-voice-builder
description: Context and tools for developing the Lovable Voice Builder Chrome extension. Loads project architecture, file map, key patterns, and known issues so you can immediately contribute without re-exploring the codebase.
---

# Lovable Voice Builder — Developer Context

You are working on a **Chrome Manifest V3 extension** that adds a voice interface to Lovable.dev. When this skill is active, you have full context about the project architecture and can immediately help with development tasks.

## What the extension does

1. User speaks to an Anam.ai avatar in Chrome's side panel
2. Speech is transcribed by the Anam SDK
3. Background service worker sends the transcription to Claude API
4. Claude reformulates casual speech into a structured Lovable.dev prompt
5. Content script injects the prompt into lovable.dev's chat input and submits it
6. MutationObserver captures Lovable's response and sends it back to the avatar for narration

## File Map

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest — permissions, host permissions, entry points |
| `config.js` | Local config with real API keys (gitignored) |
| `config.example.js` | Template committed to git with placeholder values |
| `background/service-worker.js` | Message router; calls Claude API; maintains conversation history |
| `sidepanel/sidepanel.html` | Side panel UI layout |
| `sidepanel/sidepanel.css` | Dark theme (#0f0f11 bg, #8b5cf6 accent) |
| `sidepanel/sidepanel.js` | Anam SDK init, speech events, UI state |
| `sidepanel/anam-sdk.js` | Anam SDK UMD bundle — bundled locally (MV3 blocks CDN) |
| `content/content-script.js` | Injects prompts into lovable.dev; captures responses |
| `MEMORY.md` | Build history — update after every major session |

## Key Patterns

### Anam SDK initialization
```javascript
// anam-sdk.js exports as `window.anam` (not `AnamAI`)
// sidepanel.html aliases it: var AnamAI = window.anam;
anamClient = AnamAI.unsafe_createClientWithApiKey(CONFIG.ANAM_API_KEY, {
  personaConfig: {
    avatarId: CONFIG.ANAM_AVATAR_ID,
    voiceId: CONFIG.ANAM_VOICE_ID,
    brainType: 'CUSTOMER_CLIENT_V1',  // bring-your-own-intelligence
    systemPrompt: ''
  }
});
await anamClient.streamToVideoElement('avatar-video');
```

### Message flow (chrome.runtime)
```
sidepanel.js  →  USER_SPEECH      →  service-worker.js  →  Claude API
             ←  CLAUDE_RESPONSE   ←                     ←
             →  LOVABLE_RESPONSE  →  content-script.js  →  lovable.dev DOM
```

### Content script injection
React synthetic events bypass: uses `Object.getOwnPropertyDescriptor` + native setters + `new Event('input', { bubbles: true })`. Falls back to `document.execCommand('insertText')` for contenteditable fields.

### Claude prompt format
Service worker sends speech to Claude with system prompt: "You are a Lovable.dev prompt engineer." Claude returns either:
- `[PROMPT]: <reformulated prompt>` — inject into Lovable
- `[CLARIFY]: <question>` — ask the user to clarify

## Known Issues

1. **DOM selectors are fragile** — if Lovable updates their UI, update the `SELECTORS` object in `content/content-script.js`. Inspect lovable.dev in DevTools to find current selectors.
2. **Anam SDK version** — bundled as `@anam-ai/js-sdk@4.11.0`. If Anam releases breaking changes, re-download: `npm pack @anam-ai/js-sdk`, extract `dist/umd/anam.js`, replace `sidepanel/anam-sdk.js`
3. **No persistent debug log** — errors only appear in the side panel DevTools console. Consider adding a collapsible debug panel for easier debugging.

## Validated Configuration

- **Avatar**: Cara, desk variant (ID: `30fa96d0-26c4-4e55-94a0-517025942e18`)
- **Voice**: Lauren — Empathetic and Encouraging, US female (ID: `d79f2051-3a89-4fcc-8c71-cf5d53f9d9e0`)
- **Model**: `claude-sonnet-4-6`
- All API keys validated via HTTP 200 responses as of 2026-03-17

## Common Tasks

### Update Anam SDK
```bash
npm pack @anam-ai/js-sdk
tar -xzf anam-ai-js-sdk-*.tgz package/dist/umd/anam.js
cp package/dist/umd/anam.js sidepanel/anam-sdk.js
```

### Reload extension after changes
Go to `chrome://extensions` → click reload icon on "Lovable Voice Builder"

### Fix broken DOM injection
1. Open lovable.dev in Chrome → DevTools → Elements
2. Click into chat input → note tag + attributes
3. Update `SELECTORS.input` array in `content/content-script.js`
4. Same for send button (`SELECTORS.sendButton`) and chat container (`SELECTORS.chatContainer`)

### Add a new Claude behavior
Edit the system prompt in `background/service-worker.js` → `SYSTEM_PROMPT` constant. The prompt format (`[PROMPT]:` / `[CLARIFY]:`) is parsed by the content script — don't change the prefix format without updating both files.

### After every major build
Update `MEMORY.md` with: what was built, key decisions, known issues, next steps.
