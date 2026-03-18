// Lovable Voice Builder — Background Service Worker
// Responsibilities:
//  - Open side panel when extension icon is clicked
//  - Route messages between side panel and content script
//  - Call Claude API to reformulate user speech into Lovable prompts
//  - Maintain conversation history

importScripts('../config.js');

// ─── Constants ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Lovable.dev prompt engineer. Your job is to take casual spoken
instructions from a user and reformulate them into clear, specific prompts optimized for
Lovable's AI builder.

Rules:
1. Convert casual speech into structured, specific Lovable prompts
2. If the user says something vague like "make it look nicer", ask a clarifying question
   instead of guessing. Return your clarifying question prefixed with [CLARIFY]:
3. If the user gives clear instructions, return ONLY the Lovable prompt prefixed with [PROMPT]:
4. Keep prompts concise but specific — Lovable works best with focused, single-task prompts
5. Include technology preferences when relevant (React, Tailwind, shadcn/ui, Supabase)
6. If the user is responding to a Lovable message (e.g., answering a question Lovable asked),
   formulate the response as a direct answer
7. Never include markdown formatting in the prompt — Lovable's input is plain text
8. When the user describes a new app from scratch, structure the prompt with:
   what the app does, key features, visual style preferences
9. For iterative changes, be specific about what component/section to modify

You receive the full conversation history including what Lovable has said back. Use this
context to understand where the user is in their build process.

Output ONLY the prefixed prompt or clarification. No preamble, no explanation.`;

// ─── State ────────────────────────────────────────────────────────────────────

// conversationHistory stores the full exchange: user speech, Claude responses, and Lovable responses
// [{ from: 'user'|'claude'|'lovable', text: string }]
let conversationHistory = [];

// Track the active Lovable tab ID so we can send messages to the right content script
let lovableTabId = null;

// Rate limiting — prevent rapid-fire Claude API calls
let lastApiCallTime = 0;
let pendingSpeech = null;
let rateLimitTimer = null;
const API_COOLDOWN_MS = 2000; // Minimum 2s between API calls

// ─── Persistence ──────────────────────────────────────────────────────────────

// Restore conversation history from session storage on startup
chrome.storage.session.get('conversationHistory', (result) => {
  if (result.conversationHistory) {
    conversationHistory = result.conversationHistory;
    console.log('[LVB SW] Restored', conversationHistory.length, 'history entries from session storage');
  }
});

function persistHistory() {
  chrome.storage.session.set({ conversationHistory });
}

// ─── Side Panel Setup ─────────────────────────────────────────────────────────

// Open side panel when the extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ─── Claude API ───────────────────────────────────────────────────────────────

async function reformulateWithClaude(userSpeech) {
  // Mock mode — return canned responses without calling Claude API
  if (CONFIG.MOCK_MODE) {
    console.log('[LVB SW] MOCK MODE — skipping Claude API');
    const lower = userSpeech.toLowerCase();
    if (lower.includes('?') || lower.includes('what') || lower.includes('how') || lower.includes('which')) {
      return '[CLARIFY]: Could you be more specific about what you\'d like to build? For example, what features should it have and what style are you going for?';
    }
    return `[PROMPT]: Create a React component that ${userSpeech}. Use Tailwind CSS for styling and shadcn/ui components. Make it responsive and visually polished.`;
  }

  // Build messages array from conversation history
  // Mapping: user speech → role: 'user', claude output → role: 'assistant',
  //          lovable responses → role: 'user' with prefix (so Claude sees them as context, not its own output)
  // Claude API requires alternating user/assistant roles, so we merge consecutive same-role messages.
  const rawMessages = conversationHistory.map(entry => {
    if (entry.from === 'user') {
      return { role: 'user', content: entry.text };
    } else if (entry.from === 'claude') {
      return { role: 'assistant', content: entry.text };
    } else {
      return { role: 'user', content: `[Lovable responded]: ${entry.text}` };
    }
  });
  rawMessages.push({ role: 'user', content: userSpeech });

  // Merge consecutive messages with the same role (API requires alternation)
  const messages = [];
  for (const msg of rawMessages) {
    if (messages.length > 0 && messages[messages.length - 1].role === msg.role) {
      messages[messages.length - 1].content += '\n' + msg.content;
    } else {
      messages.push({ ...msg });
    }
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: CONFIG.ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: messages
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

// ─── Message History Management ───────────────────────────────────────────────

function addToHistory(from, text) {
  conversationHistory.push({ from, text });
  // Trim to max window
  if (conversationHistory.length > CONFIG.MAX_CONVERSATION_HISTORY) {
    conversationHistory = conversationHistory.slice(
      conversationHistory.length - CONFIG.MAX_CONVERSATION_HISTORY
    );
  }
  persistHistory();
}

// ─── Message Routing ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Track which tab has Lovable open (content script sends from lovable.dev)
  if (sender.tab && sender.tab.url && sender.tab.url.includes('lovable.dev')) {
    lovableTabId = sender.tab.id;
  }

  switch (message.type) {

    // ── User spoke → reformulate with Claude ──────────────────────────────────
    case 'USER_SPEECH': {
      const userText = message.text;

      // Rate limiting — prevent rapid-fire API calls
      const now = Date.now();
      const elapsed = now - lastApiCallTime;

      if (elapsed < API_COOLDOWN_MS) {
        // Queue this speech; discard any previously queued speech
        clearTimeout(rateLimitTimer);
        pendingSpeech = userText;
        rateLimitTimer = setTimeout(() => {
          const queued = pendingSpeech;
          pendingSpeech = null;
          if (queued) processUserSpeech(queued);
        }, API_COOLDOWN_MS - elapsed);
        console.log('[LVB SW] Rate limited — queued speech, will process in', API_COOLDOWN_MS - elapsed, 'ms');
        sendResponse({ received: true, queued: true });
        return true;
      }

      processUserSpeech(userText);
      sendResponse({ received: true });
      return true; // Keep channel open for async
    }

    // ── Lovable posted a new response → forward to side panel ─────────────────
    case 'LOVABLE_RESPONSE': {
      addToHistory('lovable', message.text);
      broadcastToSidePanel({ type: 'SPEAK_RESPONSE', text: message.text });
      sendResponse({ received: true });
      return true;
    }

    // ── Status update from content script ─────────────────────────────────────
    case 'LOVABLE_STATUS': {
      broadcastToSidePanel({ type: 'LOVABLE_STATUS', status: message.status });
      sendResponse({ received: true });
      return true;
    }

    // ── Injection error from content script ───────────────────────────────────
    case 'INJECTION_ERROR': {
      broadcastToSidePanel({
        type: 'CLARIFICATION',
        text: `Injection failed: ${message.error}. Make sure you have a Lovable project open.`
      });
      sendResponse({ received: true });
      return true;
    }

    // ── Reset conversation ─────────────────────────────────────────────────────
    case 'RESET_CONVERSATION': {
      conversationHistory = [];
      persistHistory();
      sendResponse({ received: true });
      return true;
    }
  }
});

// ─── Process Speech ──────────────────────────────────────────────────────────

function processUserSpeech(userText) {
  lastApiCallTime = Date.now();
  addToHistory('user', userText);

  reformulateWithClaude(userText)
    .then(claudeResponse => {
      // Store Claude's response in history for proper multi-turn context
      addToHistory('claude', claudeResponse);

      if (claudeResponse.startsWith('[CLARIFY]:')) {
        const question = claudeResponse.replace('[CLARIFY]:', '').trim();
        broadcastToSidePanel({ type: 'CLARIFICATION', text: question });
      } else {
        const prompt = claudeResponse.startsWith('[PROMPT]:')
          ? claudeResponse.replace('[PROMPT]:', '').trim()
          : claudeResponse.trim();

        broadcastToSidePanel({ type: 'PROMPT_SENT', prompt });
        sendToLovableTab({ type: 'INJECT_PROMPT', prompt });
      }
    })
    .catch(err => {
      console.error('[LVB SW] Claude API error:', err);
      broadcastToSidePanel({
        type: 'CLARIFICATION',
        text: "Sorry, I couldn't connect to Claude. Please check your API key in config.js."
      });
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Send a message to all extension pages (side panel listens here)
function broadcastToSidePanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Side panel may not be open — ignore
  });
}

// Send a message to the content script running on Lovable
function sendToLovableTab(message) {
  if (lovableTabId !== null) {
    chrome.tabs.sendMessage(lovableTabId, message).catch(err => {
      console.error('[LVB SW] Could not reach content script:', err);
      broadcastToSidePanel({
        type: 'CLARIFICATION',
        text: "Couldn't reach Lovable. Is a Lovable project open in this tab?"
      });
    });
    return;
  }

  // Fallback: query for the active lovable.dev tab
  chrome.tabs.query({ url: ['https://lovable.dev/*', 'https://*.lovable.dev/*'] }, (tabs) => {
    if (tabs.length === 0) {
      broadcastToSidePanel({
        type: 'CLARIFICATION',
        text: "No Lovable tab found. Please open lovable.dev first."
      });
      return;
    }
    lovableTabId = tabs[0].id;
    chrome.tabs.sendMessage(lovableTabId, message).catch(err => {
      console.error('[LVB SW] Could not reach content script (fallback):', err);
    });
  });
}
