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

// conversationHistory stores the full exchange: user speech + Lovable responses
// [{ from: 'user'|'lovable', text: string }]
let conversationHistory = [];

// Track the active Lovable tab ID so we can send messages to the right content script
let lovableTabId = null;

// ─── Side Panel Setup ─────────────────────────────────────────────────────────

// Open side panel when the extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ─── Claude API ───────────────────────────────────────────────────────────────

async function reformulateWithClaude(userSpeech) {
  // Build messages array from conversation history
  const messages = [
    ...conversationHistory.map(entry => ({
      role: entry.from === 'user' ? 'user' : 'assistant',
      content: entry.from === 'lovable'
        ? `[Lovable responded]: ${entry.text}`
        : entry.text
    })),
    { role: 'user', content: userSpeech }
  ];

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
      addToHistory('user', userText);

      reformulateWithClaude(userText)
        .then(claudeResponse => {
          if (claudeResponse.startsWith('[CLARIFY]:')) {
            const question = claudeResponse.replace('[CLARIFY]:', '').trim();
            // Send clarification back to side panel → avatar speaks it
            broadcastToSidePanel({ type: 'CLARIFICATION', text: question });
          } else {
            // Extract prompt (strip [PROMPT]: prefix if present)
            const prompt = claudeResponse.startsWith('[PROMPT]:')
              ? claudeResponse.replace('[PROMPT]:', '').trim()
              : claudeResponse.trim();

            // Notify side panel of what was sent
            broadcastToSidePanel({ type: 'PROMPT_SENT', prompt });

            // Send prompt to content script for injection into Lovable
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
      sendResponse({ received: true });
      return true;
    }
  }
});

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
