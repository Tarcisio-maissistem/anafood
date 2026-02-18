/* global MediaRecorder */
(function () {
  const qs = (id) => document.getElementById(id);
  const state = {
    selectedPhone: null,
    conversations: [],
    recorder: null,
    audioChunks: [],
    polling: null,
  };

  const ui = {
    tenantId: qs('tenantId'),
    instanceName: qs('instanceName'),
    refreshBtn: qs('refreshBtn'),
    searchInput: qs('searchInput'),
    chatList: qs('chatList'),
    contactTitle: qs('contactTitle'),
    contactMeta: qs('contactMeta'),
    pauseToggle: qs('pauseToggle'),
    blockToggle: qs('blockToggle'),
    messages: qs('messages'),
    textInput: qs('textInput'),
    fileInput: qs('fileInput'),
    attachBtn: qs('attachBtn'),
    recordBtn: qs('recordBtn'),
    sendBtn: qs('sendBtn'),
    statusBar: qs('statusBar'),
  };

  function tenant() {
    return (ui.tenantId.value || 'default').trim();
  }

  function instance() {
    return (ui.instanceName.value || '').trim();
  }

  function setStatus(text, type) {
    ui.statusBar.textContent = text;
    ui.statusBar.className = `hint ${type || ''}`;
  }

  async function fetchJson(url, init) {
    const response = await fetch(url, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
  }

  async function loadConversations() {
    const search = encodeURIComponent((ui.searchInput.value || '').trim());
    const url = `/api/ana/conversations?tenant_id=${encodeURIComponent(tenant())}&instance=${encodeURIComponent(instance())}&search=${search}`;
    const data = await fetchJson(url);
    state.conversations = data.conversations || [];
    renderConversationList();

    if (state.selectedPhone) {
      const exists = state.conversations.find((c) => c.phone === state.selectedPhone);
      if (exists) {
        await loadSelectedConversation();
      } else {
        state.selectedPhone = null;
        renderConversationDetails(null);
      }
    }
  }

  function renderConversationList() {
    ui.chatList.innerHTML = '';
    for (const c of state.conversations) {
      const div = document.createElement('div');
      div.className = `chat-item ${state.selectedPhone === c.phone ? 'active' : ''}`;
      const last = c.lastMessage ? `${c.lastMessage.role === 'assistant' ? 'Ana: ' : ''}${c.lastMessage.content}` : 'Sem mensagens';
      div.innerHTML = `
        <div class="name">${c.phone}</div>
        <div class="meta">Estado: ${c.state} ${c.paused ? '| pausado' : ''} ${c.blocked ? '| bloqueado' : ''}</div>
        <div class="preview">${last}</div>
      `;
      div.onclick = async function () {
        state.selectedPhone = c.phone;
        renderConversationList();
        await loadSelectedConversation();
      };
      ui.chatList.appendChild(div);
    }
  }

  async function loadSelectedConversation() {
    if (!state.selectedPhone) return;
    const sessionUrl = `/api/ana/session?phone=${encodeURIComponent(state.selectedPhone)}&tenant_id=${encodeURIComponent(tenant())}&instance=${encodeURIComponent(instance())}`;
    const ctrlUrl = `/api/ana/contact-control?phone=${encodeURIComponent(state.selectedPhone)}&tenant_id=${encodeURIComponent(tenant())}&instance=${encodeURIComponent(instance())}`;
    const [session, control] = await Promise.all([fetchJson(sessionUrl), fetchJson(ctrlUrl)]);
    renderConversationDetails({ session, control });
  }

  function renderConversationDetails(payload) {
    if (!payload || !payload.session || !payload.session.found) {
      ui.contactTitle.textContent = state.selectedPhone ? state.selectedPhone : 'Selecione uma conversa';
      ui.contactMeta.textContent = 'Sem sessao ativa para este contato.';
      ui.messages.innerHTML = '';
      ui.pauseToggle.checked = false;
      ui.blockToggle.checked = false;
      return;
    }

    const session = payload.session;
    const control = payload.control?.control || { paused: false, blocked: false };
    ui.contactTitle.textContent = session.phone;
    ui.contactMeta.textContent = `Estado: ${session.state} | Mensagens: ${session.messageCount} | Ultima atividade: ${session.lastActivityAt || '-'}`;
    ui.pauseToggle.checked = !!control.paused;
    ui.blockToggle.checked = !!control.blocked;

    ui.messages.innerHTML = '';
    const messages = Array.isArray(session.recentMessages) ? session.recentMessages : [];
    for (const msg of messages) {
      const bubble = document.createElement('div');
      bubble.className = `bubble ${msg.role === 'assistant' ? 'bot' : 'user'}`;
      const safe = String(msg.content || '').replace(/[<>&]/g, '');
      bubble.innerHTML = `<div>${safe}</div><div class="at">${msg.at || ''}</div>`;
      ui.messages.appendChild(bubble);
    }
    ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  async function setControl(patch) {
    if (!state.selectedPhone) return;
    const data = await fetchJson('/api/ana/contact-control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: state.selectedPhone,
        tenant_id: tenant(),
        instance: instance() || null,
        ...patch,
      }),
    });
    setStatus(`Controle atualizado: pausado=${data.control.paused}, bloqueado=${data.control.blocked}`, 'ok');
    await loadConversations();
  }

  async function sendText() {
    if (!state.selectedPhone) return setStatus('Selecione uma conversa primeiro.', 'warn');
    const text = (ui.textInput.value || '').trim();
    if (!text) return;
    await fetchJson('/api/ana/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: state.selectedPhone,
        text,
        tenant_id: tenant(),
        instance: instance() || null,
      }),
    });
    ui.textInput.value = '';
    setStatus('Mensagem enviada.', 'ok');
    await loadConversations();
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = function () {
        const dataUrl = String(reader.result || '');
        const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function sendFile(file) {
    if (!state.selectedPhone) return setStatus('Selecione uma conversa primeiro.', 'warn');
    const base64 = await fileToBase64(file);
    await fetchJson('/api/ana/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: state.selectedPhone,
        mediaBase64: base64,
        mimeType: file.type || 'application/octet-stream',
        fileName: file.name || 'arquivo.bin',
        caption: ui.textInput.value || '',
        tenant_id: tenant(),
        instance: instance() || null,
      }),
    });
    setStatus('Arquivo/midia enviado.', 'ok');
    await loadConversations();
  }

  async function toggleRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return setStatus('Gravacao de audio nao suportada neste navegador.', 'err');
    }
    if (state.recorder && state.recorder.state === 'recording') {
      state.recorder.stop();
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.audioChunks = [];
    const recorder = new MediaRecorder(stream);
    state.recorder = recorder;
    recorder.ondataavailable = function (evt) {
      if (evt.data && evt.data.size > 0) state.audioChunks.push(evt.data);
    };
    recorder.onstop = async function () {
      try {
        ui.recordBtn.textContent = 'Gravar';
        const blob = new Blob(state.audioChunks, { type: recorder.mimeType || 'audio/webm' });
        const file = new File([blob], `audio-${Date.now()}.webm`, { type: blob.type || 'audio/webm' });
        await sendFile(file);
      } catch (err) {
        setStatus(`Erro ao enviar audio: ${err.message}`, 'err');
      } finally {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
    recorder.start();
    ui.recordBtn.textContent = 'Parar';
    setStatus('Gravando audio... clique novamente para parar.', 'warn');
  }

  ui.refreshBtn.onclick = async function () {
    await loadConversations();
    setStatus('Inbox atualizada.', 'ok');
  };
  ui.searchInput.oninput = function () { loadConversations().catch((e) => setStatus(e.message, 'err')); };
  ui.pauseToggle.onchange = function () { setControl({ paused: ui.pauseToggle.checked }).catch((e) => setStatus(e.message, 'err')); };
  ui.blockToggle.onchange = function () { setControl({ blocked: ui.blockToggle.checked }).catch((e) => setStatus(e.message, 'err')); };
  ui.sendBtn.onclick = function () { sendText().catch((e) => setStatus(e.message, 'err')); };
  ui.attachBtn.onclick = function () { ui.fileInput.click(); };
  ui.fileInput.onchange = function () {
    const file = ui.fileInput.files && ui.fileInput.files[0];
    if (!file) return;
    sendFile(file).catch((e) => setStatus(e.message, 'err')).finally(() => { ui.fileInput.value = ''; });
  };
  ui.recordBtn.onclick = function () { toggleRecording().catch((e) => setStatus(e.message, 'err')); };

  async function boot() {
    try {
      await loadConversations();
      if (state.polling) clearInterval(state.polling);
      state.polling = setInterval(() => {
        loadConversations().catch((e) => setStatus(e.message, 'err'));
      }, 5000);
      setStatus('Inbox online. Atualizando a cada 5 segundos.', 'ok');
    } catch (err) {
      setStatus(`Falha ao carregar inbox: ${err.message}`, 'err');
    }
  }

  boot();
})();
