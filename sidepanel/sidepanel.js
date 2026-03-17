// Lovable Voice Builder — Side Panel Logic
// Handles Anam SDK initialization, speech events, and message routing.

// CONFIG is loaded from ../config.js via sidepanel.html
// AnamAI is the global provided by the Anam SDK UMD bundle
// Inline scripts are blocked by Chrome MV3 CSP — assign here instead
var AnamAI = window.anam;

// ─── State ────────────────────────────────────────────────────────────────────

let anamClient = null;
let isListening = true; // Toggled by Pause/Resume button

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
      console.log('[LVB] Microphone permission granted');
    } catch (micErr) {
      console.warn('[LVB] Microphone not available:', micErr.message,
        '— voice input disabled, text input still works.',
        'To fix: chrome://settings/content/microphone');
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
    console.log('[LVB] Session token API:', tokenResp.status, tokenBody);
    if (!tokenResp.ok) {
      updateStatus('error', `Anam API ${tokenResp.status}: ${tokenBody.slice(0, 100)}`);
      updateAvatarStateLabel(`API ${tokenResp.status}`);
      return;
    }
    const { sessionToken } = JSON.parse(tokenBody);
    console.log('[LVB] Session token obtained, creating client…');

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
      console.log('[LVB Panel] Connection established');
      updateStatus('listening', 'Listening — speak to build');
      updateAvatarStateLabel('Live');
    });

    anamClient.addListener(AnamEvent.CONNECTION_CLOSED, () => {
      console.log('[LVB Panel] Connection closed');
      updateStatus('idle', 'Disconnected');
      updateAvatarStateLabel('Disconnected');
    });

    anamClient.addListener(AnamEvent.MIC_PERMISSION_GRANTED, () => {
      console.log('[LVB Panel] SDK mic permission granted');
    });

    anamClient.addListener(AnamEvent.MIC_PERMISSION_DENIED, () => {
      console.warn('[LVB Panel] SDK mic permission denied');
      updateStatus('error', 'Microphone blocked by browser');
    });

    updateStatus('listening', 'Listening — speak to build');
    updateAvatarStateLabel('Live');

  } catch (err) {
    console.error('[LVB Panel] Failed to initialize Anam:', err);
    const msg = err?.message || err?.toString() || 'Unknown error';
    updateStatus('error', 'Avatar failed: ' + msg);
    updateAvatarStateLabel('Error: ' + msg.slice(0, 40));
  }
}

// ─── Speech Input ─────────────────────────────────────────────────────────────

function handleUserSpeech(text) {
  if (!text || !text.trim()) return;
  console.log('[LVB Panel] User said:', text);
  updateStatus('processing', 'Thinking…');

  chrome.runtime.sendMessage({
    type: 'USER_SPEECH',
    text: text.trim()
  });
}

// ─── Avatar Speech Output ──────────────────────────────────────────────────────

function speakThroughAvatar(text) {
  if (!anamClient || !text) return;

  try {
    // SDK v4: use createTalkMessageStream for BYO-brain TTS
    const talkStream = anamClient.createTalkMessageStream();
    talkStream.streamMessageChunk(text);
    talkStream.endMessage();
  } catch (err) {
    console.error('[LVB Panel] speakThroughAvatar error:', err);
  }
}

// ─── Background SW Message Handler ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {

    case 'CLARIFICATION':
      // Avatar asks a clarifying question
      speakThroughAvatar(message.text);
      updateStatus('listening', 'Waiting for your answer…');
      break;

    case 'SPEAK_RESPONSE':
      // Avatar narrates what Lovable replied
      speakThroughAvatar(message.text);
      updateStatus('narrating', 'Lovable is building…');
      break;

    case 'PROMPT_SENT':
      // Show the reformulated prompt that was injected into Lovable
      document.getElementById('prompt-text').textContent = message.prompt;
      updateStatus('building', 'Prompt sent — Lovable is building…');
      break;

    case 'LOVABLE_STATUS':
      if (message.status === 'idle') {
        updateStatus('listening', 'Done — ready for next instruction');
      }
      break;
  }
});

// ─── Controls ─────────────────────────────────────────────────────────────────

document.getElementById('btn-toggle').addEventListener('click', () => {
  isListening = !isListening;
  const btn = document.getElementById('btn-toggle');
  if (isListening) {
    btn.textContent = 'Pause';
    updateStatus('listening', 'Listening — speak to build');
  } else {
    btn.textContent = 'Resume';
    updateStatus('idle', 'Paused — click Resume to continue');
  }
});

document.getElementById('btn-reset').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RESET_CONVERSATION' });
  document.getElementById('prompt-text').textContent = '—';
  updateStatus('listening', 'Conversation reset — ready');
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

// ─── Boot ─────────────────────────────────────────────────────────────────────

// Validate Anthropic key at startup so the user knows early
if (!CONFIG.ANTHROPIC_API_KEY || CONFIG.ANTHROPIC_API_KEY === 'YOUR_ANTHROPIC_API_KEY') {
  updateStatus('error', 'Missing ANTHROPIC_API_KEY — update config.js');
} else {
  initializeAnam();
}
