// Facetime Lovable Builder — Side Panel Logic
// Handles Anam SDK initialization, speech events, and message routing.

// CONFIG is loaded from ../config.js via sidepanel.html
// AnamAI is the global provided by the Anam SDK UMD bundle
// Inline scripts are blocked by Chrome MV3 CSP — assign here instead
var AnamAI = window.anam;

// ─── State ────────────────────────────────────────────────────────────────────

let anamClient = null;
let isListening = true; // Voice capture toggle — pausing suppresses speech, text still works

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
      updateStatus('listening', 'Listening — speak to build');
      updateAvatarStateLabel('Live');
    });

    anamClient.addListener(AnamEvent.CONNECTION_CLOSED, () => {
      console.log('[FLB Panel] Connection closed');
      updateStatus('idle', 'Disconnected');
      updateAvatarStateLabel('Disconnected');
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

    updateStatus('idle', 'Avatar connected — waiting for mic…');
    updateAvatarStateLabel('Connecting mic…');

  } catch (err) {
    console.error('[FLB Panel] Failed to initialize Anam:', err);
    const msg = err?.message || err?.toString() || 'Unknown error';
    updateStatus('error', 'Avatar failed: ' + msg);
    updateAvatarStateLabel('Error: ' + msg.slice(0, 40));
  }
}

// ─── Speech Input ─────────────────────────────────────────────────────────────

let speechDebounceTimer = null;

function handleUserSpeech(text) {
  if (!text || !text.trim()) return;

  // Debounce rapid speech events (e.g. Anam SDK fires multiple times)
  clearTimeout(speechDebounceTimer);
  speechDebounceTimer = setTimeout(() => {
    console.log('[FLB Panel] User said:', text);
    debugLog('→ USER_SPEECH', text);
    updateStatus('processing', 'Thinking…');

    chrome.runtime.sendMessage({
      type: 'USER_SPEECH',
      text: text.trim()
    });
  }, 500);
}

// ─── Avatar Speech Output ──────────────────────────────────────────────────────

function speakThroughAvatar(text) {
  if (!anamClient || !text || !isListening) return;

  try {
    // SDK v4: use createTalkMessageStream for BYO-brain TTS
    const talkStream = anamClient.createTalkMessageStream();
    talkStream.streamMessageChunk(text);
    talkStream.endMessage();
  } catch (err) {
    console.error('[FLB Panel] speakThroughAvatar error:', err);
  }
}

// ─── Background SW Message Handler ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {

    case 'CLARIFICATION':
      debugLog('← CLARIFICATION', message.text);
      addChatMessage('assistant', message.text);
      speakThroughAvatar(message.text);
      updateStatus('listening', 'Waiting for your answer…');
      break;

    case 'SPEAK_RESPONSE':
      debugLog('← SPEAK_RESPONSE', message.text);
      addChatMessage('assistant', message.text);
      speakThroughAvatar(message.text);
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
    // Unmute mic at SDK level
    try { if (anamClient) anamClient.unmuteInputAudio(); } catch (e) { /* SDK may not be ready */ }
  } else {
    btn.textContent = '\u{23F8} Paused';
    btn.classList.remove('listening');
    btn.classList.add('paused');
    btn.title = 'Resume listening (Space)';
    updateStatus('idle', 'Paused \u2014 press Space or click to resume');
    // Mute mic and stop any ongoing avatar speech
    try { if (anamClient) anamClient.muteInputAudio(); } catch (e) { /* SDK may not be ready */ }
    try { if (anamClient) anamClient.interruptPersona(); } catch (e) { /* may not be streaming */ }
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
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  addChatMessage('user', text);
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

  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

  if (role === 'system') {
    msg.textContent = text;
  } else {
    msg.innerHTML =
      (labelText ? `<span class="msg-label">${labelText}</span>` : '') +
      escapeHtml(text) +
      `<span class="msg-time">${time}</span>`;
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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
