// Lovable Voice Builder — Content Script
// Runs on lovable.dev. Two responsibilities:
//   1. Inject reformulated prompts into Lovable's chat input and submit them.
//   2. Watch Lovable's chat for new responses and relay them to the avatar.

console.log('[LVB] Lovable Voice Builder content script loaded');

// ─── Selectors ────────────────────────────────────────────────────────────────
// These are tried in order. The first match wins.
// UPDATE these after manually inspecting Lovable's DOM in DevTools.

const SELECTORS = {
  chatInput: [
    'textarea[placeholder*="Ask"]',
    'textarea[placeholder*="ask"]',
    'textarea[placeholder*="prompt"]',
    'textarea[placeholder*="Prompt"]',
    'textarea[placeholder*="message"]',
    'textarea[placeholder*="Message"]',
    'div[contenteditable="true"][data-lexical-editor]',
    'div[contenteditable="true"]',
    '[data-testid="chat-input"]',
    '[data-testid="prompt-input"]',
    '.prompt-input textarea',
    'form textarea',
    'main textarea'
  ],
  sendButton: [
    'button[type="submit"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    'button[aria-label*="Submit"]',
    'button[data-testid*="send"]',
    'form button:last-of-type',
    'main button:last-of-type'
  ],
  chatMessages: [
    '[class*="chat-messages"]',
    '[class*="message-list"]',
    '[class*="conversation"]',
    '[class*="ChatMessages"]',
    '[class*="MessageList"]',
    'main [class*="overflow"]',
    'main [class*="scroll"]'
  ]
};

// ─── DOM Helpers ──────────────────────────────────────────────────────────────

function findElement(selectorList) {
  for (const selector of selectorList) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch {
      // Invalid selector — skip
    }
  }
  return null;
}

// ─── Prompt Injection ─────────────────────────────────────────────────────────

function injectPrompt(text) {
  const input = findElement(SELECTORS.chatInput);

  if (!input) {
    console.error('[LVB] Could not find Lovable chat input. Is a project open?');
    chrome.runtime.sendMessage({
      type: 'INJECTION_ERROR',
      error: 'Chat input not found. Open a Lovable project first.'
    });
    return false;
  }

  const tag = input.tagName.toUpperCase();

  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    // React-controlled textarea: setting .value alone won't trigger onChange.
    // Use the native property setter to bypass React's synthetic wrapper, then
    // dispatch an 'input' event so React registers the change.
    const proto = tag === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    nativeSetter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

  } else if (input.getAttribute('contenteditable') === 'true') {
    // Rich-text / contenteditable editor (Slate, Lexical, ProseMirror, TipTap)
    input.focus();

    // Try execCommand first (broadest compatibility with rich-text editors)
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    } catch {
      // execCommand may be blocked — fall back to direct manipulation
      input.textContent = text;
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text
      }));
    }

  } else {
    console.warn('[LVB] Unknown input element type:', tag);
    return false;
  }

  // Brief delay to let React update before we click Send
  setTimeout(triggerSend, 200);
  return true;
}

function triggerSend() {
  const sendBtn = findElement(SELECTORS.sendButton);
  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
    return;
  }

  // Fallback: dispatch Enter keydown on the input
  const input = findElement(SELECTORS.chatInput);
  if (input) {
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true
    }));
    input.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true
    }));
  }
}

// ─── MutationObserver — Watch Lovable's Responses ────────────────────────────

let lastMessageHash = '';
let debounceTimer = null;
const DEBOUNCE_MS = 1500; // Wait for Lovable to finish streaming before extracting

function initializeObserver() {
  // Lovable is a SPA — the chat container may not exist until a project loads.
  // Poll until it appears.
  const pollInterval = setInterval(() => {
    const container = findChatContainer();
    if (container) {
      clearInterval(pollInterval);
      startObserving(container);
      console.log('[LVB] MutationObserver attached to Lovable chat container');
    }
  }, 1000);
}

function findChatContainer() {
  for (const selector of SELECTORS.chatMessages) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch {
      // Skip invalid selector
    }
  }
  return null;
}

function startObserving(container) {
  const observer = new MutationObserver(() => {
    // Debounce: reset timer on every mutation.
    // Lovable streams its response — we wait until it settles.
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => extractLatestResponse(container), DEBOUNCE_MS);
  });

  observer.observe(container, {
    childList: true,    // New message nodes
    subtree: true,      // Nested elements
    characterData: true // Streaming text changes
  });

  // Re-connect if the container is removed and re-created (SPA navigation)
  const parentObserver = new MutationObserver(() => {
    if (!document.contains(container)) {
      parentObserver.disconnect();
      observer.disconnect();
      console.log('[LVB] Chat container removed — re-initializing observer');
      initializeObserver();
    }
  });
  parentObserver.observe(document.body, { childList: true, subtree: true });
}

function extractLatestResponse(container) {
  // Find all message-like elements in the container
  const candidates = [
    ...container.querySelectorAll('[class*="message"]'),
    ...container.querySelectorAll('[class*="Message"]'),
    ...container.querySelectorAll('[role="listitem"]'),
    ...container.querySelectorAll('article'),
    ...container.children
  ];

  if (candidates.length === 0) return;

  // Walk backwards to find the latest non-user message
  for (let i = candidates.length - 1; i >= 0; i--) {
    const el = candidates[i];
    if (isUserMessage(el)) continue;

    const text = extractConversationalText(el);
    if (!text) continue;

    // Deduplicate
    const hash = simpleHash(text);
    if (hash === lastMessageHash) return;
    lastMessageHash = hash;

    console.log('[LVB] Lovable response extracted:', text.substring(0, 80) + '…');

    chrome.runtime.sendMessage({
      type: 'LOVABLE_RESPONSE',
      text,
      messageId: hash
    });
    return;
  }
}

function isUserMessage(element) {
  const classes = (element.className || '').toLowerCase();
  const ariaLabel = (element.getAttribute('aria-label') || '').toLowerCase();

  return (
    classes.includes('user') ||
    classes.includes('human') ||
    classes.includes('sender') ||
    ariaLabel.includes('user') ||
    ariaLabel.includes('you') ||
    element.querySelector('[class*="user"]') !== null ||
    element.querySelector('[class*="human"]') !== null
  );
}

function extractConversationalText(element) {
  const clone = element.cloneNode(true);

  // Strip code/diff/technical blocks — we only want conversational prose
  const stripSelectors = [
    'pre', 'code',
    '[class*="code"]', '[class*="Code"]',
    '[class*="diff"]', '[class*="Diff"]',
    '[class*="terminal"]', '[class*="Terminal"]',
    '[class*="file-change"]', '[class*="FileChange"]',
    '[class*="snippet"]', '[class*="Snippet"]',
    '[class*="syntax"]',
    'svg',
    'button',
    'input'
  ];

  stripSelectors.forEach(selector => {
    try {
      clone.querySelectorAll(selector).forEach(el => el.remove());
    } catch {
      // Skip invalid selectors
    }
  });

  let text = clone.textContent
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length < 10) return null; // Too short — likely a UI artifact

  // Truncate for speech — avatar shouldn't read paragraphs
  if (text.length > 500) {
    text = text.substring(0, 500) + '… I can share more if you ask.';
  }

  return text;
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString();
}

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'INJECT_PROMPT') {
    const success = injectPrompt(message.prompt);
    sendResponse({ success });

    if (success) {
      chrome.runtime.sendMessage({
        type: 'LOVABLE_STATUS',
        status: 'building'
      });
    }

    return true; // Keep message channel open for async sendResponse
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

initializeObserver();
