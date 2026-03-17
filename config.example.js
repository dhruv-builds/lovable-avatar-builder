// CONFIGURATION TEMPLATE — Copy this file to config.js and fill in your values
// Run: cp config.example.js config.js
// Or use: ./generate-config.sh (reads from .env automatically)
//
// WARNING: config.js is gitignored. Never commit your real keys.

const CONFIG = {
  // Anam.ai — Get from https://lab.anam.ai/
  ANAM_API_KEY: 'YOUR_ANAM_API_KEY',
  ANAM_AVATAR_ID: 'YOUR_ANAM_AVATAR_ID',   // e.g. '30fa96d0-26c4-4e55-94a0-517025942e18'
  ANAM_VOICE_ID: 'YOUR_ANAM_VOICE_ID',     // e.g. 'd79f2051-3a89-4fcc-8c71-cf5d53f9d9e0'

  // Anthropic — Get from https://console.anthropic.com/
  ANTHROPIC_API_KEY: 'YOUR_ANTHROPIC_API_KEY',
  ANTHROPIC_MODEL: 'claude-sonnet-4-6',

  // Behavior — adjust as needed
  DEBOUNCE_MS: 1500,           // How long to wait after Lovable stops updating
  MAX_SPEECH_LENGTH: 500,       // Max chars to send to avatar for narration
  MAX_CONVERSATION_HISTORY: 20  // Max messages to keep in context for Claude
};
