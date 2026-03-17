# Lovable Voice Builder

A Chrome extension that lets you build apps on [Lovable.dev](https://lovable.dev) using your voice. Speak a casual instruction to an AI avatar — it reformulates it into an optimized Lovable prompt via Claude, injects it into the chat, and narrates Lovable's response back to you.

---

## How It Works

```
You speak
    ↓
Anam.ai avatar (side panel) captures speech
    ↓
Background service worker sends to Claude API
    ↓
Claude reformulates speech → structured Lovable prompt
    ↓
Content script injects prompt into lovable.dev chat + hits send
    ↓
MutationObserver captures Lovable's response
    ↓
Avatar narrates the response back to you
```

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Google Chrome | v114+ (Manifest V3 support) |
| [Anam.ai account](https://lab.anam.ai/) | Free tier available — get API key + avatar/voice IDs |
| [Anthropic account](https://console.anthropic.com/) | Claude API key |
| A [Lovable.dev](https://lovable.dev) project | Must be open in Chrome when using the extension |

---

## Setup

### Option A — Edit config directly (simplest)

```bash
cp config.example.js config.js
```

Open `config.js` and fill in your values:

```javascript
const CONFIG = {
  ANAM_API_KEY: 'your-anam-api-key',
  ANAM_AVATAR_ID: 'your-avatar-id',    // from lab.anam.ai → Avatars
  ANAM_VOICE_ID: 'your-voice-id',      // from lab.anam.ai → Voices
  ANTHROPIC_API_KEY: 'your-anthropic-key',
  // ... leave the rest as-is
};
```

### Option B — Use .env (recommended for developers)

```bash
cp .env.example .env
# Edit .env with your values, then:
chmod +x generate-config.sh
./generate-config.sh    # generates config.js from .env
```

> `config.js` and `.env` are both gitignored — your keys will never be committed.

---

## Getting Your API Keys

### Anam.ai
1. Sign up at [lab.anam.ai](https://lab.anam.ai/)
2. Go to **API Keys** → copy your key
3. Go to **Avatars** → pick one → copy its ID
4. Go to **Voices** → pick one → copy its ID

To list all available voices via API:
```bash
curl https://api.anam.ai/v1/voices -H "Authorization: Bearer YOUR_ANAM_API_KEY"
```

### Anthropic
1. Sign up at [console.anthropic.com](https://console.anthropic.com/)
2. Go to **API Keys** → create a new key → copy it

---

## Install the Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer Mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the `lovable-voice-builder/` folder

The extension icon appears in your toolbar.

---

## Usage

1. Open a project on [lovable.dev](https://lovable.dev)
2. Click the **Lovable Voice Builder** icon in Chrome toolbar
3. The side panel opens with the avatar
4. Wait for the status to show **Listening**
5. Speak your instruction (e.g. "add a dark mode toggle to the settings page")
6. Claude reformulates it → prompt is injected into Lovable's chat → Lovable builds
7. The avatar narrates Lovable's response back to you

### Controls

| Button | Action |
|--------|--------|
| **Pause** | Stop listening (avatar stays connected) |
| **Resume** | Start listening again |
| **Reset** | Clear conversation history and restart |
| Text input + **Send** | Type manually if speech isn't working |

---

## File Structure

```
lovable-voice-builder/
├── manifest.json              # Chrome Extension MV3 config
├── config.js                  # YOUR local config (gitignored — never committed)
├── config.example.js          # Template — copy to config.js
├── .env.example               # .env template for generate-config.sh
├── generate-config.sh         # Generates config.js from .env
├── MEMORY.md                  # Project build history
├── background/
│   └── service-worker.js      # Message router + Claude API client
├── sidepanel/
│   ├── sidepanel.html         # Side panel UI
│   ├── sidepanel.css          # Dark theme styles
│   ├── sidepanel.js           # Anam SDK init + speech handling
│   └── anam-sdk.js            # Anam SDK bundled locally (MV3 requires no remote scripts)
├── content/
│   └── content-script.js      # DOM injection + response capture on lovable.dev
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Troubleshooting

### "Failed to connect avatar"
- Right-click the side panel → **Inspect** → check Console for errors
- Verify `ANAM_API_KEY` is correct in `config.js`
- Verify your Anam account has API access at [lab.anam.ai](https://lab.anam.ai/)

### Avatar loads but speech isn't injected into Lovable
Lovable's DOM may have changed. Inspect `lovable.dev` and update the selectors in `content/content-script.js`:

```javascript
const SELECTORS = {
  input: [...],        // textarea or contenteditable for chat input
  sendButton: [...],   // submit/send button
  chatContainer: [...]  // message list container
};
```

### Extension changes not taking effect
Go to `chrome://extensions` → click the **reload** icon on the extension after every code change.

### "No Lovable tab found"
Make sure a lovable.dev project tab is open in the same Chrome window before clicking the extension icon.

### Wrong voice for avatar
Change `ANAM_VOICE_ID` in `config.js`. List available voices:
```bash
curl https://api.anam.ai/v1/voices -H "Authorization: Bearer YOUR_ANAM_API_KEY"
```

### Claude API errors
Check the service worker console: `chrome://extensions` → click **"Service Worker"** link under the extension.

---

## Architecture Notes

- **Chrome MV3** — Remote scripts are blocked. The Anam SDK is bundled locally as `sidepanel/anam-sdk.js` (from npm `@anam-ai/js-sdk@4.11.0`, `dist/umd/anam.js`). The global is aliased: `var AnamAI = window.anam`
- **No build step** — Pure vanilla JS, loads directly in Chrome
- **Anam brainType** — `CUSTOMER_CLIENT_V1` (bring-your-own-intelligence). Claude handles reasoning; Anam handles avatar rendering, lip-sync, and TTS
- **React compatibility** — Content script uses native property setters + synthetic event dispatch to bypass React's synthetic event system when injecting text

---

## Security

`config.js` and `.env` are gitignored. **Never push either file to a public repository.**

For production or team use:
- Proxy Anthropic API calls through your own backend
- Generate Anam session tokens server-side and pass them to the extension

---

## Contributing

1. Fork the repo
2. Set up config: `cp config.example.js config.js` and fill in your keys
3. Load the extension in Chrome (Developer Mode → Load unpacked)
4. Make changes, reload extension at `chrome://extensions`, test on lovable.dev
5. Open a PR

---

## License

MIT
