(function () {
  const ui = {
    appRoot: document.querySelector('.app'),
    instanceInfo: document.getElementById('instanceInfo'),
    refreshBtn: document.getElementById('refreshBtn'),
    searchInput: document.getElementById('searchInput'),
    list: document.getElementById('list'),
    contactAvatar: document.getElementById('contactAvatar'),
    contactName: document.getElementById('contactName'),
    contactState: document.getElementById('contactState'),
    pauseToggle: document.getElementById('pauseToggle'),
    blockToggle: document.getElementById('blockToggle'),
    messages: document.getElementById('messages'),
    textInput: document.getElementById('textInput'),
    sendBtn: document.getElementById('sendBtn'),
    attachBtn: document.getElementById('attachBtn'),
    recordBtn: document.getElementById('recordBtn'),
    fileInput: document.getElementById('fileInput'),
    status: document.getElementById('status'),
    infoAvatar: document.getElementById('infoAvatar'),
    infoName: document.getElementById('infoName'),
    infoPhone: document.getElementById('infoPhone'),
    infoInstance: document.getElementById('infoInstance'),
    infoState: document.getElementById('infoState'),
  };

  const state = {
    tenantId: 'default',
    instance: '',
    selectedPhone: '',
    selectedRemoteJid: '',
    conversations: [],
    recorder: null,
    audioChunks: [],
    poller: null,
  };

  function syncContactPanelVisibility() {
    if (!ui.appRoot) return;
    const hasSelection = Boolean(state.selectedPhone);
    ui.appRoot.classList.toggle('contact-selected', hasSelection);
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setStatus(text, cls) {
    ui.status.textContent = text;
    ui.status.className = `status ${cls || ''}`;
  }

  function initialsFromPhone(phone) {
    const clean = String(phone || '').replace(/\D/g, '');
    return clean.slice(-2) || '--';
  }

  function formatTime(iso) {
    if (!iso) return '';
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  async function fetchJson(url, init) {
    const response = await fetch(url, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
  }

  async function loadDefaultInstance() {
    try {
      const data = await fetchJson('/api/ana/default-instance?tenant_id=default');
      state.tenantId = data.tenantId || 'default';
      state.instance = data.instance || '';
      if (data.configuredInstance && data.configuredInstance !== data.instance) {
        setStatus(`Instância configurada (${data.configuredInstance}) indisponível. Usando ${data.instance}.`, 'warn');
      }
    } catch (_) {
      state.tenantId = 'default';
      state.instance = '';
    }
    ui.instanceInfo.textContent = `Instância padrão: ${state.instance || '(não definida)'}`;
    ui.infoInstance.textContent = state.instance || '-';
  }

  function renderList() {
    syncContactPanelVisibility();
    ui.list.innerHTML = '';
    for (const conversation of state.conversations) {
      const item = document.createElement('div');
      item.className = `item ${state.selectedPhone === conversation.phone ? 'active' : ''}`;
      const preview = escapeHtml((conversation.lastMessage && conversation.lastMessage.content) || 'Sem mensagens');
      item.innerHTML = `
        <div class="avatar">${initialsFromPhone(conversation.phone)}</div>
        <div>
          <div class="name">${escapeHtml(conversation.phone)}</div>
          <div class="preview">${preview}</div>
        </div>
        <div class="time">${formatTime(conversation.lastActivityAt)}</div>
      `;
      item.onclick = async function () {
        state.selectedPhone = conversation.phone;
        state.selectedRemoteJid = conversation.remoteJid || `${conversation.phone}@s.whatsapp.net`;
        renderList();
        await loadControls();
        await loadMessages();
      };
      ui.list.appendChild(item);
    }
  }

  async function loadConversations() {
    const search = encodeURIComponent((ui.searchInput.value || '').trim());
    const data = await fetchJson(`/api/ana/conversations?tenant_id=${encodeURIComponent(state.tenantId)}&instance=${encodeURIComponent(state.instance)}&limit=50&search=${search}`);

    if (data.instance && data.instance !== state.instance) {
      state.instance = data.instance;
      ui.instanceInfo.textContent = `Instância padrão: ${state.instance || '(não definida)'}`;
      ui.infoInstance.textContent = state.instance || '-';
    }

    state.conversations = data.conversations || [];
    if (state.selectedPhone && !state.conversations.some((c) => c.phone === state.selectedPhone)) {
      state.selectedPhone = '';
      state.selectedRemoteJid = '';
    }

    renderList();

    if (state.selectedPhone) {
      await loadControls();
      await loadMessages();
    } else {
      ui.messages.innerHTML = '';
      ui.contactAvatar.textContent = '--';
      ui.contactName.textContent = 'Selecione uma conversa';
      ui.contactState.textContent = 'Sem contato selecionado';
      ui.infoAvatar.textContent = '--';
      ui.infoName.textContent = 'Sem contato';
      ui.infoPhone.textContent = 'Selecione uma conversa para visualizar os dados.';
      ui.infoState.textContent = '-';
      syncContactPanelVisibility();
    }
  }

  async function loadControls() {
    if (!state.selectedPhone) return;
    const c = await fetchJson(`/api/ana/contact-control?tenant_id=${encodeURIComponent(state.tenantId)}&instance=${encodeURIComponent(state.instance)}&phone=${encodeURIComponent(state.selectedPhone)}`);
    ui.pauseToggle.checked = !!(c.control && c.control.paused);
    ui.blockToggle.checked = !!(c.control && c.control.blocked);
  }

  async function loadMessages() {
    if (!state.selectedPhone) return;

    const msgData = await fetchJson(`/api/ana/messages?tenant_id=${encodeURIComponent(state.tenantId)}&instance=${encodeURIComponent(state.instance)}&phone=${encodeURIComponent(state.selectedPhone)}&limit=80`);
    const sessionData = await fetchJson(`/api/ana/session?tenant_id=${encodeURIComponent(state.tenantId)}&instance=${encodeURIComponent(state.instance)}&phone=${encodeURIComponent(state.selectedPhone)}`);

    const conversationState = (sessionData && sessionData.state) || 'INIT';
    const phone = state.selectedPhone;
    const initials = initialsFromPhone(phone);

    ui.contactAvatar.textContent = initials;
    ui.contactName.textContent = phone;
    ui.contactState.textContent = `Estado: ${conversationState} | Instância: ${state.instance || '-'}`;

    ui.infoAvatar.textContent = initials;
    ui.infoName.textContent = phone;
    ui.infoPhone.textContent = phone;
    ui.infoInstance.textContent = state.instance || '-';
    ui.infoState.textContent = conversationState;

    const messages = msgData.messages || [];
    ui.messages.innerHTML = '';

    for (const message of messages) {
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const safeText = escapeHtml(message.content || '');
      const el = document.createElement('div');
      el.className = `msg ${role}`;
      el.innerHTML = `<div class="bubble">${safeText}<div class="at">${formatTime(message.at)}</div></div>`;
      ui.messages.appendChild(el);
    }

    ui.messages.scrollTop = ui.messages.scrollHeight;
  }

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

  async function sendText() {
    if (!state.selectedPhone) {
      setStatus('Selecione uma conversa.', 'warn');
      return;
    }
    const text = (ui.textInput.value || '').trim();
    if (!text) return;

    await fetchJson('/api/ana/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: state.tenantId,
        instance: state.instance || null,
        phone: state.selectedPhone,
        text,
      }),
    });

    ui.textInput.value = '';
    setStatus('Mensagem enviada.', 'ok');
    await loadConversations();
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = function () {
        const dataUrl = String(fr.result || '');
        resolve(dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl);
      };
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  async function sendFile(file) {
    if (!state.selectedPhone) {
      setStatus('Selecione uma conversa.', 'warn');
      return;
    }

    const base64 = await fileToBase64(file);
    await fetchJson('/api/ana/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: state.tenantId,
        instance: state.instance || null,
        phone: state.selectedPhone,
        mediaBase64: base64,
        mimeType: file.type || 'application/octet-stream',
        fileName: file.name || 'arquivo.bin',
        caption: (ui.textInput.value || '').trim(),
      }),
    });

    setStatus('Arquivo/mídia enviado.', 'ok');
    await loadConversations();
  }

  async function toggleRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('Gravação não suportada.', 'err');
      return;
    }

    if (state.recorder && state.recorder.state === 'recording') {
      state.recorder.stop();
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.audioChunks = [];
    state.recorder = new MediaRecorder(stream);

    state.recorder.ondataavailable = function (evt) {
      if (evt.data && evt.data.size > 0) state.audioChunks.push(evt.data);
    };

    state.recorder.onstop = async function () {
      try {
        ui.recordBtn.textContent = 'Gravar';
        const blob = new Blob(state.audioChunks, { type: state.recorder.mimeType || 'audio/webm' });
        const file = new File([blob], `audio-${Date.now()}.webm`, { type: blob.type || 'audio/webm' });
        await sendFile(file);
      } catch (err) {
        setStatus(`Falha no envio de áudio: ${err.message}`, 'err');
      } finally {
        stream.getTracks().forEach((track) => track.stop());
      }
    };

    state.recorder.start();
    ui.recordBtn.textContent = 'Parar';
    setStatus('Gravando áudio... clique novamente para parar.', 'warn');
  }

  ui.refreshBtn.onclick = function () {
    loadConversations()
      .then(() => setStatus('Atualizado.', 'ok'))
      .catch((e) => setStatus(e.message, 'err'));
  };

  ui.searchInput.oninput = function () {
    loadConversations().catch((e) => setStatus(e.message, 'err'));
  };

  ui.pauseToggle.onchange = function () {
    updateControl({ paused: ui.pauseToggle.checked }).catch((e) => setStatus(e.message, 'err'));
  };

  ui.blockToggle.onchange = function () {
    updateControl({ blocked: ui.blockToggle.checked }).catch((e) => setStatus(e.message, 'err'));
  };

  ui.sendBtn.onclick = function () {
    sendText().catch((e) => setStatus(e.message, 'err'));
  };

  ui.attachBtn.onclick = function () {
    ui.fileInput.click();
  };

  ui.fileInput.onchange = function () {
    const file = ui.fileInput.files && ui.fileInput.files[0];
    if (!file) return;
    sendFile(file)
      .catch((e) => setStatus(e.message, 'err'))
      .finally(() => {
        ui.fileInput.value = '';
      });
  };

  ui.recordBtn.onclick = function () {
    toggleRecording().catch((e) => setStatus(e.message, 'err'));
  };

  async function boot() {
    try {
      await loadDefaultInstance();
      await loadConversations();
      setStatus('Inbox pronta. Carregadas as últimas 50 conversas.', 'ok');

      if (state.poller) clearInterval(state.poller);
      state.poller = setInterval(function () {
        loadConversations().catch((e) => setStatus(e.message, 'err'));
      }, 5000);
    } catch (err) {
      setStatus(`Erro ao iniciar: ${err.message}`, 'err');
    }
  }

  boot();
})();
