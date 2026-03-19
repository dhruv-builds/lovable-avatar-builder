// Facetime Lovable Builder — Content Script
// Runs on lovable.dev. Two responsibilities:
//   1. Inject reformulated prompts into Lovable's chat input and submit them.
//   2. Watch Lovable's chat for new responses and relay them to the avatar.

console.log('[FLB] Facetime Lovable Builder content script loaded');

// Announce to service worker that this tab has an active content script
chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', url: window.location.href })
  .catch(() => { /* Extension context may not be ready yet — harmless */ });

// ─── Selectors ────────────────────────────────────────────────────────────────
// These are tried in order. The first match wins.
// UPDATE these after manually inspecting Lovable's DOM in DevTools.

const SELECTORS = {
  chatInput: [
    // TipTap / ProseMirror (Lovable homepage confirmed match)
    '[aria-label="Chat input"]',
    'div.tiptap[contenteditable="true"]',
    // In-project chat
    'textarea[placeholder*="Ask"]',
    'textarea[placeholder*="ask"]',
    'textarea[placeholder*="prompt"]',
    'textarea[placeholder*="Prompt"]',
    'textarea[placeholder*="message"]',
    'textarea[placeholder*="Message"]',
    // Homepage textarea fallbacks
    'textarea[placeholder*="create"]',
    'textarea[placeholder*="build"]',
    // Other rich-text editors
    'div[contenteditable="true"][data-lexical-editor]',
    '[contenteditable="true"][placeholder*="Ask"]',
    '[contenteditable="true"][data-placeholder*="Ask"]',
    'div[contenteditable="true"]',
    // Data-testid fallbacks
    '[data-testid="chat-input"]',
    '[data-testid="prompt-input"]',
    // Generic fallbacks
    '.prompt-input textarea',
    'form textarea',
    'main textarea'
  ],
  sendButton: [
    'button[type="submit"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    'button[aria-label*="Submit"]',
    'button[aria-label*="Create"]',
    'button[aria-label*="Start"]',
    'button[data-testid*="send"]',
    'button[data-testid*="submit"]',
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

// ─── Echo Suppression ─────────────────────────────────────────────────────────
// After injecting a prompt, we suppress the observer briefly so it doesn't
// pick up the injected text as a "Lovable response" and relay it back.

let lastInjectedPrompt = null;   // Text content of the last prompt we injected
let suppressObserver = false;     // Flag to temporarily disable observer processing

// ─── Build State Detection ───────────────────────────────────────────────────
// Track whether Lovable is actively building so the service worker can gate prompts.

let lovableBuildState = 'idle'; // 'idle' | 'building'
let buildCheckInterval = null;
let lastBuildFailReported = false; // Guard against repeated failure reports

function detectBuildState() {
  // Look for indicators that Lovable is actively building
  const buildIndicators = [
    // "Thinking" / "Finished thinking" indicators
    '[class*="thinking"]', '[class*="Thinking"]',
    // Loading spinners / progress
    '[class*="loading"]', '[class*="Loading"]',
    '[class*="spinner"]', '[class*="Spinner"]',
    '[class*="progress"]', '[class*="Progress"]',
    // Streaming cursor / typing indicator
    '[class*="streaming"]', '[class*="Streaming"]',
    '[class*="typing"]', '[class*="Typing"]',
    // Lovable-specific: "Editing file.tsx" blocks
    '[class*="editing"]', '[class*="Editing"]',
  ];

  let isBuilding = false;
  let detail = '';

  for (const sel of buildIndicators) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        isBuilding = true;
        const txt = el.textContent.trim().substring(0, 60);
        if (txt) detail = txt;
        break;
      }
    } catch {}
  }

  // Also check for the stop button — if it's visible, Lovable is building
  const stopBtn = document.querySelector('button[aria-label*="Stop"]') ||
                  document.querySelector('button[aria-label*="stop"]') ||
                  document.querySelector('button[title*="Stop"]');
  if (stopBtn) {
    isBuilding = true;
    if (!detail) detail = 'Building…';
  }

  const newState = isBuilding ? 'building' : 'idle';

  if (newState !== lovableBuildState) {
    lovableBuildState = newState;
    console.log('[FLB] Build state changed:', newState, detail || '');
    chrome.runtime.sendMessage({
      type: 'LOVABLE_STATUS',
      status: newState,
      detail: detail || (newState === 'building' ? 'Lovable is working…' : 'Ready for next prompt')
    });

    // Reset failure guard when build transitions to idle normally
    if (newState === 'idle') {
      lastBuildFailReported = false;
    }
  }

  // ── Build failure detection ──
  // Check for failure indicators in recent chat messages
  if (!isBuilding && !lastBuildFailReported) {
    const failurePatterns = [
      'Build unsuccessful', 'Build failed', 'build error',
      'could not compile', 'compilation error', 'Failed to build'
    ];

    // Look for failure text in the most recent message elements
    const messageEls = document.querySelectorAll(
      '[class*="message"], [class*="Message"], [role="listitem"], article'
    );

    if (messageEls.length > 0) {
      // Check only the last few messages for failure text
      const recentEls = Array.from(messageEls).slice(-3);
      for (const el of recentEls) {
        const text = el.textContent || '';
        for (const pattern of failurePatterns) {
          if (text.toLowerCase().includes(pattern.toLowerCase())) {
            lastBuildFailReported = true;
            const errorSnippet = text.substring(0, 200).trim();
            console.log('[FLB] Build failure detected:', errorSnippet);
            chrome.runtime.sendMessage({
              type: 'BUILD_FAILED',
              error: errorSnippet
            });
            return; // Stop checking once failure is reported
          }
        }
      }
    }
  }
}

function startBuildStatePolling() {
  // Poll every 500ms to detect build state changes
  if (buildCheckInterval) return;
  buildCheckInterval = setInterval(detectBuildState, 500);
}

// ─── Prompt Injection ─────────────────────────────────────────────────────────

function injectPrompt(text) {
  // Diagnostic: log which selectors match on this page
  const pageContext = window.location.pathname.includes('/projects/') ? 'project' : 'homepage';
  console.log('[FLB] Injecting prompt on:', pageContext, window.location.pathname);
  SELECTORS.chatInput.forEach(sel => {
    try {
      const el = document.querySelector(sel);
      if (el) console.log('[FLB] ✓ Input matched:', sel, '→', el.tagName, el);
    } catch {}
  });
  SELECTORS.sendButton.forEach(sel => {
    try {
      const el = document.querySelector(sel);
      if (el) console.log('[FLB] ✓ Button matched:', sel, '→', el.tagName, el);
    } catch {}
  });

  const input = findElement(SELECTORS.chatInput);

  if (!input) {
    console.error('[FLB] Could not find Lovable chat input on', pageContext, 'page.');
    chrome.runtime.sendMessage({
      type: 'INJECTION_ERROR',
      error: pageContext === 'homepage'
        ? 'Homepage input not found — try opening a project first.'
        : 'Chat input not found. Open a Lovable project first.'
    });
    return false;
  }

  console.log('[FLB] Using input:', input.tagName, input.placeholder || '');

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
    // Rich-text / contenteditable editor (TipTap, ProseMirror, Slate, Lexical)
    input.focus();

    // Strategy 1: Synthetic paste event — works best with TipTap/ProseMirror
    // These frameworks listen for paste events and handle text insertion internally
    let injected = false;
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      });
      injected = input.dispatchEvent(pasteEvent);
      // Check if the editor actually picked up the text
      const content = input.textContent.trim();
      if (content.length > 0 && content !== text) {
        // Paste was dispatched but editor may not have handled it
        injected = false;
      }
      if (content === text || content.includes(text)) {
        injected = true;
      }
      console.log('[FLB] Paste event dispatched, injected:', injected, 'content:', content.substring(0, 50));
    } catch (e) {
      console.log('[FLB] Paste event failed:', e.message);
      injected = false;
    }

    // Strategy 2: execCommand (fallback for editors that don't handle paste events)
    if (!injected) {
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
        console.log('[FLB] execCommand insertText used');
      } catch {
        // Strategy 3: Direct DOM manipulation (last resort)
        input.textContent = text;
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: text
        }));
        console.log('[FLB] Direct textContent manipulation used');
      }
    }

  } else {
    console.warn('[FLB] Unknown input element type:', tag);
    return false;
  }

  // ── Echo suppression: prevent the observer from picking up our own prompt ──
  lastInjectedPrompt = text;
  suppressObserver = true;
  setTimeout(() => {
    suppressObserver = false;
    console.log('[FLB] Observer suppression window ended');
  }, 5000);

  // Delay to let React process injected text before attempting send
  setTimeout(triggerSend, 500);
  return true;
}

function triggerSend(attempt = 0) {
  const maxAttempts = 5;
  const sendBtn = findElement(SELECTORS.sendButton);

  // If button found and enabled, click it
  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
    console.log('[FLB Content] Send button clicked (attempt ' + attempt + ')');
    return;
  }

  // If we haven't exhausted retries, wait and try again (button may still be disabled)
  if (attempt < maxAttempts) {
    console.log('[FLB Content] Send button not ready, retrying (' + (attempt + 1) + '/' + maxAttempts + ')');
    setTimeout(() => triggerSend(attempt + 1), 300);
    return;
  }

  // Final fallback: dispatch Enter key on the input
  console.log('[FLB Content] Fallback: dispatching Enter key after ' + maxAttempts + ' attempts');
  const input = findElement(SELECTORS.chatInput);
  if (input) {
    input.focus();
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
      console.log('[FLB] MutationObserver attached to Lovable chat container');
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
    // Skip processing if we just injected a prompt (echo suppression)
    if (suppressObserver) {
      return;
    }
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
      console.log('[FLB] Chat container removed — re-initializing observer');
      initializeObserver();
    }
  });
  parentObserver.observe(document.body, { childList: true, subtree: true });
}

function extractLatestResponse(container) {
  // Find all message-like elements in the container (deduplicated)
  const seen = new Set();
  const candidates = [
    ...container.querySelectorAll('[class*="message"]'),
    ...container.querySelectorAll('[class*="Message"]'),
    ...container.querySelectorAll('[role="listitem"]'),
    ...container.querySelectorAll('article'),
    ...container.children
  ].filter(el => {
    if (seen.has(el)) return false;
    seen.add(el);
    return true;
  });

  if (candidates.length === 0) return;

  // Walk backwards to find the latest non-user message
  for (let i = candidates.length - 1; i >= 0; i--) {
    const el = candidates[i];
    if (isUserMessage(el)) continue;

    const text = extractConversationalText(el);
    if (!text) continue;

    // Echo suppression: skip if this text matches our injected prompt
    if (lastInjectedPrompt) {
      const promptStart = lastInjectedPrompt.substring(0, 100).toLowerCase();
      const responseStart = text.substring(0, 100).toLowerCase();
      if (responseStart.includes(promptStart) || promptStart.includes(responseStart)) {
        console.log('[FLB] Skipping echo of injected prompt');
        lastInjectedPrompt = null; // Clear after matching once
        return;
      }
    }

    // Deduplicate
    const hash = simpleHash(text);
    if (hash === lastMessageHash) return;
    lastMessageHash = hash;

    console.log('[FLB] Lovable response extracted:', text.substring(0, 80) + '…');

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

// ─── Stop Confirmation Dialog Helper ──────────────────────────────────────────
// Lovable may show "Are you sure you want to stop?" after clicking Stop.
// Find the confirm/yes button inside any dialog or modal overlay.

function findStopConfirmButton() {
  // Check inside dialog/modal containers first
  const dialogContainers = document.querySelectorAll(
    '[role="dialog"], [role="alertdialog"], [class*="modal"], [class*="Modal"], ' +
    '[class*="dialog"], [class*="Dialog"], [class*="overlay"], [class*="Overlay"], ' +
    '[class*="popover"], [class*="Popover"]'
  );

  const confirmTexts = ['yes', 'confirm', 'stop', 'ok', 'continue', 'proceed'];

  for (const container of dialogContainers) {
    const buttons = container.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      if (confirmTexts.some(t => text === t || text.startsWith(t))) {
        return btn;
      }
    }
  }

  // Fallback: look for any recently-appeared button with confirm-like text
  // that isn't the original stop button
  const allButtons = document.querySelectorAll('button');
  for (const btn of allButtons) {
    const text = (btn.textContent || '').trim().toLowerCase();
    // Match "Yes", "Confirm", "Yes, stop" etc. but not generic nav buttons
    if (text.includes('yes') || text === 'confirm' || text.match(/^stop\b/) || text === 'ok') {
      // Skip if it's the original build-stop button (has aria-label "Stop")
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (ariaLabel.includes('stop')) continue;
      return btn;
    }
  }

  return null;
}

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CLICK_STOP') {
    const stopBtn = document.querySelector('button[aria-label*="Stop"]') ||
                    document.querySelector('button[aria-label*="stop"]') ||
                    document.querySelector('button[title*="Stop"]');
    if (stopBtn) {
      stopBtn.click();
      console.log('[FLB] Stop button clicked');

      // Watch for a confirmation dialog ("Are you sure you want to stop?")
      // and auto-confirm it. Poll every 200ms for up to 2s.
      let confirmAttempts = 0;
      const confirmInterval = setInterval(() => {
        confirmAttempts++;
        const confirmBtn = findStopConfirmButton();
        if (confirmBtn) {
          confirmBtn.click();
          clearInterval(confirmInterval);
          console.log('[FLB] Stop confirmation dialog auto-confirmed');
        }
        if (confirmAttempts >= 10) clearInterval(confirmInterval);
      }, 200);

      chrome.runtime.sendMessage({ type: 'STOP_RESULT', success: true });
    } else {
      console.log('[FLB] Stop button not found');
      chrome.runtime.sendMessage({ type: 'STOP_RESULT', success: false });
    }
    sendResponse({ received: true });
    return true;
  }

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
startBuildStatePolling();
