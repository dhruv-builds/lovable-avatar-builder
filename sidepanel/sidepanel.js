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
    // CUSTOMER_CLIENT_V1 = BYO-brain mode.
    // Anam handles: avatar rendering, lip-sync, TTS, STT.
    // We handle: intelligence (Claude API via background SW).
    anamClient = AnamAI.unsafe_createClientWithApiKey(CONFIG.ANAM_API_KEY, {
      personaConfig: {
        name: 'Builder',
        avatarId: CONFIG.ANAM_AVATAR_ID,
        voiceId: CONFIG.ANAM_VOICE_ID,
        brainType: 'CUSTOMER_CLIENT_V1',
        systemPrompt: '' // Not used in CUSTOMER_CLIENT_V1 mode
      }
    });

    // ── Diagnostic: test Anam API key before SDK call ──
    try {
      const diagResp = await fetch('https://api.anam.ai/v1/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.ANAM_API_KEY}`
        },
        body: JSON.stringify({
          avatarId: CONFIG.ANAM_AVATAR_ID,
          voiceId: CONFIG.ANAM_VOICE_ID
        })
      });
      const diagBody = await diagResp.text();
      console.log('[LVB Diag] Anam session API:', diagResp.status, diagBody);
      if (!diagResp.ok) {
        updateStatus('error', `Anam API ${diagResp.status}: ${diagBody.slice(0, 80)}`);
        updateAvatarStateLabel(`API ${diagResp.status}`);
        return;
      }
    } catch (fetchErr) {
      console.error('[LVB Diag] Anam API unreachable:', fetchErr);
      updateStatus('error', 'Cannot reach Anam API: ' + fetchErr.message);
      updateAvatarStateLabel('Network error');
      return;
    }

    // Attach avatar video to the <video> element
    await anamClient.streamToVideoElement('avatar-video');

    // ── Speech recognition callbacks ──────────────────────────────────────
    // The Anam SDK may use different event names depending on version.
    // We listen for both common patterns for compatibility.

    if (typeof anamClient.on === 'function') {
      anamClient.on('speech_recognized', (transcript) => {
        const text = typeof transcript === 'string' ? transcript : transcript?.text;
        if (text && isListening) {
          handleUserSpeech(text);
        }
      });

      anamClient.on('message', (message) => {
        if (message?.type === 'user_speech' && isListening) {
          handleUserSpeech(message.text);
        }
      });

      anamClient.on('connection_established', () => {
        updateStatus('listening', 'Listening — speak to build');
        updateAvatarStateLabel('Live');
      });

      anamClient.on('connection_closed', () => {
        updateStatus('idle', 'Disconnected');
        updateAvatarStateLabel('Disconnected');
      });

      anamClient.on('error', (err) => {
        console.error('[LVB Panel] Anam SDK error:', err);
        updateStatus('error', 'Avatar error — check console');
      });
    }

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

  // Try the most common CUSTOMER_CLIENT_V1 send methods.
  // Consult https://docs.anam.ai and https://github.com/anam-org/clawd-face
  // to confirm the exact method name for your SDK version.
  try {
    if (typeof anamClient.sendMessage === 'function') {
      anamClient.sendMessage(text);
    } else if (typeof anamClient.speak === 'function') {
      anamClient.speak(text);
    } else if (typeof anamClient.streamText === 'function') {
      anamClient.streamText(text);
    } else {
      console.warn('[LVB Panel] No speak method found on anamClient — check SDK docs.');
    }
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
