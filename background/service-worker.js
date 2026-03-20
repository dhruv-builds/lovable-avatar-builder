// Facetime Lovable Builder — Background Service Worker
// Responsibilities:
//  - Open side panel when extension icon is clicked
//  - Route messages between side panel and content script
//  - Call Claude API to reformulate user speech into Lovable prompts
//  - Maintain conversation history

importScripts('../config.js');

// ─── Constants ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Lovable.dev prompt engineer and conversational building assistant. Your job is to
talk naturally with the user AND, when they give build instructions, reformulate them into clear,
specific prompts optimized for Lovable's AI builder.

Each user message includes a [BUILD_STATE] tag telling you whether Lovable is currently building or idle.

Rules:
1. You are a conversational assistant FIRST. Greet users warmly, answer their questions, discuss ideas,
   and be a helpful partner. Not every utterance is a build instruction.
2. Distinguish between CONVERSATION and BUILD INSTRUCTIONS.
   - If the user is greeting you, asking a general question, thinking out loud, making small talk,
     or saying something that is NOT a build/change instruction, respond with [CHAT]: and talk naturally.
   - If the user gives a clear build or change instruction, generate a [PROMPT]: with sensible defaults
     for anything unspecified. Do NOT ask about visual style, tech stack, or minor details unless
     the user raised them.
   - When in doubt whether the user wants to build something or just talk, prefer [CHAT]: over [PROMPT]:.
     You can always ask "Would you like me to build that?" at the end of a [CHAT]: response.
3. When generating [PROMPT]:, ALWAYS use the format: [PROMPT]: <spoken acknowledgment> ||| <Lovable prompt>
   The spoken acknowledgment tells the user what you are about to build (e.g. "Alright, I will create
   a todo app with a clean design for you."). The Lovable prompt after ||| is the optimized instruction
   for Lovable. The ||| separator is mandatory.
4. If the request is genuinely ambiguous (could mean very different things), ask ONE
   short clarifying question prefixed with [CLARIFY]:. Never bundle multiple questions.
5. You may ask at most 2 clarifying questions total for any single build request.
   After 2 clarifications, generate the best [PROMPT]: you can with available info.
6. Keep Lovable prompts concise but specific — Lovable works best with focused, single-task prompts
7. Include technology preferences when relevant (React, Tailwind, shadcn/ui, Supabase)
8. If the user is responding to a Lovable message, formulate the response as a direct answer
9. Never include markdown formatting — plain text only
10. For iterative changes, be specific about what component/section to modify
11. BREVITY IS MANDATORY. Keep ALL responses under 2 sentences maximum. No filler phrases,
    no lengthy pleasantries. Everything you say is spoken aloud by an avatar — long responses
    are painful to listen to.
12. NEVER regurgitate Lovable build details or technical status updates unless the user explicitly
    asks "what's happening" or "what did Lovable do". The system handles status updates separately.
    Focus your response on the conversational thread with the user.

MID-BUILD BEHAVIOR — When [BUILD_STATE] says Lovable is currently building:
Determine the user's intent and respond with the appropriate prefix:

CRITICAL RULE: If the user's new instruction contradicts, replaces, or changes the direction of
the current build, this is ALWAYS a [CORRECT]:, never a [QUEUE]:. Indicators: "actually", "wait",
"change", "instead", "no make it", "switch to", or any instruction that would make the current
build wrong or obsolete. When in doubt between [CORRECT] and [QUEUE], prefer [CORRECT].

A) DEFINITE COURSE CORRECTION — The user is clearly changing direction mid-build.
   → Respond with: [CORRECT]: <spoken preamble to user> ||| <full corrected Lovable prompt>
   The preamble should briefly explain what you are doing (e.g. "Got it, I am stopping the current
   build and updating the instructions to use a black and white color scheme.").
   The prompt after ||| should be the complete corrected instruction for Lovable, incorporating
   both the original intent and the correction.

B) TENTATIVE / EXPLORATORY — The user is thinking out loud or asking for your opinion.
   Indicators: "maybe", "what do you think", "would it be better", "I was thinking", questioning tone.
   → Respond with: [DISCUSS]: <your expert opinion, what Lovable is currently doing, and ask the user what they want to do>
   Be conversational. Give a real opinion based on your expertise. Mention what Lovable is working on.
   End by asking whether to stop and change course or keep the current build going.

C) NEW UNRELATED INSTRUCTION — The user wants something genuinely UNRELATED done after the current build finishes.
   This MUST be completely unrelated to the current build. If it modifies, overrides, or changes the
   current build in any way, use [CORRECT] instead.
   → Respond with: [QUEUE]: <spoken acknowledgment> ||| <reformulated Lovable prompt>
   The acknowledgment should confirm you will queue this for after the build finishes.

D) STOP — The user wants to halt with no replacement.
   → Respond with: [STOP]: <brief description of what was cancelled>

E) CONVERSATIONAL / NON-ACTIONABLE — The user is chatting, greeting, or asking a non-build question mid-build.
   → Respond with: [CHAT]: <natural conversational response>
   Do not stop or change the build. Just talk.

WHEN IDLE (not building):
Use the standard prefixes: [CHAT]:, [PROMPT]:, [CLARIFY]:, or [STOP]:.
Use [CHAT]: for all conversational, non-actionable responses (greetings, questions about you,
general discussion, thinking out loud). The user should feel like they are talking to a real assistant,
not a prompt machine.

CONFIRMATION HANDLING:
When the user says "yes", "do it", "go ahead", "sure", "let's do that" in response to a
[DISCUSS]: message, respond with: [CONFIRM]: <the action prompt to execute>
When the user says "no", "keep going", "never mind", "nah", respond with:
[DISMISS]: <brief spoken acknowledgment that you are keeping the current build going>

You receive the full conversation history including what Lovable has said back. Use this
context to understand where the user is in their build process.

Output ONLY the prefixed response. No preamble, no explanation outside the prefix.
Keep ALL spoken text natural and conversational — everything you say will be read aloud by an avatar.
For [CHAT]: responses, be warm but BRIEF — 1-2 sentences max. For [PROMPT]: preambles, ONE short sentence.`;

const SUMMARIZE_PROMPT = `You clean up raw text captured from the Lovable.dev UI. The text may contain:
- Echoed user prompts that were injected into Lovable
- UI artifacts like "Ask Lovable...", "Add files", "Drop any files here", timestamps, metadata
- Duplicate or streaming fragments
- Navigation labels and button text

You also receive the last prompt that was sent to Lovable, so you can identify and remove echoes of it.

Your job:
1. Identify what Lovable actually said or did (ignore everything else)
2. Summarize it in ONE short sentence suitable for text-to-speech
3. Always attribute work to Lovable — say "Lovable built..." or "Your page is ready..." — never "I created..." or "I built..."
4. If a build failure is mentioned, clearly state that the build failed and what went wrong
5. Strip ALL technical details: never mention specific technologies, frameworks, libraries, or tools (React, Tailwind, TypeScript, Supabase, shadcn/ui, CSS, HTML, etc.). Focus on WHAT was built, not HOW.
6. If the captured text is primarily an echo of the last prompt that was sent (the user's instruction repeated back), output only: [EMPTY]
7. If there is no meaningful Lovable response in the text, output only: [EMPTY]

Output ONLY the clean summary. No quotes, no preamble. ONE sentence maximum.`;

// ─── Timing Constants ────────────────────────────────────────────────────────
// All timing values in one place for easy tuning and debugging.
//
// Timing chain diagram:
//   User speaks → [API_COOLDOWN_MS gap] → Claude API call
//   Claude responds → [STOP_REINJECT_DELAY_MS] → inject corrected prompt (after stop)
//   Inject prompt → [ECHO_SUPPRESSION_MS] → observer re-enabled
//   Observer fires → [DEBOUNCE_MS in content script] → extract response
//   Content script auto-inject retry → [AUTO_INJECT_DELAY_MS] → retry after script injection

const API_COOLDOWN_MS = 2000;           // Min gap between Claude API calls
const MAX_API_CALLS_PER_MINUTE = 15;    // Hard cap on calls per 60s window
const STOP_REINJECT_DELAY_MS = 1500;    // Wait after stop before injecting corrected prompt
const AUTO_INJECT_DELAY_MS = 300;       // Wait after auto-injecting content script before retry
const BROADCAST_COALESCE_MS = 1200;     // Coalesce Lovable-originated speech within this window
const STOP_PATTERN = /^(stop|cancel|halt|abort|stop it|stop building|cancel that|stop lovable|pause)$/i;

// ─── State ────────────────────────────────────────────────────────────────────
// All mutable state consolidated into one object for traceability.

/**
 * @typedef {Object} AppState
 * @property {Array<{from: 'user'|'claude'|'lovable', text: string}>} conversationHistory - Full exchange history
 * @property {number|null} lovableTabId - Active Lovable tab ID for message routing
 * @property {number} lastApiCallTime - Timestamp of last Claude API call (rate limiting)
 * @property {string|null} pendingSpeech - Queued speech waiting for rate limit cooldown
 * @property {number|null} rateLimitTimer - Timer ID for rate-limited speech queue
 * @property {Array<number>} apiCallTimestamps - Timestamps for per-minute rate cap
 * @property {'idle'|'building'} lovableBuildState - Whether Lovable is actively building
 * @property {string} lovableBuildDetail - Human-readable build status detail
 * @property {boolean} autoRetryUsed - Guard: at most one auto-retry per user prompt cycle
 * @property {string} lastSentPrompt - Last prompt injected into Lovable (for echo detection)
 * @property {{type: 'correct'|'queue', prompt: string}|null} pendingAction - Queued action from [DISCUSS]/[QUEUE]
 * @property {boolean} awaitingConfirmation - Whether we're waiting for user to confirm/dismiss
 * @property {string|null} pendingLovableResponse - Deferred response held during build
 */
const state = {
  conversationHistory: [],
  lovableTabId: null,
  lastApiCallTime: 0,
  pendingSpeech: null,
  rateLimitTimer: null,
  apiCallTimestamps: [],
  lovableBuildState: 'idle',
  lovableBuildDetail: '',
  autoRetryUsed: false,
  lastSentPrompt: '',
  pendingAction: null,
  awaitingConfirmation: false,
  pendingLovableResponse: null,
  pendingBroadcast: null           // { type, text, timer } coalescing buffer for Lovable speech
};

/** Reset all transient state (preserves readyTabs which tracks tab lifecycle separately) */
function resetState() {
  state.conversationHistory = [];
  state.lastApiCallTime = 0;
  state.pendingSpeech = null;
  clearTimeout(state.rateLimitTimer);
  state.rateLimitTimer = null;
  state.apiCallTimestamps = [];
  state.lovableBuildState = 'idle';
  state.lovableBuildDetail = '';
  state.autoRetryUsed = false;
  state.lastSentPrompt = '';
  state.pendingAction = null;
  state.awaitingConfirmation = false;
  state.pendingLovableResponse = null;
  if (state.pendingBroadcast) clearTimeout(state.pendingBroadcast.timer);
  state.pendingBroadcast = null;
}

// Set of tab IDs that have confirmed their content script is loaded
const readyTabs = new Set();

// ─── Global Error Handling ───────────────────────────────────────────────────

self.addEventListener('unhandledrejection', (event) => {
  console.error('[FLB SW] Unhandled promise rejection:', event.reason);
  broadcastToSidePanel({
    type: 'CLARIFICATION',
    text: 'Something went wrong internally. If the issue persists, try resetting the conversation.'
  });
});

// ─── Persistence ──────────────────────────────────────────────────────────────

// Restore conversation history from session storage on startup
chrome.storage.session.get('conversationHistory', (result) => {
  if (result.conversationHistory) {
    state.conversationHistory = result.conversationHistory;
    console.log('[FLB SW] Restored', state.conversationHistory.length, 'history entries from session storage');
  }
});

function persistHistory() {
  chrome.storage.session.set({ conversationHistory: state.conversationHistory });
}

// ─── Tab Lifecycle ────────────────────────────────────────────────────────────

// Clean up stale tab references when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  readyTabs.delete(tabId);
  if (state.lovableTabId === tabId) state.lovableTabId = null;
});

// ─── Side Panel Setup ─────────────────────────────────────────────────────────

// Open side panel when the extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ─── Claude API ───────────────────────────────────────────────────────────────

/**
 * Check per-minute rate cap. Returns true if the call is allowed.
 * Trims timestamps older than 60s and enforces MAX_API_CALLS_PER_MINUTE.
 */
function checkRateCap() {
  const now = Date.now();
  state.apiCallTimestamps = state.apiCallTimestamps.filter(t => now - t < 60000);
  if (state.apiCallTimestamps.length >= MAX_API_CALLS_PER_MINUTE) {
    console.warn('[FLB SW] Per-minute rate cap hit (' + MAX_API_CALLS_PER_MINUTE + ' calls/min). Dropping request.');
    broadcastToSidePanel({
      type: 'CLARIFICATION',
      text: 'Slow down — too many requests. Wait a moment and try again.'
    });
    return false;
  }
  state.apiCallTimestamps.push(now);
  return true;
}

/**
 * Shared Claude API caller. Handles fetch, headers, error checking, and response extraction.
 * Required for Chrome extension direct browser API calls (no backend proxy).
 * Acceptable for personal-use only. For team/production use, route through a server.
 * @param {Object} opts
 * @param {string} opts.systemPrompt - System prompt for Claude
 * @param {Array} opts.messages - Messages array
 * @param {number} opts.maxTokens - Max tokens for response
 * @returns {Promise<string>} Claude's response text
 */
async function callClaudeAPI({ systemPrompt, messages, maxTokens }) {
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
      max_tokens: maxTokens,
      system: systemPrompt,
      messages
    })
  });

  if (!response.ok) {
    let errorDetail = '';
    try {
      const errBody = await response.json();
      errorDetail = errBody.error?.message || JSON.stringify(errBody);
    } catch { errorDetail = response.statusText; }
    console.error(`[FLB SW] Claude API error ${response.status}: ${errorDetail}`);
    throw new Error(`Claude API ${response.status}: ${errorDetail}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

async function reformulateWithClaude(userSpeech) {
  // Per-minute rate cap check
  if (!checkRateCap()) return '[CHAT]: Please wait a moment before sending another message.';

  // Mock mode — return canned responses without calling Claude API
  if (CONFIG.MOCK_MODE) {
    console.log('[FLB SW] MOCK MODE — skipping Claude API');
    const lower = userSpeech.toLowerCase();
    if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey') ||
        lower.includes('can you hear') || lower.includes('who are you') ||
        lower.includes('how are you') || lower.includes('thanks') || lower.includes('thank you')) {
      return '[CHAT]: Hey there! I can hear you perfectly. I\'m your building assistant — tell me what you\'d like to create and I\'ll get Lovable working on it for you.';
    }
    if (lower.includes('?') || lower.includes('what') || lower.includes('how') || lower.includes('which')) {
      return '[CLARIFY]: Could you be more specific about what you\'d like to build? For example, what features should it have and what style are you going for?';
    }
    return `[PROMPT]: Got it, I'll build that for you now. ||| Create a React component that ${userSpeech}. Use Tailwind CSS for styling and shadcn/ui components. Make it responsive and visually polished.`;
  }

  // Build messages array from conversation history
  const rawMessages = state.conversationHistory.map(entry => {
    if (entry.from === 'user') {
      return { role: 'user', content: entry.text };
    } else if (entry.from === 'claude') {
      return { role: 'assistant', content: entry.text };
    } else {
      return { role: 'user', content: `[Lovable responded]: ${entry.text}` };
    }
  });

  const buildContext = state.lovableBuildState === 'building'
    ? `[BUILD_STATE: Lovable is currently building.${state.lastSentPrompt ? ` Last prompt sent: "${state.lastSentPrompt}"` : ''}${state.lovableBuildDetail ? ` Status: ${state.lovableBuildDetail}` : ''}]`
    : '[BUILD_STATE: Lovable is idle and ready for a new prompt.]';

  rawMessages.push({ role: 'user', content: `${buildContext}\n\n${userSpeech}` });

  // Merge consecutive messages with the same role (API requires alternation)
  const messages = [];
  for (const msg of rawMessages) {
    if (messages.length > 0 && messages[messages.length - 1].role === msg.role) {
      messages[messages.length - 1].content += '\n' + msg.content;
    } else {
      messages.push({ ...msg });
    }
  }

  return callClaudeAPI({ systemPrompt: SYSTEM_PROMPT, messages, maxTokens: 700 });
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

  const text = await callClaudeAPI({
    systemPrompt: SUMMARIZE_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 80
  });

  const summary = text.trim();
  if (summary === '[EMPTY]') return null;
  return summary;
}

// ─── Summarize & Speak Helper ─────────────────────────────────────────────────

function summarizeAndSpeak(rawText) {
  const lastPrompt = state.conversationHistory.findLast(
    e => e.from === 'claude' && e.text.includes('[PROMPT]:')
  );
  const promptCtx = lastPrompt
    ? lastPrompt.text.replace('[PROMPT]:', '').trim()
    : '';

  summarizeWithClaude(rawText, promptCtx)
    .then(summary => {
      if (summary) {
        console.log('[FLB SW] Summarized response:', summary);
        coalescedBroadcast('SPEAK_RESPONSE', summary);
      }
    })
    .catch(err => {
      console.error('[FLB SW] Summarize failed, using raw text:', err.message);
      coalescedBroadcast('SPEAK_RESPONSE', rawText);
    });
}

// ─── Message History Management ───────────────────────────────────────────────

function addToHistory(from, text) {
  state.conversationHistory.push({ from, text });
  // Trim to max window
  if (state.conversationHistory.length > CONFIG.MAX_CONVERSATION_HISTORY) {
    state.conversationHistory = state.conversationHistory.slice(
      state.conversationHistory.length - CONFIG.MAX_CONVERSATION_HISTORY
    );
  }
  persistHistory();
}

// ─── Message Routing ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Track which tab has Lovable open (content script sends from lovable.dev)
  if (sender.tab && sender.tab.url && sender.tab.url.includes('lovable.dev')) {
    state.lovableTabId = sender.tab.id;
  }

  // Track content script ready signals
  if (message.type === 'CONTENT_SCRIPT_READY' && sender.tab) {
    readyTabs.add(sender.tab.id);
    state.lovableTabId = sender.tab.id;
    console.log('[FLB SW] Content script ready on tab', sender.tab.id, sender.tab.url);
    sendResponse({ received: true });
    return true;
  }

  switch (message.type) {

    // ── User spoke → reformulate with Claude ──────────────────────────────────
    case 'USER_SPEECH': {
      const userText = message.text;

      // Rate limiting — prevent rapid-fire API calls
      const now = Date.now();
      const elapsed = now - state.lastApiCallTime;

      if (elapsed < API_COOLDOWN_MS) {
        // Queue this speech; discard any previously queued speech
        clearTimeout(state.rateLimitTimer);
        state.pendingSpeech = userText;
        state.rateLimitTimer = setTimeout(() => {
          const queued = state.pendingSpeech;
          state.pendingSpeech = null;
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

    // ── Lovable posted a new response → show raw, then summarize for avatar ──
    case 'LOVABLE_RESPONSE': {
      addToHistory('lovable', message.text);

      // Show raw Lovable response in side panel immediately (blue bubble)
      broadcastToSidePanel({ type: 'LOVABLE_RAW_RESPONSE', text: message.text });

      // Echo detection: if response is primarily our own prompt echoed back, skip speech
      if (state.lastSentPrompt && state.lastSentPrompt.length > 20) {
        const responseNorm = message.text.toLowerCase().replace(/\s+/g, ' ').trim();
        const promptNorm = state.lastSentPrompt.toLowerCase().replace(/\s+/g, ' ').trim();
        if (responseNorm.startsWith(promptNorm.substring(0, 80)) ||
            promptNorm.startsWith(responseNorm.substring(0, 80))) {
          console.log('[FLB SW] Skipping echo of sent prompt');
          sendResponse({ received: true });
          return true;
        }
      }

      // If still building, defer speech until build completes
      if (state.lovableBuildState === 'building') {
        console.log('[FLB SW] Build in progress — deferring speech');
        state.pendingLovableResponse = message.text; // keep only latest
        sendResponse({ received: true });
        return true;
      }

      // Build is idle — summarize and speak immediately
      summarizeAndSpeak(message.text);
      sendResponse({ received: true });
      return true;
    }

    // ── Status update from content script ─────────────────────────────────────
    case 'LOVABLE_STATUS': {
      const prevState = state.lovableBuildState;
      state.lovableBuildState = message.status;
      state.lovableBuildDetail = message.detail || '';

      console.log('[FLB SW] Build state:', prevState, '→', message.status, state.lovableBuildDetail);

      // Notify sidepanel of state change
      broadcastToSidePanel({
        type: 'LOVABLE_STATUS',
        status: message.status,
        detail: message.detail || ''
      });

      // If build just finished, check for queued prompts, deferred responses, or send ready notification
      if (prevState === 'building' && message.status === 'idle') {
        if (state.pendingAction && state.pendingAction.type === 'queue') {
          // Auto-inject the queued prompt
          const queuedPrompt = state.pendingAction.prompt;
          state.pendingAction = null;
          state.awaitingConfirmation = false;
          console.log('[FLB SW] Build finished — injecting queued prompt:', queuedPrompt);
          coalescedBroadcast('SPEAK_RESPONSE', 'Lovable finished. Now sending your queued instruction.');
          injectAndBroadcast(queuedPrompt);
        } else if (state.pendingLovableResponse) {
          // Process deferred Lovable response now that build is done
          const deferred = state.pendingLovableResponse;
          state.pendingLovableResponse = null;
          console.log('[FLB SW] Build finished — summarizing deferred response');
          summarizeAndSpeak(deferred);
        } else {
          coalescedBroadcast('CLARIFICATION', 'Lovable finished building. Ready for your next instruction.');
        }
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

      if (state.autoRetryUsed) {
        // Already retried once — just report to user
        broadcastToSidePanel({
          type: 'SPEAK_RESPONSE',
          text: "The build failed again. You may want to describe the issue or try a different approach."
        });
        sendResponse({ received: true });
        return true;
      }

      state.autoRetryUsed = true;

      // Tell the user what's happening
      broadcastToSidePanel({
        type: 'SPEAK_RESPONSE',
        text: "The build ran into an issue. I'm asking Lovable to diagnose and fix it."
      });

      // Inject a fix-it prompt
      const fixPrompt = `The previous build failed with this error: ${message.error}. Please diagnose the error and fix it so the build succeeds.`;
      injectAndBroadcast(fixPrompt);

      sendResponse({ received: true });
      return true;
    }

    // ── Stop result from content script ────────────────────────────────────────
    case 'STOP_RESULT': {
      // If there's a pending correction prompt, inject it after stop
      if (state.pendingAction && state.pendingAction.type === 'correct') {
        const correctedPrompt = state.pendingAction.prompt;
        state.pendingAction = null;
        state.awaitingConfirmation = false;

        if (message.success) {
          // Wait for Lovable UI to reset after stop, then inject corrected prompt
          setTimeout(() => injectAndBroadcast(correctedPrompt), STOP_REINJECT_DELAY_MS);
        } else {
          // Stop button not found — build may have finished, inject anyway
          injectAndBroadcast(correctedPrompt);
        }
      } else {
        // Plain stop — no follow-up prompt
        const feedback = message.success
          ? 'Lovable has been stopped.'
          : "I tried to stop Lovable but couldn't find the stop button. It may have already finished.";
        broadcastToSidePanel({ type: 'SPEAK_RESPONSE', text: feedback });
      }
      sendResponse({ received: true });
      return true;
    }

    // ── Reset conversation ─────────────────────────────────────────────────────
    case 'RESET_CONVERSATION': {
      resetState();
      persistHistory();
      sendResponse({ received: true });
      return true;
    }
  }
});

// ─── Process Speech ──────────────────────────────────────────────────────────

function processUserSpeech(userText) {
  // Enforce input length limit to prevent unbounded API costs
  if (userText.length > CONFIG.MAX_SPEECH_LENGTH) {
    userText = userText.substring(0, CONFIG.MAX_SPEECH_LENGTH);
    console.log('[FLB SW] Input truncated to', CONFIG.MAX_SPEECH_LENGTH, 'chars');
  }

  state.lastApiCallTime = Date.now();
  state.autoRetryUsed = false; // Reset retry guard on each new user prompt

  // Fast-path: detect stop intent via keywords before calling Claude
  if (STOP_PATTERN.test(userText.trim())) {
    addToHistory('user', userText);
    addToHistory('claude', '[STOP]: User requested stop');
    state.pendingAction = null;
    state.awaitingConfirmation = false;
    broadcastToSidePanel({ type: 'SPEAK_RESPONSE', text: 'Stopping Lovable now.' });
    sendToLovableTab({ type: 'CLICK_STOP' });
    return;
  }

  // Confirmation state machine — check if user is responding to a [DISCUSS]: message
  if (state.awaitingConfirmation) {
    const confirmPattern = /^(yes|yeah|yep|do it|go ahead|sure|let's do that|let's do it|ok|okay|go for it|absolutely|please)$/i;
    const dismissPattern = /^(no|nah|nope|keep going|never mind|nevermind|cancel|forget it|don't|leave it)$/i;

    if (confirmPattern.test(userText.trim())) {
      addToHistory('user', userText);
      if (state.pendingAction && state.pendingAction.prompt) {
        // We already have the prompt — execute directly
        console.log('[FLB SW] User confirmed pending action:', state.pendingAction.type);
        if (state.pendingAction.type === 'correct') {
          addToHistory('claude', `[CONFIRM]: ${state.pendingAction.prompt}`);
          stopAndCorrect(state.pendingAction.prompt, 'Alright, stopping the build and applying the change now.');
        } else if (state.pendingAction.type === 'queue') {
          addToHistory('claude', `[CONFIRM]: Queued — ${state.pendingAction.prompt}`);
          broadcastToSidePanel({ type: 'SPEAK_RESPONSE', text: "Got it, I'll send that once the current build finishes." });
          // state.pendingAction stays as queue — will be auto-injected on idle transition
        }
        state.awaitingConfirmation = false;
      } else {
        // No prompt stored yet — route through Claude to generate the action prompt
        state.awaitingConfirmation = false;
        state.pendingAction = null;
        reformulateWithClaude(userText)
          .then(claudeResponse => {
            addToHistory('claude', claudeResponse);
            if (claudeResponse.startsWith('[CONFIRM]:')) {
              const prompt = claudeResponse.replace('[CONFIRM]:', '').trim();
              stopAndCorrect(prompt, 'Alright, stopping the build and applying your change now.');
            } else if (claudeResponse.startsWith('[PROMPT]:')) {
              const prompt = claudeResponse.replace('[PROMPT]:', '').trim();
              state.lastSentPrompt = prompt;
              stopAndCorrect(prompt, 'Alright, stopping the build and applying your change now.');
            }
          })
          .catch(err => {
            console.error('[FLB SW] Claude API error on confirm:', err);
          });
      }
      return;
    }

    if (dismissPattern.test(userText.trim())) {
      addToHistory('user', userText);
      addToHistory('claude', '[DISMISS]: User chose to keep current build');
      state.pendingAction = null;
      state.awaitingConfirmation = false;
      broadcastToSidePanel({ type: 'SPEAK_RESPONSE', text: 'Alright, keeping the current build going.' });
      return;
    }

    // Not a simple yes/no — clear confirmation state and route through Claude normally
    state.pendingAction = null;
    state.awaitingConfirmation = false;
  }

  addToHistory('user', userText);

  reformulateWithClaude(userText)
    .then(claudeResponse => {
      // Store Claude's response in history for proper multi-turn context
      addToHistory('claude', claudeResponse);

      // ── [STOP]: Halt with no replacement ──
      if (claudeResponse.startsWith('[STOP]:')) {
        broadcastToSidePanel({ type: 'SPEAK_RESPONSE', text: 'Stopping Lovable now.' });
        sendToLovableTab({ type: 'CLICK_STOP' });

      // ── [CORRECT]: Definite course correction — stop + re-prompt ──
      } else if (claudeResponse.startsWith('[CORRECT]:')) {
        const body = claudeResponse.replace('[CORRECT]:', '').trim();
        const parts = body.split('|||');
        const spokenPreamble = parts[0].trim();
        const correctedPrompt = (parts[1] || parts[0]).trim();
        stopAndCorrect(correctedPrompt, spokenPreamble);

      // ── [DISCUSS]: Tentative/exploratory — speak opinion, wait for confirmation ──
      } else if (claudeResponse.startsWith('[DISCUSS]:')) {
        const discussion = claudeResponse.replace('[DISCUSS]:', '').trim();
        broadcastToSidePanel({ type: 'CLARIFICATION', text: discussion });
        // Store a pending correction action in case user confirms
        // Claude's next response will be [CONFIRM]: with the actual prompt
        state.pendingAction = { type: 'correct', prompt: '' }; // prompt will come from [CONFIRM]:
        state.awaitingConfirmation = true;

      // ── [QUEUE]: New instruction for after current build finishes ──
      } else if (claudeResponse.startsWith('[QUEUE]:')) {
        const body = claudeResponse.replace('[QUEUE]:', '').trim();
        const parts = body.split('|||');
        const spokenAck = parts[0].trim();
        const queuedPrompt = (parts[1] || parts[0]).trim();
        state.pendingAction = { type: 'queue', prompt: queuedPrompt };
        broadcastToSidePanel({ type: 'SPEAK_RESPONSE', text: spokenAck });

      // ── [CONFIRM]: User confirmed a discussed action ──
      } else if (claudeResponse.startsWith('[CONFIRM]:')) {
        const prompt = claudeResponse.replace('[CONFIRM]:', '').trim();
        state.pendingAction = { type: 'correct', prompt };
        state.awaitingConfirmation = false;
        stopAndCorrect(prompt, 'Alright, stopping the build and applying your change now.');

      // ── [DISMISS]: User declined a discussed action ──
      } else if (claudeResponse.startsWith('[DISMISS]:')) {
        const ack = claudeResponse.replace('[DISMISS]:', '').trim();
        state.pendingAction = null;
        state.awaitingConfirmation = false;
        broadcastToSidePanel({ type: 'SPEAK_RESPONSE', text: ack });

      // ── [CHAT]: Conversational response — speak only, no Lovable injection ──
      } else if (claudeResponse.startsWith('[CHAT]:')) {
        const chatText = claudeResponse.replace('[CHAT]:', '').trim();
        broadcastToSidePanel({ type: 'CLARIFICATION', text: chatText });

      // ── [CLARIFY]: Standard clarification question ──
      } else if (claudeResponse.startsWith('[CLARIFY]:')) {
        const question = claudeResponse.replace('[CLARIFY]:', '').trim();
        broadcastToSidePanel({ type: 'CLARIFICATION', text: question });

      // ── [PROMPT]: Standard prompt (or fallback) ──
      } else {
        const raw = claudeResponse.startsWith('[PROMPT]:')
          ? claudeResponse.replace('[PROMPT]:', '').trim()
          : claudeResponse.trim();

        const parts = raw.split('|||');
        if (parts.length >= 2) {
          // New format: spoken preamble ||| Lovable prompt
          const spokenPreamble = parts[0].trim();
          const lovablePrompt = parts.slice(1).join('|||').trim();

          broadcastToSidePanel({ type: 'SPEAK_RESPONSE', text: spokenPreamble });
          injectAndBroadcast(lovablePrompt);
        } else {
          // Fallback: no separator — treat entire text as Lovable prompt
          injectAndBroadcast(raw);
        }
      }
    })
    .catch(err => {
      console.error('[FLB SW] Claude API error:', err);
      broadcastToSidePanel({
        type: 'CLARIFICATION',
        text: `Claude error: ${err.message}`
      });
    });
}

// ─── Stop and Correct ────────────────────────────────────────────────────────

function stopAndCorrect(correctedPrompt, spokenPreamble) {
  console.log('[FLB SW] stopAndCorrect — preamble:', spokenPreamble, 'prompt:', correctedPrompt);

  // Tell the user what's happening via avatar
  broadcastToSidePanel({ type: 'SPEAK_RESPONSE', text: spokenPreamble });

  // Store the corrected prompt so STOP_RESULT handler can inject it
  state.pendingAction = { type: 'correct', prompt: correctedPrompt };

  // Send stop command to content script
  sendToLovableTab({ type: 'CLICK_STOP' });
  // The STOP_RESULT handler will inject the corrected prompt after stop succeeds
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Set lastSentPrompt, broadcast to sidepanel, inject into Lovable, and optionally record in history. */
function injectAndBroadcast(prompt, { addHistory = true } = {}) {
  state.lastSentPrompt = prompt;
  broadcastToSidePanel({ type: 'PROMPT_SENT', prompt });
  sendToLovableTab({ type: 'INJECT_PROMPT', prompt });
  if (addHistory) addToHistory('claude', `[PROMPT]: ${prompt}`);
}

// Send a message to all extension pages (side panel listens here)
function broadcastToSidePanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Side panel may not be open — ignore
  });
}

/**
 * Coalesced broadcast for Lovable-originated speech. If another broadcast
 * arrives within BROADCAST_COALESCE_MS, they merge into a single message
 * so the avatar speaks one flowing sentence instead of two choppy ones.
 * Only used for status/summary speech — not for direct Claude responses.
 */
function coalescedBroadcast(type, text) {
  if (state.pendingBroadcast) {
    clearTimeout(state.pendingBroadcast.timer);
    state.pendingBroadcast.text += ' ' + text;
    state.pendingBroadcast.type = type;
  } else {
    state.pendingBroadcast = { type, text };
  }

  state.pendingBroadcast.timer = setTimeout(() => {
    const { type: finalType, text: finalText } = state.pendingBroadcast;
    state.pendingBroadcast = null;
    broadcastToSidePanel({ type: finalType, text: finalText });
  }, BROADCAST_COALESCE_MS);
}

// Send a message to the content script running on Lovable
function sendToLovableTab(message) {
  console.log('[FLB SW] sendToLovableTab called. lovableTabId:', state.lovableTabId, 'message type:', message.type);

  if (state.lovableTabId !== null) {
    console.log('[FLB SW] Using cached tab ID:', state.lovableTabId);
    chrome.tabs.sendMessage(state.lovableTabId, message)
      .then(() => console.log('[FLB SW] Message delivered to tab', state.lovableTabId))
      .catch(err => {
        console.error('[FLB SW] Could not reach content script on cached tab:', state.lovableTabId, err.message);
        // Cached tab may be stale — clear it and retry via query
        state.lovableTabId = null;
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

    // Pick the best tab: prefer ready + active, then project tabs, then any
    const readyTabsList = tabs.filter(t => readyTabs.has(t.id));
    const pool = readyTabsList.length > 0 ? readyTabsList : tabs;
    const activeTab = pool.find(t => t.active);
    const projectTab = pool.find(t => t.url.includes('/projects/'));
    const dashboardTab = pool.find(t => t.url.includes('/dashboard'));
    const bestTab = activeTab || projectTab || dashboardTab || pool[0];
    console.log('[FLB SW] Selected tab:', bestTab.id, bestTab.url);

    state.lovableTabId = bestTab.id;

    // Try to send; if it fails, try each remaining tab
    tryTabsInOrder([bestTab, ...tabs.filter(t => t.id !== bestTab.id)], message);
  });
}

// Try sending a message to tabs one at a time until one succeeds.
// If all fail, auto-inject the content script and retry once.
function tryTabsInOrder(tabs, message, alreadyInjected = false) {
  if (tabs.length === 0) {
    if (alreadyInjected) {
      // Already tried injecting — give up with a helpful error
      broadcastToSidePanel({
        type: 'INJECTION_ERROR',
        error: 'Could not reach Lovable. Open a Lovable project page and try again.'
      });
      return;
    }

    // Auto-inject content script on all lovable tabs and retry
    console.log('[FLB SW] All tabs unreachable — auto-injecting content script…');
    chrome.tabs.query({ url: ['https://lovable.dev/*', 'https://*.lovable.dev/*'] }, (allTabs) => {
      if (allTabs.length === 0) {
        broadcastToSidePanel({
          type: 'INJECTION_ERROR',
          error: 'No Lovable tab found. Open lovable.dev in a project first.'
        });
        return;
      }

      // Inject content script into all Lovable tabs
      const injections = allTabs.map(tab =>
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/content-script.js']
        }).catch(err => {
          console.warn('[FLB SW] Could not inject into tab', tab.id, ':', err.message);
          return null;
        })
      );

      Promise.all(injections).then(() => {
        // Brief delay for the content script to initialize
        setTimeout(() => {
          console.log('[FLB SW] Retrying after auto-injection…');
          tryTabsInOrder(allTabs, message, true);
        }, AUTO_INJECT_DELAY_MS);
      });
    });
    return;
  }

  const tab = tabs[0];
  chrome.tabs.sendMessage(tab.id, message)
    .then(() => {
      console.log('[FLB SW] Message delivered to tab', tab.id, tab.url);
      state.lovableTabId = tab.id; // Cache the working tab
      readyTabs.add(tab.id);
    })
    .catch(err => {
      console.warn('[FLB SW] Tab', tab.id, 'unreachable:', err.message, '— trying next…');
      readyTabs.delete(tab.id);
      tryTabsInOrder(tabs.slice(1), message, alreadyInjected);
    });
}
