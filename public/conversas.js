(function () {
  'use strict';

  /* ── UI refs ── */
  const ui = {
    instanceInfo:        document.getElementById('instanceInfo'),
    refreshBtn:          document.getElementById('refreshBtn'),
    searchInput:         document.getElementById('searchInput'),
    list:                document.getElementById('list'),
    noConvPlaceholder:   document.getElementById('noConvPlaceholder'),
    chatHeader:          document.getElementById('chatHeader'),
    contactProfile:      document.getElementById('contactProfile'),
    contactName:         document.getElementById('contactName'),
    contactPhone:        document.getElementById('contactPhone'),
    contactState:        document.getElementById('contactState'),
    pauseToggle:         document.getElementById('pauseToggle'),
    blockToggle:         document.getElementById('blockToggle'),
    clearContextBtn:     document.getElementById('clearContextBtn'),
    agentSettingsBtn:    document.getElementById('agentSettingsBtn'),
    messages:            document.getElementById('messages'),
    composerBar:         document.getElementById('composerBar'),
    textInput:           document.getElementById('textInput'),
    sendBtn:             document.getElementById('sendBtn'),
    attachBtn:           document.getElementById('attachBtn'),
    attachMenu:          document.getElementById('attachMenu'),
    pickDocumentBtn:     document.getElementById('pickDocumentBtn'),
    pickMediaBtn:        document.getElementById('pickMediaBtn'),
    recordBtn:           document.getElementById('recordBtn'),
    recordIcon:          document.getElementById('recordIcon'),
    mediaPreviewBar:     document.getElementById('mediaPreviewBar'),
    mediaPreviewImg:     document.getElementById('mediaPreviewImg'),
    mediaPreviewName:    document.getElementById('mediaPreviewName'),
    cancelMediaBtn:      document.getElementById('cancelMediaBtn'),
    confirmMediaBtn:     document.getElementById('confirmMediaBtn'),
    audioPreviewBar:     document.getElementById('audioPreviewBar'),
    audioPreviewPlayer:  document.getElementById('audioPreviewPlayer'),
    cancelAudioBtn:      document.getElementById('cancelAudioBtn'),
    confirmAudioBtn:     document.getElementById('confirmAudioBtn'),
    sendLocationBtn:     document.getElementById('sendLocationBtn'),
    sendPixBtn:          document.getElementById('sendPixBtn'),
    sendMenuBtn:         document.getElementById('sendMenuBtn'),
    emojiBtn:            document.getElementById('emojiBtn'),
    emojiMenu:           document.getElementById('emojiMenu'),
    fileInput:           document.getElementById('fileInput'),
    status:              document.getElementById('status'),
    agentSettingsModal:  document.getElementById('agentSettingsModal'),
    bufferSecondsInput:  document.getElementById('bufferSecondsInput'),
    greetingMessageInput:document.getElementById('greetingMessageInput'),
    closeAgentSettingsBtn:document.getElementById('closeAgentSettingsBtn'),
    saveAgentSettingsBtn: document.getElementById('saveAgentSettingsBtn'),
    clearContextModal:   document.getElementById('clearContextModal'),
    clearContextPhone:   document.getElementById('clearContextPhone'),
    cancelClearBtn:      document.getElementById('cancelClearBtn'),
    confirmClearBtn:     document.getElementById('confirmClearBtn'),
    contactInfoBtn:      document.getElementById('contactInfoBtn'),
    contactPanel:        document.getElementById('contactPanel'),
    closeContactPanel:   document.getElementById('closeContactPanel'),
    panelAvatar:         document.getElementById('panelAvatar'),
    panelName:           document.getElementById('panelName'),
    panelPhone:          document.getElementById('panelPhone'),
    panelState:          document.getElementById('panelState'),
    panelPhoneDetail:    document.getElementById('panelPhoneDetail'),
    panelStateDetail:    document.getElementById('panelStateDetail'),
    deleteConversationBtn: document.getElementById('deleteConversationBtn'),
  };

  /* ── App state ── */
  const state = {
    tenantId: 'default',
    instance: '',
    selectedPhone: '',
    selectedRemoteJid: '',
    selectedConversationKey: '',
    selectedConversation: null,
    conversations: [],
    poller: null,
    pollListBusy: false,
    pollMsgBusy: false,
    messagesLimit: 120,
    loadingMore: false,
    lastMsgSignature: '',
    recorder: null,
    recordStream: null,
    audioChunks: [],
    pendingAudioBlob: null,
    pendingAudioMime: '',
    pendingMediaFile: null,
    fileMode: 'document',
    agentSettings: { bufferWindowMs: 20000, greetingMessage: '' },
    isRecording: false,
  };

  const EMOJIS = ['😊','😂','❤️','👍','🙏','😍','😭','😅','🔥','✨','🎉','👏','😁','🤔','😢','😎','🤣','💪','🙌','😉','😋','🥰','🤗','😌','🥹','😏','🤩','😤','💯','🫡'];

  /* ══════════════════════ HELPERS ══════════════════════ */

  function escapeHtml(v) {
    return String(v || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setStatus(text, cls) {
    ui.status.textContent = text;
    ui.status.className = 'status ' + (cls || '');
  }

  function normalizeDigits(v) { return String(v || '').replace(/\D/g, ''); }

  function initialsFromConversation(conv) {
    const name = String(conv?.name || '').trim();
    if (name) {
      const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
      return parts.map(p => p[0]).join('').toUpperCase();
    }
    const d = normalizeDigits(conv?.phone || '');
    return d.slice(-2) || '';
  }

  function displayName(conv) {
    const name = String(conv?.name || '').trim();
    if (name) return name;
    return String(conv?.phone || '').trim() || 'Sem nome';
  }

  const personIconSvg = `<svg viewBox="0 0 24 24" width="22" height="22" fill="#aab8c0"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>`;

  function renderAvatar(el, conv) {
    if (!el) return;
    const url = String(conv?.avatarUrl || '').trim();
    if (url) { el.innerHTML = `<img src="${escapeHtml(url)}" alt="avatar" />`; return; }
    const initials = initialsFromConversation(conv);
    if (initials) { el.textContent = initials; }
    else           { el.innerHTML = personIconSvg; }
  }

  function formatListDate(iso) {
    if (!iso) return '';
    const dt = new Date(iso);
    if (isNaN(dt)) return '';
    const now = new Date();
    if (dt.toDateString() === now.toDateString())
      return dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  function formatBubbleTime(iso) {
    if (!iso) return '';
    const dt = new Date(iso);
    if (isNaN(dt)) return '';
    return dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function closeMenus() {
    ui.attachMenu.classList.remove('open');
    ui.emojiMenu.classList.remove('open');
  }

  function isNearBottom(el) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function msgSignature(msgs) {
    if (!Array.isArray(msgs) || !msgs.length) return 'empty';
    const last = msgs[msgs.length - 1] || {};
    const first = msgs[0] || {};
    return `${msgs.length}|${first.at || ''}|${last.at || ''}|${String(last.content || '').slice(0, 60)}`;
  }

  /* ── Build single message bubble ── */
  function buildMsgNode(message) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const safeText = escapeHtml(message.content || '');
    const node = document.createElement('div');
    node.className = `msg ${role}`;
    node.innerHTML = `<div class="bubble">${safeText}<div class="at">${escapeHtml(formatBubbleTime(message.at))}</div></div>`;
    return node;
  }

  /* ── Show/hide conversation view ── */
  function showConversationView(show) {
    ui.noConvPlaceholder.style.display = show ? 'none' : 'flex';
    ui.chatHeader.style.display        = show ? 'flex' : 'none';
    ui.messages.style.display          = show ? 'block' : 'none';
    ui.composerBar.style.display       = show ? 'flex' : 'none';
    if (!show) ui.contactPanel.classList.remove('open');
  }

  /* ── Contact side panel ── */
  function openContactPanel() {
    const conv = state.selectedConversation || {};
    const name = displayName(conv);
    const phone = state.selectedPhone || conv.phone || '—';
    const convState = ui.contactState.textContent || '—';

    ui.panelName.textContent = name;
    ui.panelPhone.textContent = phone;
    ui.panelPhoneDetail.textContent = phone;
    ui.panelStateDetail.textContent = convState;
    ui.panelState.textContent = '';

    // Render avatar
    renderAvatar(ui.panelAvatar, conv);

    ui.contactPanel.classList.add('open');

    // Try to fetch profile picture if not already set
    if (!conv.avatarUrl && phone && phone !== '—') {
      fetch(`/api/ana/profile-picture?tenant_id=${encodeURIComponent(state.tenantId)}&instance=${encodeURIComponent(state.instance)}&phone=${encodeURIComponent(phone)}`)
        .then(r => r.ok ? r.json() : {})
        .then(data => {
          const url = (data?.url || '').trim();
          if (url && state.selectedConversation) {
            state.selectedConversation.avatarUrl = url;
            renderAvatar(ui.panelAvatar, state.selectedConversation);
            renderAvatar(ui.contactProfile, state.selectedConversation);
            renderList();
          }
        })
        .catch(() => {});
    }
  }

  function closeContactPanel() {
    ui.contactPanel.classList.remove('open');
  }

  /* ══════════════════════ API ══════════════════════ */

  async function fetchJson(url, init) {
    const res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  /* ══════════════════════ DATA LOADING ══════════════════════ */

  async function loadDefaultInstance() {
    try {
      const data = await fetchJson('/api/ana/default-instance?tenant_id=default');
      state.tenantId = data.tenantId || 'default';
      state.instance = data.instance || '';
    } catch (_) {
      state.tenantId = 'default';
      state.instance = '';
    }
    ui.instanceInfo.textContent = `Instância: ${state.instance || '(não definida)'}`;
  }

  async function loadAgentSettings() {
    try {
      const data = await fetchJson(`/api/ana/agent-settings?tenant_id=${encodeURIComponent(state.tenantId)}`);
      if (data?.settings) state.agentSettings = data.settings;
    } catch (_) {}
  }

  async function loadConversations() {
    const search = encodeURIComponent((ui.searchInput.value || '').trim());
    const data = await fetchJson(
      `/api/ana/conversations?tenant_id=${encodeURIComponent(state.tenantId)}&instance=${encodeURIComponent(state.instance)}&limit=120&search=${search}`
    );
    if (data.instance && data.instance !== state.instance) {
      state.instance = data.instance;
      ui.instanceInfo.textContent = `Instância: ${state.instance || '(não definida)'}`;
    }
    state.conversations = data.conversations || [];
    if (state.selectedConversationKey) {
      const found = state.conversations.find(c => String(c.phone || c.remoteJid || '') === state.selectedConversationKey);
      if (found) {
        state.selectedConversation = found;
        state.selectedPhone = found.phone || state.selectedPhone;
        state.selectedRemoteJid = found.remoteJid || state.selectedRemoteJid;
      } else {
        // conversation no longer exists → deselect
        state.selectedPhone = '';
        state.selectedRemoteJid = '';
        state.selectedConversationKey = '';
        state.selectedConversation = null;
        state.lastMsgSignature = '';
        showConversationView(false);
      }
    }
    renderList();
  }

  async function loadControls() {
    if (!state.selectedPhone) return;
    try {
      const c = await fetchJson(
        `/api/ana/contact-control?tenant_id=${encodeURIComponent(state.tenantId)}&instance=${encodeURIComponent(state.instance)}&phone=${encodeURIComponent(state.selectedPhone)}`
      );
      ui.pauseToggle.disabled = false;
      ui.blockToggle.disabled = false;
      ui.pauseToggle.checked = Boolean(c?.control?.paused);
      ui.blockToggle.checked = Boolean(c?.control?.blocked);
    } catch (_) {}
  }

  /*
   * loadMessages — SCROLL FIX
   * - forceScroll=true  → full redraw + scroll to bottom (use when selecting a new conversation)
   * - forceRender=true  → full redraw, preserve position (use when loading more history)
   * - no options        → INCREMENTAL: only appends new messages, never resets scroll position
   *                       This prevents the scroll-reset bug when the user reads history
   */
  async function loadMessages(options = {}) {
    if (!state.selectedPhone) return;

    const sel = state.selectedConversation || { phone: state.selectedPhone, remoteJid: state.selectedRemoteJid };
    renderAvatar(ui.contactProfile, sel);
    ui.contactName.textContent = displayName(sel);
    ui.contactPhone.textContent = state.selectedPhone || '—';

    const [msgData, sessionData] = await Promise.all([
      fetchJson(
        `/api/ana/messages?tenant_id=${encodeURIComponent(state.tenantId)}&instance=${encodeURIComponent(state.instance)}&phone=${encodeURIComponent(state.selectedPhone)}&remoteJid=${encodeURIComponent(state.selectedRemoteJid || '')}&limit=${state.messagesLimit}`
      ),
      fetchJson(
        `/api/ana/session?tenant_id=${encodeURIComponent(state.tenantId)}&instance=${encodeURIComponent(state.instance)}&phone=${encodeURIComponent(state.selectedPhone)}`
      ).catch(() => ({})),
    ]);

    if (msgData?.remoteJid) {
      state.selectedRemoteJid = msgData.remoteJid;
      if (state.selectedConversation) state.selectedConversation.remoteJid = msgData.remoteJid;
    }
    if (msgData?.avatarUrl && state.selectedConversation) state.selectedConversation.avatarUrl = msgData.avatarUrl;
    if (msgData?.name && state.selectedConversation) state.selectedConversation.name = msgData.name;

    const convState = sessionData?.state || '';
    ui.contactState.textContent = convState ? `Estado: ${convState} | Instância: ${state.instance || '—'}` : '';

    const messages = Array.isArray(msgData?.messages) ? msgData.messages : [];
    const sig = msgSignature(messages);

    // Nothing changed and no force → skip completely (user is scrolling history freely)
    if (!options.forceRender && !options.forceScroll && sig === state.lastMsgSignature) return;

    const existingCount = ui.messages.querySelectorAll('.msg').length;
    const wasNearBottom = isNearBottom(ui.messages);

    if (options.forceScroll || options.forceRender || existingCount === 0 || messages.length < existingCount) {
      // Full rebuild
      const oldScrollTop = ui.messages.scrollTop;
      const oldHeight    = ui.messages.scrollHeight;

      ui.messages.innerHTML = '';
      messages.forEach(m => ui.messages.appendChild(buildMsgNode(m)));

      if (options.forceScroll) {
        ui.messages.scrollTop = ui.messages.scrollHeight;
      } else if (wasNearBottom) {
        ui.messages.scrollTop = ui.messages.scrollHeight;
      } else if (options.forceRender) {
        // Loading older history: keep relative position
        const newHeight = ui.messages.scrollHeight;
        ui.messages.scrollTop = Math.max(0, oldScrollTop + (newHeight - oldHeight));
      }
    } else if (messages.length > existingCount) {
      // ── INCREMENTAL APPEND ──
      // Only add the new messages at the end.
      // If user is scrolled up reading history → DON'T touch scrollTop at all.
      const toAdd = messages.slice(existingCount);
      toAdd.forEach(m => ui.messages.appendChild(buildMsgNode(m)));
      if (wasNearBottom) {
        ui.messages.scrollTop = ui.messages.scrollHeight;
      }
      // else: user is reading history, leave scroll position untouched ✓
    }

    state.lastMsgSignature = sig;
  }

  async function pollSelectedMessages() {
    if (!state.selectedPhone || state.pollMsgBusy) return;
    state.pollMsgBusy = true;
    try { await loadMessages(); }
    catch (e) { setStatus(`Erro ao sincronizar: ${e.message}`, 'err'); }
    finally   { state.pollMsgBusy = false; }
  }

  /* ══════════════════════ ACTIONS ══════════════════════ */

  async function updateControl(patch) {
    if (!state.selectedPhone) return;
    await fetchJson('/api/ana/contact-control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: state.tenantId,
        instance: state.instance || null,
        phone: state.selectedPhone,
        ...patch,
      }),
    });
    setStatus('Controle atualizado.', 'ok');
  }

  async function saveAgentSettings() {
    const secs = Number(ui.bufferSecondsInput.value || 20);
    const msg  = String(ui.greetingMessageInput.value || '').trim();
    const body = {
      tenant_id: state.tenantId,
      bufferWindowMs: Math.max(3, Math.min(120, secs)) * 1000,
      greetingMessage: msg,
    };
    const data = await fetchJson('/api/ana/agent-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (data?.settings) state.agentSettings = data.settings;
    setStatus('Configurações salvas.', 'ok');
    ui.agentSettingsModal.classList.remove('open');
  }

  async function clearContextAndMemory() {
    if (!state.selectedPhone) return;
    await fetchJson('/api/ana/conversation/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: state.tenantId, phone: state.selectedPhone }),
    });
    ui.clearContextModal.classList.remove('open');
    state.lastMsgSignature = '';
    setStatus('Contexto e memória do cliente limpos.', 'ok');
    await loadConversations();
    await loadMessages({ forceScroll: true, forceRender: true });
  }

  async function sendText(text) {
    if (!state.selectedPhone) { setStatus('Selecione uma conversa.', 'warn'); return; }
    const content = String(text || ui.textInput.value || '').trim();
    if (!content) return;
    await fetchJson('/api/ana/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: state.tenantId,
        instance: state.instance || null,
        phone: state.selectedPhone,
        remoteJid: state.selectedRemoteJid || null,
        text: content,
      }),
    });
    ui.textInput.value = '';
    ui.textInput.style.height = 'auto';
    setStatus('Mensagem enviada.', 'ok');
    await loadConversations();
    await loadMessages({ forceScroll: true, forceRender: true });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const r = String(fr.result || '');
        resolve(r.includes(',') ? r.split(',')[1] : r);
      };
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  async function sendFile(file, mediaKindOverride) {
    if (!state.selectedPhone) { setStatus('Selecione uma conversa.', 'warn'); return; }
    const base64    = await fileToBase64(file);
    const mediaKind = mediaKindOverride || state.fileMode || 'document';
    await fetchJson('/api/ana/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: state.tenantId,
        instance: state.instance || null,
        phone: state.selectedPhone,
        remoteJid: state.selectedRemoteJid || null,
        mediaBase64: base64,
        mimeType: file.type || 'application/octet-stream',
        fileName: file.name || 'arquivo',
        mediaKind,
        caption: (ui.textInput.value || '').trim(),
      }),
    });
    setStatus('Mídia enviada.', 'ok');
    await loadConversations();
    await loadMessages({ forceScroll: true, forceRender: true });
  }

  /* ── Audio recording ── */
  function pickRecordMime() {
    const candidates = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (const m of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  function extFromMime(mime) {
    if (mime.includes('ogg'))  return 'ogg';
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('mp4'))  return 'mp4';
    return 'webm';
  }

  function setRecordingState(recording) {
    state.isRecording = recording;
    ui.recordBtn.classList.toggle('recording', recording);
    ui.recordBtn.title = recording ? 'Parar gravação' : 'Gravar áudio';
  }

  async function toggleRecording() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('Gravação de áudio não suportada neste navegador.', 'err');
      return;
    }
    if (state.recorder && state.recorder.state === 'recording') {
      state.recorder.stop();
      return;
    }
    try {
      state.recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setStatus(`Permissão de microfone negada: ${e.message}`, 'err');
      return;
    }
    const mimeType = pickRecordMime();
    state.audioChunks = [];
    try {
      state.recorder = mimeType
        ? new MediaRecorder(state.recordStream, { mimeType })
        : new MediaRecorder(state.recordStream);
    } catch (e) {
      setStatus(`Não foi possível iniciar a gravação: ${e.message}`, 'err');
      state.recordStream.getTracks().forEach(t => t.stop());
      state.recordStream = null;
      return;
    }

    state.recorder.ondataavailable = (evt) => {
      if (evt.data && evt.data.size > 0) state.audioChunks.push(evt.data);
    };

    state.recorder.onstop = () => {
      setRecordingState(false);
      if (state.recordStream) {
        state.recordStream.getTracks().forEach(t => t.stop());
        state.recordStream = null;
      }
      const mime = state.recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(state.audioChunks, { type: mime });
      if (!blob.size) { setStatus('Gravação vazia.', 'warn'); return; }
      state.pendingAudioBlob = blob;
      state.pendingAudioMime = mime;
      const objUrl = URL.createObjectURL(blob);
      ui.audioPreviewPlayer.src = objUrl;
      ui.audioPreviewBar.style.display = 'flex';
      setStatus('Áudio gravado. Ouça e confirme para enviar.', 'ok');
    };

    state.recorder.start(200); // timeslice de 200ms garante ondataavailable
    setRecordingState(true);
    setStatus('Gravando áudio... clique em ⏹ Parar para enviar.', 'warn');
    closeMenus();
  }

  async function sendLocationPrompt() {
    if (!state.selectedPhone) return setStatus('Selecione uma conversa.', 'warn');
    try {
      const data = await fetchJson(`/api/ana/mcp/company-data?tenant_id=${encodeURIComponent(state.tenantId)}`);
      const address = String(data?.company?.address || '').trim();
      if (address) {
        const mapsLink = `https://maps.google.com/?q=${encodeURIComponent(address)}`;
        await sendText(`📍 *Endereço:* ${address}\n🔗 ${mapsLink}`);
        return;
      }
    } catch (_) { /* fallback para prompt manual */ }
    const loc = window.prompt('Endereço não encontrado. Informe manualmente (ex: Rua das Flores, 123, Centro):');
    if (!loc) return;
    await sendText(`📍 Localização: ${loc}`);
  }

  async function sendPixPrompt() {
    if (!state.selectedPhone) return setStatus('Selecione uma conversa.', 'warn');
    const key = window.prompt('Informe a chave Pix:');
    if (!key) return;
    const amount = window.prompt('Valor (opcional, ex: R$ 35,00):') || '';
    await sendText(`💳 Pix\nChave: ${key}${amount ? `\nValor: ${amount}` : ''}`);
  }

  async function sendMenuShortcut() {
    if (!state.selectedPhone) return setStatus('Selecione uma conversa.', 'warn');
    await sendText('📋 Cardápio');
  }

  /* ══════════════════════ RENDERING ══════════════════════ */

  function renderEmojiMenu() {
    ui.emojiMenu.innerHTML = '';
    for (const emoji of EMOJIS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-item';
      btn.textContent = emoji;
      btn.onclick = () => {
        ui.textInput.value += emoji;
        ui.textInput.focus();
        ui.textInput.dispatchEvent(new Event('input'));
      };
      ui.emojiMenu.appendChild(btn);
    }
  }

  function renderList() {
    ui.list.innerHTML = '';
    for (const conv of state.conversations) {
      const rowKey = String(conv.phone || conv.remoteJid || '');
      const item = document.createElement('div');
      item.className = 'conv-item' + (state.selectedConversationKey === rowKey ? ' active' : '');

      // Avatar
      const avEl = document.createElement('div');
      avEl.className = 'conv-av';
      if (conv.avatarUrl) {
        avEl.innerHTML = `<img src="${escapeHtml(conv.avatarUrl)}" alt="avatar" />`;
      } else {
        const initials = initialsFromConversation(conv);
        if (initials) avEl.textContent = initials;
        else avEl.innerHTML = personIconSvg;
      }

      // Body
      const body = document.createElement('div');
      body.className = 'conv-body';
      body.innerHTML = `
        <div class="conv-row">
          <div class="conv-name">${escapeHtml(displayName(conv))}</div>
          <div class="conv-time">${escapeHtml(formatListDate(conv.lastActivityAt))}</div>
        </div>
        <div class="conv-preview">${escapeHtml((conv?.lastMessage?.content || '').slice(0, 100))}</div>
      `;

      item.appendChild(avEl);
      item.appendChild(body);

      item.onclick = async () => {
        closeMenus();
        state.selectedPhone           = conv.phone;
        state.selectedRemoteJid       = conv.remoteJid || `${conv.phone}@s.whatsapp.net`;
        state.selectedConversationKey = rowKey;
        state.selectedConversation    = conv;
        state.messagesLimit           = 120;
        state.lastMsgSignature        = '';

        showConversationView(true);
        ui.clearContextBtn.style.display = 'inline-flex';
        renderList();
        await loadControls();
        await loadMessages({ forceScroll: true });
      };

      ui.list.appendChild(item);
    }
  }

  /* ══════════════════════ EVENTS ══════════════════════ */

  function bindEvents() {

    /* Refresh button */
    ui.refreshBtn.onclick = () => {
      loadConversations()
        .then(() => setStatus('Lista atualizada.', 'ok'))
        .catch(e => setStatus(e.message, 'err'));
    };

    /* Search */
    ui.searchInput.oninput = () => loadConversations().catch(e => setStatus(e.message, 'err'));

    /* Pause / Block toggles */
    ui.pauseToggle.onchange = () => {
      updateControl({ paused: ui.pauseToggle.checked }).catch(e => setStatus(e.message, 'err'));
      setStatus(ui.pauseToggle.checked ? 'Agente Ana desabilitada para este contato.' : 'Agente Ana reativada.', 'warn');
    };
    ui.blockToggle.onchange = () => {
      updateControl({ blocked: ui.blockToggle.checked }).catch(e => setStatus(e.message, 'err'));
    };

    /* Contact info panel */
    ui.contactInfoBtn.onclick = () => openContactPanel();
    ui.closeContactPanel.onclick = () => closeContactPanel();
    ui.deleteConversationBtn.onclick = () => {
      if (!state.selectedPhone) return;
      const label = displayName(state.selectedConversation || { phone: state.selectedPhone });
      if (!confirm(`Excluir a conversa de ${label}? Esta ação vai limpar o contexto e a memória do contato.`)) return;
      closeContactPanel();
      clearContextAndMemory().catch(e => setStatus(e.message, 'err'));
    };

    /* Clear context */
    ui.clearContextBtn.onclick = () => {
      if (!state.selectedPhone) return;
      const label = displayName(state.selectedConversation || { phone: state.selectedPhone });
      ui.clearContextPhone.textContent = `Contato: ${label}`;
      ui.clearContextModal.classList.add('open');
    };
    ui.cancelClearBtn.onclick  = () => ui.clearContextModal.classList.remove('open');
    ui.confirmClearBtn.onclick = () => clearContextAndMemory().catch(e => setStatus(e.message, 'err'));
    ui.clearContextModal.onclick = e => { if (e.target === ui.clearContextModal) ui.clearContextModal.classList.remove('open'); };

    /* Agent settings */
    ui.agentSettingsBtn.onclick = () => {
      ui.bufferSecondsInput.value   = Math.max(3, Math.round(Number(state.agentSettings.bufferWindowMs || 20000) / 1000));
      ui.greetingMessageInput.value = String(state.agentSettings.greetingMessage || '');
      ui.agentSettingsModal.classList.add('open');
    };
    ui.closeAgentSettingsBtn.onclick = () => ui.agentSettingsModal.classList.remove('open');
    ui.saveAgentSettingsBtn.onclick  = () => saveAgentSettings().catch(e => setStatus(e.message, 'err'));
    ui.agentSettingsModal.onclick = e => { if (e.target === ui.agentSettingsModal) ui.agentSettingsModal.classList.remove('open'); };

    /* Send */
    ui.sendBtn.onclick = () => sendText().catch(e => setStatus(e.message, 'err'));
    ui.textInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendText().catch(err => setStatus(err.message, 'err'));
      }
    });

    /* Textarea auto-resize */
    ui.textInput.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 200) + 'px';
    });

    /* Attachment / emoji toggles */
    ui.attachBtn.onclick = () => {
      ui.emojiMenu.classList.remove('open');
      ui.attachMenu.classList.toggle('open');
    };
    ui.emojiBtn.onclick = () => {
      ui.attachMenu.classList.remove('open');
      ui.emojiMenu.classList.toggle('open');
    };

    /* Attach-menu items */
    ui.pickDocumentBtn.onclick = () => {
      state.fileMode = 'document';
      ui.fileInput.accept = '.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip,.rar,application/*';
      ui.fileInput.click();
      closeMenus();
    };
    ui.pickMediaBtn.onclick = () => {
      state.fileMode = 'image';
      ui.fileInput.accept = 'image/*,video/*';
      ui.fileInput.click();
      closeMenus();
    };
    ui.recordBtn.onclick     = () => toggleRecording().catch(e => setStatus(e.message, 'err'));
    ui.sendLocationBtn.onclick = () => { closeMenus(); sendLocationPrompt().catch(e => setStatus(e.message, 'err')); };
    ui.sendPixBtn.onclick      = () => { closeMenus(); sendPixPrompt().catch(e => setStatus(e.message, 'err')); };
    ui.sendMenuBtn.onclick     = () => { closeMenus(); sendMenuShortcut().catch(e => setStatus(e.message, 'err')); };

    /* File input — imagem mostra preview, documento envia direto */
    ui.fileInput.onchange = () => {
      const file = ui.fileInput.files?.[0];
      if (!file) return;
      ui.fileInput.value = '';
      if (state.fileMode === 'image' && file.type.startsWith('image/')) {
        state.pendingMediaFile = file;
        const objUrl = URL.createObjectURL(file);
        ui.mediaPreviewImg.src = objUrl;
        ui.mediaPreviewName.textContent = file.name;
        ui.mediaPreviewBar.style.display = 'flex';
        setStatus('Imagem selecionada. Confirme para enviar.', 'ok');
      } else {
        sendFile(file).catch(e => setStatus(e.message, 'err'));
      }
    };

    /* Preview de mídia (imagem) */
    ui.cancelMediaBtn.onclick = () => {
      state.pendingMediaFile = null;
      ui.mediaPreviewImg.src = '';
      ui.mediaPreviewBar.style.display = 'none';
      setStatus('Envio cancelado.', '');
    };
    ui.confirmMediaBtn.onclick = () => {
      const file = state.pendingMediaFile;
      if (!file) return;
      state.pendingMediaFile = null;
      ui.mediaPreviewBar.style.display = 'none';
      sendFile(file, 'image').catch(e => setStatus(e.message, 'err'));
    };

    /* Preview de áudio */
    ui.cancelAudioBtn.onclick = () => {
      state.pendingAudioBlob = null;
      state.pendingAudioMime = '';
      if (ui.audioPreviewPlayer.src) URL.revokeObjectURL(ui.audioPreviewPlayer.src);
      ui.audioPreviewPlayer.src = '';
      ui.audioPreviewBar.style.display = 'none';
      setStatus('Gravação descartada.', '');
    };
    ui.confirmAudioBtn.onclick = () => {
      const blob = state.pendingAudioBlob;
      const mime = state.pendingAudioMime || 'audio/webm';
      if (!blob) return;
      state.pendingAudioBlob = null;
      state.pendingAudioMime = '';
      if (ui.audioPreviewPlayer.src) URL.revokeObjectURL(ui.audioPreviewPlayer.src);
      ui.audioPreviewPlayer.src = '';
      ui.audioPreviewBar.style.display = 'none';
      const ext  = extFromMime(mime);
      const file = new File([blob], `audio-${Date.now()}.${ext}`, { type: mime });
      sendFile(file, 'audio').catch(e => setStatus(e.message, 'err'));
    };

    /* Load-more history when scrolled to top */
    ui.messages.addEventListener('scroll', () => {
      if (!state.selectedPhone || state.loadingMore) return;
      if (ui.messages.scrollTop > 80) return;
      if (state.messagesLimit >= 300) return;
      state.loadingMore = true;
      state.messagesLimit = Math.min(300, state.messagesLimit + 80);
      loadMessages({ forceRender: true, forceScroll: false })
        .catch(e => setStatus(e.message, 'err'))
        .finally(() => { state.loadingMore = false; });
    });

    /* Close menus on outside click */
    document.addEventListener('click', e => {
      const inAttach = e.target === ui.attachBtn || ui.attachBtn.contains(e.target) || ui.attachMenu.contains(e.target);
      const inEmoji  = e.target === ui.emojiBtn  || ui.emojiBtn.contains(e.target)  || ui.emojiMenu.contains(e.target);
      if (!inAttach) ui.attachMenu.classList.remove('open');
      if (!inEmoji)  ui.emojiMenu.classList.remove('open');
    });
  }

  /* ══════════════════════ BOOT ══════════════════════ */

  async function boot() {
    try {
      showConversationView(false);
      renderEmojiMenu();
      bindEvents();
      await loadDefaultInstance();
      await loadAgentSettings();
      await loadConversations();
      setStatus('Inbox pronta. Conversas ativas sincronizadas.', 'ok');

      if (state.poller) clearInterval(state.poller);
      state.poller = setInterval(() => {
        if (!state.pollListBusy) {
          state.pollListBusy = true;
          loadConversations()
            .catch(e => setStatus(e.message, 'err'))
            .finally(() => { state.pollListBusy = false; });
        }
        pollSelectedMessages();
      }, 3000);
    } catch (err) {
      setStatus(`Erro ao iniciar: ${err.message}`, 'err');
    }
  }

  boot();
})();
