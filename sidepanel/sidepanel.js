// Facetime Lovable Builder — Side Panel Logic
// Handles Anam SDK initialization, speech events, and message routing.

// CONFIG is loaded from ../config.js via sidepanel.html
// AnamAI is the global provided by the Anam SDK UMD bundle
// Inline scripts are blocked by Chrome MV3 CSP — assign here instead
var AnamAI = window.anam;

// ─── State ────────────────────────────────────────────────────────────────────

let anamClient = null;
let isListening = true; // Voice capture toggle — pausing suppresses speech, text still works
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
let heartbeatInterval = null;

// ─── Speech Queue State ─────────────────────────────────────────────────────
// Messages queue up and play sequentially so Lovable updates never cut off
// the avatar mid-sentence.
const speechQueue = [];
let isSpeaking = false;
let currentTalkStream = null;
let speechTimeoutId = null;
const SPEECH_RATE_MS_PER_CHAR = 65;    // ~65ms per character TTS estimate
const MIN_SPEECH_TIMEOUT_MS = 3000;     // Minimum fallback timeout
const MAX_SPEECH_TIMEOUT_MS = 30000;    // Maximum fallback timeout

// ─── Anam SDK Initialization ──────────────────────────────────────────────────

async function initializeAnam() {
  updateAvatarStateLabel('Connecting…');

  // Validate config before attempting connection
  if (!CONFIG.ANAM_API_KEY || CONFIG.ANAM_API_KEY === 'YOUR_ANAM_API_KEY') {
    updateStatus('error', 'Missing ANAM_API_KEY — update config.js');
    updateAvatarStateLabel('Config missing');
    return;
  }

  try {
    // ── Step 0: Try to get microphone permission (non-blocking) ──
    // Chrome extension sidepanels may silently deny getUserMedia.
    // We try, but continue regardless — text input still works without mic.
    // To enable mic: chrome://settings/content/microphone → allow this extension.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      console.log('[FLB] Microphone permission granted');
    } catch (micErr) {
      console.warn('[FLB] Microphone not available:', micErr.message,
        '— voice input disabled, text input still works.',
        'To fix: chrome://settings/content/microphone');
      updateStatus('error', 'Mic blocked — check chrome://settings/content/microphone');
    }

    // ── Step 1: Exchange API key for session token (production flow) ──
    // Using createClient(sessionToken) instead of unsafe_createClientWithApiKey
    // to avoid the legacy session type that causes engine 500 errors.
    const tokenResp = await fetch('https://api.anam.ai/v1/auth/session-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.ANAM_API_KEY}`
      },
      body: JSON.stringify({
        personaConfig: {
          name: 'Builder',
          avatarId: CONFIG.ANAM_AVATAR_ID,
          voiceId: CONFIG.ANAM_VOICE_ID,
          llmId: 'CUSTOMER_CLIENT_V1',
          systemPrompt: ''
        }
      })
    });
    const tokenBody = await tokenResp.text();
    console.log('[FLB] Session token API:', tokenResp.status, tokenBody);
    if (!tokenResp.ok) {
      updateStatus('error', `Anam API ${tokenResp.status}: ${tokenBody.slice(0, 100)}`);
      updateAvatarStateLabel(`API ${tokenResp.status}`);
      return;
    }
    const { sessionToken } = JSON.parse(tokenBody);
    console.log('[FLB] Session token obtained, creating client…');

    // ── Step 2: Create client with session token ──
    anamClient = AnamAI.createClient(sessionToken);

    // ── Step 3: Stream avatar to video element ──
    await anamClient.streamToVideoElement('avatar-video');

    // ── Event listeners (SDK v4 uses addListener + AnamEvent enum) ────────
    const AnamEvent = AnamAI.AnamEvent;

    anamClient.addListener(AnamEvent.MESSAGE_HISTORY_UPDATED, (messages) => {
      // Fires when user finishes speaking — messages array has full history
      const last = messages[messages.length - 1];
      if (last && last.role === 'user' && isListening) {
        handleUserSpeech(last.content);
      }
    });

    anamClient.addListener(AnamEvent.CONNECTION_ESTABLISHED, () => {
      console.log('[FLB Panel] Connection established');
      reconnectAttempts = 0;
      startHeartbeat();
      updateStatus('listening', 'Listening — speak to build');
      updateAvatarStateLabel('Live');
    });

    anamClient.addListener(AnamEvent.CONNECTION_CLOSED, () => {
      console.log('[FLB Panel] Connection closed');
      stopHeartbeat();
      clearSpeechQueue();

      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        console.log(`[FLB Panel] Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`);
        updateAvatarStateLabel(`Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`);
        updateStatus('idle', 'Avatar reconnecting…');
        setTimeout(() => {
          initializeAnam().catch(err => {
            console.warn('[FLB Panel] Reconnect failed:', err.message);
            collapseAvatar('Connection lost');
            updateStatus('listening', 'Avatar lost — text mode active');
            addChatMessage('system', 'Avatar connection lost — using text mode');
          });
        }, 2000);
      } else {
        collapseAvatar('Connection lost');
        updateStatus('listening', 'Avatar disconnected — text mode active');
        addChatMessage('system', 'Avatar disconnected after retries — using text mode');
      }
    });

    anamClient.addListener(AnamEvent.MIC_PERMISSION_GRANTED, () => {
      console.log('[FLB Panel] SDK mic permission granted');
      updateStatus('listening', 'Listening — speak to build');
      updateAvatarStateLabel('Live');
    });

    anamClient.addListener(AnamEvent.MIC_PERMISSION_DENIED, () => {
      console.warn('[FLB Panel] SDK mic permission denied');
      updateStatus('error', 'Microphone blocked — voice input disabled');
      updateAvatarStateLabel('Mic denied');
    });

    // ── Speech queue: detect when avatar finishes speaking ──
    anamClient.addListener(AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED, (event) => {
      if (event.role === 'persona' && event.endOfSpeech) {
        console.log('[FLB Panel] Persona finished speaking (SDK event)');
        onSpeechComplete();
      }
    });

    updateStatus('idle', 'Avatar connected — waiting for mic…');
    updateAvatarStateLabel('Connecting mic…');

  } catch (err) {
    console.error('[FLB Panel] Failed to initialize Anam:', err);
    const msg = err?.message || err?.toString() || 'Unknown error';
    updateStatus('error', 'Avatar failed: ' + msg);
    updateAvatarStateLabel('Error: ' + msg.slice(0, 40));
  }
}

// ─── Heartbeat — Keep Anam Connection Alive ──────────────────────────────────

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (!anamClient || isSpeaking) return;
    try {
      // Send an empty talk message to keep the WebSocket/WebRTC alive
      const stream = anamClient.createTalkMessageStream();
      stream.streamMessageChunk(' ');
      stream.endMessage();
    } catch (e) {
      console.warn('[FLB Panel] Heartbeat failed:', e.message);
    }
  }, 20000); // Every 20 seconds
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// ─── Speech Input ─────────────────────────────────────────────────────────────

let speechDebounceTimer = null;

function handleUserSpeech(text) {
  if (!text || !text.trim()) return;

  // Debounce rapid speech events (e.g. Anam SDK fires multiple times)
  clearTimeout(speechDebounceTimer);
  speechDebounceTimer = setTimeout(() => {
    addChatMessage('user', text);
    console.log('[FLB Panel] User said:', text);
    debugLog('→ USER_SPEECH', text);
    updateStatus('processing', 'Thinking…');

    chrome.runtime.sendMessage({
      type: 'USER_SPEECH',
      text: text.trim()
    });
  }, 500);
}

// ─── Avatar Speech Output (Queued) ────────────────────────────────────────────

/**
 * Queue text for the avatar to speak. If the avatar is already speaking,
 * the new text is appended to the last queued item so closely-spaced
 * messages merge into one continuous utterance.
 */
function queueSpeech(text) {
  if (!text || !isListening) return;

  if (isSpeaking && speechQueue.length > 0) {
    // Coalesce with the last queued item
    speechQueue[speechQueue.length - 1] += ' ' + text;
    console.log('[FLB Panel] Coalesced speech into queue item', speechQueue.length - 1);
    return;
  }

  speechQueue.push(text);
  if (!isSpeaking) processNextSpeech();
}

function processNextSpeech() {
  if (speechQueue.length === 0) {
    isSpeaking = false;
    currentTalkStream = null;
    return;
  }

  if (!anamClient) {
    speechQueue.length = 0;
    isSpeaking = false;
    return;
  }

  isSpeaking = true;
  const text = speechQueue.shift();

  try {
    currentTalkStream = anamClient.createTalkMessageStream();
    currentTalkStream.streamMessageChunk(text);
    currentTalkStream.endMessage();
    console.log('[FLB Panel] Speaking:', text.substring(0, 80) + (text.length > 80 ? '…' : ''));

    // Fallback timeout in case SDK event doesn't fire
    clearTimeout(speechTimeoutId);
    const estimatedDuration = Math.max(
      MIN_SPEECH_TIMEOUT_MS,
      Math.min(text.length * SPEECH_RATE_MS_PER_CHAR, MAX_SPEECH_TIMEOUT_MS)
    );
    speechTimeoutId = setTimeout(() => {
      console.log('[FLB Panel] Speech timeout fallback fired');
      onSpeechComplete();
    }, estimatedDuration);
  } catch (err) {
    console.error('[FLB Panel] speakThroughAvatar error:', err);
    isSpeaking = false;
    processNextSpeech();
  }
}

function onSpeechComplete() {
  clearTimeout(speechTimeoutId);
  isSpeaking = false;
  currentTalkStream = null;

  // Brief pause between consecutive messages for natural pacing
  if (speechQueue.length > 0) {
    setTimeout(processNextSpeech, 300);
  }
}

function clearSpeechQueue() {
  speechQueue.length = 0;
  clearTimeout(speechTimeoutId);
  isSpeaking = false;
  currentTalkStream = null;
}

// ─── Background SW Message Handler ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {

    case 'CLARIFICATION':
      debugLog('← CLARIFICATION', message.text);
      addChatMessage('assistant', message.text);
      queueSpeech(message.text);
      updateStatus('listening', 'Waiting for your answer…');
      break;

    case 'SPEAK_RESPONSE':
      debugLog('← SPEAK_RESPONSE', message.text);
      addChatMessage('assistant', message.text);
      queueSpeech(message.text);
      updateStatus('listening', 'Done — ready for next instruction');
      break;

    case 'PROMPT_SENT':
      debugLog('← PROMPT_SENT', message.prompt);
      addChatMessage('system', '→ Sent to Lovable: ' + message.prompt);
      updateStatus('building', 'Prompt sent — Lovable is building…');
      break;

    case 'LOVABLE_STATUS':
      debugLog('← LOVABLE_STATUS', message.status);
      if (message.status === 'idle') {
        updateStatus('listening', 'Ready for next instruction');
      } else if (message.status === 'building') {
        const detail = message.detail || 'Lovable is working…';
        updateStatus('building', detail);
      }
      break;

    case 'LOVABLE_RAW_RESPONSE':
      debugLog('← LOVABLE_RAW_RESPONSE', message.text);
      addChatMessage('lovable', message.text);
      break;

    case 'INJECTION_ERROR':
      debugLog('← INJECTION_ERROR', message.error);
      addChatMessage('system', 'Error: ' + (message.error || 'Injection failed'));
      addChatMessage('system', 'Tip: Make sure you have a Lovable project open (not the homepage). If already open, reload the Lovable tab.');
      updateStatus('error', 'Injection failed — reload Lovable tab');
      break;
  }
});

// ─── Controls ─────────────────────────────────────────────────────────────────

document.getElementById('btn-reset').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RESET_CONVERSATION' });
  // Clear chat messages
  const chat = document.getElementById('chat-messages');
  if (chat) chat.innerHTML = '';
  addChatMessage('system', 'Conversation reset — ready');
  updateStatus('listening', 'Conversation reset — ready');
});

// ─── Listen Toggle ───────────────────────────────────────────────────────────

document.getElementById('btn-listen-toggle').addEventListener('click', toggleListening);

function toggleListening() {
  isListening = !isListening;
  const btn = document.getElementById('btn-listen-toggle');
  if (isListening) {
    btn.textContent = '\u{1F399} Listening';
    btn.classList.remove('paused');
    btn.classList.add('listening');
    btn.title = 'Pause listening (Space)';
    updateStatus('listening', 'Listening \u2014 speak to build');
    // Unmute mic at SDK level and restart heartbeat
    try { if (anamClient) anamClient.unmuteInputAudio(); } catch (e) { /* SDK may not be ready */ }
    startHeartbeat();
  } else {
    btn.textContent = '\u{23F8} Paused';
    btn.classList.remove('listening');
    btn.classList.add('paused');
    btn.title = 'Resume listening (Space)';
    updateStatus('idle', 'Paused \u2014 press Space or click to resume');
    // Mute mic, stop any ongoing avatar speech, and pause heartbeat
    try { if (anamClient) anamClient.muteInputAudio(); } catch (e) { /* SDK may not be ready */ }
    try { if (anamClient) anamClient.interruptPersona(); } catch (e) { /* may not be streaming */ }
    clearSpeechQueue();
    stopHeartbeat();
  }
}

// Space hotkey — toggle listening (only when text input is not focused)
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && document.activeElement !== document.getElementById('text-input')) {
    e.preventDefault();
    toggleListening();
  }
});

// ─── Manual Text Input ────────────────────────────────────────────────────────

document.getElementById('btn-send').addEventListener('click', sendManualInput);

document.getElementById('text-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendManualInput();
  }
});

function sendManualInput() {
  const input = document.getElementById('text-input');
  let text = input.value.trim();
  if (!text) return;
  // Enforce input length limit before sending
  if (text.length > CONFIG.MAX_SPEECH_LENGTH) {
    text = text.substring(0, CONFIG.MAX_SPEECH_LENGTH);
  }
  input.value = '';
  handleUserSpeech(text);
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function updateStatus(state, text) {
  const indicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  // Remove all status-* classes and apply the new one
  indicator.className = `status-${state}`;
  statusText.textContent = text;
}

function updateAvatarStateLabel(text) {
  document.getElementById('avatar-state-label').textContent = text;
}

function collapseAvatar(labelText) {
  const container = document.getElementById('avatar-container');
  if (container) container.classList.add('collapsed');
  updateAvatarStateLabel(labelText || 'Unavailable');
}

// ─── Chat UI ──────────────────────────────────────────────────────────────

function addChatMessage(role, text) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const msg = document.createElement('div');
  msg.className = `chat-msg ${role}`;

  // Label for each message role
  const labelMap = { assistant: 'Avatar', user: 'You', lovable: 'Lovable' };
  const labelText = labelMap[role] || '';

  if (role === 'system') {
    msg.textContent = text;
  } else {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    // Build message with DOM API instead of innerHTML to eliminate XSS vectors
    if (labelText) {
      const label = document.createElement('span');
      label.className = 'msg-label';
      label.textContent = labelText;
      msg.appendChild(label);
    }
    msg.appendChild(document.createTextNode(text));
    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    timeSpan.textContent = time;
    msg.appendChild(timeSpan);
  }

  container.appendChild(msg);

  // Keep last 50 messages
  while (container.children.length > 50) {
    container.removeChild(container.firstChild);
  }

  // Auto-scroll
  const chat = document.getElementById('chat-container');
  if (chat) {
    chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' });
  }
}


// ─── Debug Log ───────────────────────────────────────────────────────────────

function debugLog(label, data) {
  if (!CONFIG.DEBUG_LOG) return;
  const panel = document.getElementById('debug-panel');
  const log = document.getElementById('debug-log');
  if (!panel || !log) return;

  panel.style.display = 'block';
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const preview = typeof data === 'string' ? data.substring(0, 120) : JSON.stringify(data);
  log.textContent += `[${time}] ${label}: ${preview}\n`;
  log.scrollTop = log.scrollHeight;
}

// ─── Global Error Handling ───────────────────────────────────────────────────

window.addEventListener('error', (event) => {
  console.error('[FLB Panel] Uncaught error:', event.message, event.filename, event.lineno);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[FLB Panel] Unhandled promise rejection:', event.reason);
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

// Show debug panel if enabled
if (CONFIG.DEBUG_LOG) {
  const panel = document.getElementById('debug-panel');
  if (panel) panel.style.display = 'block';
}

// Show mock mode indicator
if (CONFIG.MOCK_MODE) {
  updateStatus('idle', 'MOCK MODE — no API calls');
}

// Validate Anthropic key at startup so the user knows early
if (!CONFIG.MOCK_MODE && (!CONFIG.ANTHROPIC_API_KEY || CONFIG.ANTHROPIC_API_KEY === 'YOUR_ANTHROPIC_API_KEY')) {
  updateStatus('error', 'Missing ANTHROPIC_API_KEY — update config.js');
} else {
  // Avatar is optional — text input always works.
  // If Anam key is missing/expired, skip avatar and go straight to text mode.
  if (!CONFIG.ANAM_API_KEY || CONFIG.ANAM_API_KEY === 'YOUR_ANAM_API_KEY') {
    console.log('[FLB] No Anam API key — running in text-only mode');
    collapseAvatar('Text mode');
    updateStatus('listening', 'Text mode — type below to build');
    addChatMessage('system', 'Text mode — avatar unavailable');
  } else {
    initializeAnam().catch(err => {
      // Avatar failed but text mode still works
      console.warn('[FLB] Avatar init failed, continuing in text mode:', err.message);
      collapseAvatar('Unavailable');
      updateStatus('listening', 'Text mode — type below to build');
      addChatMessage('system', 'Avatar unavailable — using text chat');
    });
  }
}
