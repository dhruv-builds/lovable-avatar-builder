// Facetime Lovable Builder — Background Service Worker
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
2. Bias toward action — if you can build something reasonable from what the user said,
   generate a [PROMPT]: immediately with sensible defaults for anything unspecified.
   Do NOT ask about visual style, tech stack, or minor details unless the user raised them.
3. If the request is genuinely ambiguous (could mean very different things), ask ONE
   short clarifying question prefixed with [CLARIFY]:. Never bundle multiple questions.
4. You may ask at most 2 clarifying questions total for any single build request.
   After 2 clarifications, generate the best [PROMPT]: you can with available info.
5. Keep prompts concise but specific — Lovable works best with focused, single-task prompts
6. Include technology preferences when relevant (React, Tailwind, shadcn/ui, Supabase)
7. If the user is responding to a Lovable message, formulate the response as a direct answer
8. Never include markdown formatting — plain text only
9. For iterative changes, be specific about what component/section to modify
10. If the user wants to stop or cancel the current Lovable build (e.g. "stop", "cancel that",
    "never mind", "hold on"), respond ONLY with: [STOP]: <brief description of what was cancelled>

You receive the full conversation history including what Lovable has said back. Use this
context to understand where the user is in their build process.

Output ONLY the prefixed prompt or clarification. No preamble, no explanation.`;

const SUMMARIZE_PROMPT = `You clean up raw text captured from the Lovable.dev UI. The text may contain:
- Echoed user prompts that were injected into Lovable
- UI artifacts like "Ask Lovable...", "Add files", "Drop any files here", timestamps, metadata
- Duplicate or streaming fragments
- Navigation labels and button text

You also receive the last prompt that was sent to Lovable, so you can identify and remove echoes of it.

Your job:
1. Identify what Lovable actually said or did (ignore everything else)
2. Summarize it in 1-2 short conversational sentences suitable for text-to-speech
3. If a build failure is mentioned, clearly state that the build failed and what went wrong
4. If there is no meaningful Lovable response in the text, output only: [EMPTY]

Output ONLY the clean summary. No quotes, no preamble.`;

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

// Build state — track whether Lovable is actively building
let lovableBuildState = 'idle'; // 'idle' | 'building'
let lovableBuildDetail = '';

// Auto-retry guard — at most one automatic retry per user prompt cycle
let autoRetryUsed = false;

// ─── Persistence ──────────────────────────────────────────────────────────────

// Restore conversation history from session storage on startup
chrome.storage.session.get('conversationHistory', (result) => {
  if (result.conversationHistory) {
    conversationHistory = result.conversationHistory;
    console.log('[FLB SW] Restored', conversationHistory.length, 'history entries from session storage');
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
    console.log('[FLB SW] MOCK MODE — skipping Claude API');
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
      max_tokens: 300,
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

// ─── Claude Response Summarizer ──────────────────────────────────────────────

async function summarizeWithClaude(rawText, lastPrompt) {
  // Mock mode — pass through truncated text
  if (CONFIG.MOCK_MODE) {
    console.log('[FLB SW] MOCK MODE — skipping summarize');
    return rawText.length > 200 ? rawText.substring(0, 200) + '…' : rawText;
  }

  const userMessage = lastPrompt
    ? `Last prompt sent to Lovable:\n${lastPrompt}\n\nRaw captured text:\n${rawText}`
    : `Raw captured text:\n${rawText}`;

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
      max_tokens: 150,
      system: SUMMARIZE_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude summarize error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const summary = data.content[0].text.trim();

  if (summary === '[EMPTY]') return null;
  return summary;
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

      // Allow stop commands even while building
      const isStopCommand = /^(stop|cancel|halt|abort|stop it|stop building|cancel that|stop lovable|pause)$/i.test(userText.trim());

      // Block new prompts while Lovable is building (but not stop commands)
      if (lovableBuildState === 'building' && !isStopCommand) {
        console.log('[FLB SW] Blocked prompt — Lovable is building:', lovableBuildDetail);
        broadcastToSidePanel({
          type: 'CLARIFICATION',
          text: `Lovable is still building${lovableBuildDetail ? ' (' + lovableBuildDetail + ')' : ''}. I'll let you know when it's done, then you can give your next instruction.`
        });
        sendResponse({ received: true, blocked: true });
        return true;
      }

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
        console.log('[FLB SW] Rate limited — queued speech, will process in', API_COOLDOWN_MS - elapsed, 'ms');
        sendResponse({ received: true, queued: true });
        return true;
      }

      processUserSpeech(userText);
      sendResponse({ received: true });
      return true; // Keep channel open for async
    }

    // ── Lovable posted a new response → summarize then forward to side panel ──
    case 'LOVABLE_RESPONSE': {
      addToHistory('lovable', message.text);

      // Find the last prompt we sent for echo context
      const lastPrompt = conversationHistory.slice().reverse()
        .find(e => e.from === 'claude' && e.text.includes('[PROMPT]:'));
      const promptCtx = lastPrompt
        ? lastPrompt.text.replace('[PROMPT]:', '').trim()
        : '';

      summarizeWithClaude(message.text, promptCtx)
        .then(summary => {
          if (summary) {
            console.log('[FLB SW] Summarized response:', summary);
            broadcastToSidePanel({ type: 'SPEAK_RESPONSE', text: summary });
          }
        })
        .catch(err => {
          console.error('[FLB SW] Summarize failed, using raw text:', err.message);
          broadcastToSidePanel({ type: 'SPEAK_RESPONSE', text: message.text });
        });

      sendResponse({ received: true });
      return true;
    }

    // ── Status update from content script ─────────────────────────────────────
    case 'LOVABLE_STATUS': {
      const prevState = lovableBuildState;
      lovableBuildState = message.status;
      lovableBuildDetail = message.detail || '';

      console.log('[FLB SW] Build state:', prevState, '→', message.status, lovableBuildDetail);

      // Notify sidepanel of state change
      broadcastToSidePanel({
        type: 'LOVABLE_STATUS',
        status: message.status,
        detail: message.detail || ''
      });

      // If build just finished, send a ready notification
      if (prevState === 'building' && message.status === 'idle') {
        broadcastToSidePanel({
          type: 'CLARIFICATION',
          text: 'Lovable finished building. Ready for your next instruction.'
        });
      }

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

    // ── Build failure — auto-retry once ────────────────────────────────────────
    case 'BUILD_FAILED': {
      console.log('[FLB SW] Build failed:', message.error);

      if (autoRetryUsed) {
        // Already retried once — just report to user
        broadcastToSidePanel({
          type: 'SPEAK_RESPONSE',
          text: "The build failed again. You may want to describe the issue or try a different approach."
        });
        sendResponse({ received: true });
        return true;
      }

      autoRetryUsed = true;

      // Tell the user what's happening
      broadcastToSidePanel({
        type: 'SPEAK_RESPONSE',
        text: "The build ran into an issue. I'm asking Lovable to diagnose and fix it."
      });

      // Inject a fix-it prompt
      const fixPrompt = `The previous build failed with this error: ${message.error}. Please diagnose the error and fix it so the build succeeds.`;
      broadcastToSidePanel({ type: 'PROMPT_SENT', prompt: fixPrompt });
      sendToLovableTab({ type: 'INJECT_PROMPT', prompt: fixPrompt });
      addToHistory('claude', `[PROMPT]: ${fixPrompt}`);

      sendResponse({ received: true });
      return true;
    }

    // ── Stop result from content script ────────────────────────────────────────
    case 'STOP_RESULT': {
      const feedback = message.success
        ? 'Lovable has been stopped.'
        : "I tried to stop Lovable but couldn't find the stop button. It may have already finished.";
      broadcastToSidePanel({ type: 'SPEAK_RESPONSE', text: feedback });
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
  autoRetryUsed = false; // Reset retry guard on each new user prompt

  // Fast-path: detect stop intent via keywords before calling Claude
  const stopPattern = /^(stop|cancel|halt|abort|stop it|stop building|cancel that|stop lovable|pause)$/i;
  if (stopPattern.test(userText.trim())) {
    addToHistory('user', userText);
    addToHistory('claude', '[STOP]: User requested stop');
    broadcastToSidePanel({ type: 'SPEAK_RESPONSE', text: 'Stopping Lovable now.' });
    sendToLovableTab({ type: 'CLICK_STOP' });
    return;
  }

  addToHistory('user', userText);

  reformulateWithClaude(userText)
    .then(claudeResponse => {
      // Store Claude's response in history for proper multi-turn context
      addToHistory('claude', claudeResponse);

      if (claudeResponse.startsWith('[STOP]:')) {
        broadcastToSidePanel({ type: 'SPEAK_RESPONSE', text: 'Stopping Lovable now.' });
        sendToLovableTab({ type: 'CLICK_STOP' });
      } else if (claudeResponse.startsWith('[CLARIFY]:')) {
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
      console.error('[FLB SW] Claude API error:', err);
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
  console.log('[FLB SW] sendToLovableTab called. lovableTabId:', lovableTabId, 'message type:', message.type);

  if (lovableTabId !== null) {
    console.log('[FLB SW] Using cached tab ID:', lovableTabId);
    chrome.tabs.sendMessage(lovableTabId, message)
      .then(() => console.log('[FLB SW] Message delivered to tab', lovableTabId))
      .catch(err => {
        console.error('[FLB SW] Could not reach content script on cached tab:', lovableTabId, err.message);
        // Cached tab may be stale — clear it and retry via query
        lovableTabId = null;
        console.log('[FLB SW] Clearing stale tab ID, retrying via query…');
        sendToLovableTab(message);
      });
    return;
  }

  // Fallback: query for the active lovable.dev tab
  console.log('[FLB SW] No cached tab ID — querying for Lovable tabs…');
  chrome.tabs.query({ url: ['https://lovable.dev/*', 'https://*.lovable.dev/*'] }, (tabs) => {
    console.log('[FLB SW] Tab query returned', tabs.length, 'tabs:', tabs.map(t => `${t.id}:${t.url}${t.active ? ' (ACTIVE)' : ''}`).join(', '));
    if (tabs.length === 0) {
      broadcastToSidePanel({
        type: 'CLARIFICATION',
        text: "No Lovable tab found. Please open lovable.dev first."
      });
      return;
    }

    // Pick the best tab: prefer the active one, then dashboard, then any project
    const activeTab = tabs.find(t => t.active);
    const dashboardTab = tabs.find(t => t.url.includes('/dashboard'));
    const projectTab = tabs.find(t => t.url.includes('/projects/'));
    const bestTab = activeTab || dashboardTab || projectTab || tabs[0];
    console.log('[FLB SW] Selected tab:', bestTab.id, bestTab.url);

    lovableTabId = bestTab.id;

    // Try to send; if it fails, try each remaining tab
    tryTabsInOrder([bestTab, ...tabs.filter(t => t.id !== bestTab.id)], message);
  });
}

// Try sending a message to tabs one at a time until one succeeds
function tryTabsInOrder(tabs, message) {
  if (tabs.length === 0) {
    broadcastToSidePanel({
      type: 'INJECTION_ERROR',
      error: 'Could not reach content script on any Lovable tab. Try reloading the Lovable page.'
    });
    return;
  }

  const tab = tabs[0];
  chrome.tabs.sendMessage(tab.id, message)
    .then(() => {
      console.log('[FLB SW] Message delivered to tab', tab.id, tab.url);
      lovableTabId = tab.id; // Cache the working tab
    })
    .catch(err => {
      console.warn('[FLB SW] Tab', tab.id, 'unreachable:', err.message, '— trying next…');
      tryTabsInOrder(tabs.slice(1), message);
    });
}
