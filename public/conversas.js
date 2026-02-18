(function () {
  const ui = {
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

  function setStatus(text, cls) {
    ui.status.textContent = text;
    ui.status.className = `status ${cls || ''}`;
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
    if (!response.ok || data.success === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function loadDefaultInstance() {
    try {
      const data = await fetchJson('/api/ana/default-instance?tenant_id=default');
      state.tenantId = data.tenantId || 'default';
      state.instance = data.instance || '';
      if (data.configuredInstance && data.configuredInstance !== data.instance) {
        setStatus(`Instancia configurada (${data.configuredInstance}) indisponivel. Usando ${data.instance}.`, 'warn');
      }
    } catch (_) {
      state.tenantId = 'default';
      state.instance = '';
    }
    ui.instanceInfo.textContent = `Instancia padrao: ${state.instance || '(nao definida)'}`;
  }

  function renderList() {
    ui.list.innerHTML = '';
    for (const c of state.conversations) {
      const item = document.createElement('div');
      item.className = `item ${state.selectedPhone === c.phone ? 'active' : ''}`;
      const initials = c.phone.slice(-2) || '--';
      const preview = (c.lastMessage?.content || 'Sem mensagens').replace(/[<>&]/g, '');
      item.innerHTML = `
        <div class="bubble-avatar">${initials}</div>
        <div>
          <div class="name">${c.phone}</div>
          <div class="preview">${preview}</div>
        </div>
        <div class="time">${formatTime(c.lastActivityAt)}</div>
      `;
      item.onclick = async function () {
        state.selectedPhone = c.phone;
        state.selectedRemoteJid = c.remoteJid || `${c.phone}@s.whatsapp.net`;
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
      ui.instanceInfo.textContent = `Instancia padrao: ${state.instance || '(nao definida)'}`;
    }

    state.conversations = data.conversations || [];
    if (!state.selectedPhone && state.conversations.length) {
      state.selectedPhone = state.conversations[0].phone;
      state.selectedRemoteJid = state.conversations[0].remoteJid || `${state.selectedPhone}@s.whatsapp.net`;
    }
    renderList();
    if (state.selectedPhone) {
      await loadControls();
      await loadMessages();
    }
  }

  async function loadControls() {
    if (!state.selectedPhone) return;
    const c = await fetchJson(`/api/ana/contact-control?tenant_id=${encodeURIComponent(state.tenantId)}&instance=${encodeURIComponent(state.instance)}&phone=${encodeURIComponent(state.selectedPhone)}`);
    ui.pauseToggle.checked = !!c.control?.paused;
    ui.blockToggle.checked = !!c.control?.blocked;
  }

  async function loadMessages() {
    if (!state.selectedPhone) return;
    const msgData = await fetchJson(`/api/ana/messages?tenant_id=${encodeURIComponent(state.tenantId)}&instance=${encodeURIComponent(state.instance)}&phone=${encodeURIComponent(state.selectedPhone)}&limit=80`);
    const sessionData = await fetchJson(`/api/ana/session?tenant_id=${encodeURIComponent(state.tenantId)}&instance=${encodeURIComponent(state.instance)}&phone=${encodeURIComponent(state.selectedPhone)}`);

    ui.contactAvatar.textContent = state.selectedPhone.slice(-2) || '--';
    ui.contactName.textContent = state.selectedPhone;
    ui.contactState.textContent = `Estado: ${sessionData?.state || 'INIT'} | Instancia: ${state.instance || '-'}`;

    const messages = msgData.messages || [];
    ui.messages.innerHTML = '';
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const safe = String(m.content || '').replace(/[<>&]/g, '');
      const el = document.createElement('div');
      el.className = `msg ${role}`;
      el.innerHTML = `<div class="content">${safe}<div class="at">${formatTime(m.at)}</div></div>`;
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
    if (!state.selectedPhone) return setStatus('Selecione uma conversa.', 'warn');
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
    if (!state.selectedPhone) return setStatus('Selecione uma conversa.', 'warn');
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
    setStatus('Arquivo/midia enviado.', 'ok');
    await loadConversations();
  }

  async function toggleRecording() {
    if (!navigator.mediaDevices?.getUserMedia) return setStatus('Gravacao nao suportada.', 'err');
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
        setStatus(`Falha no envio de audio: ${err.message}`, 'err');
      } finally {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
    state.recorder.start();
    ui.recordBtn.textContent = 'Parar';
    setStatus('Gravando audio... clique novamente para parar.', 'warn');
  }

  ui.refreshBtn.onclick = function () { loadConversations().then(() => setStatus('Atualizado.', 'ok')).catch((e) => setStatus(e.message, 'err')); };
  ui.searchInput.oninput = function () { loadConversations().catch((e) => setStatus(e.message, 'err')); };
  ui.pauseToggle.onchange = function () { updateControl({ paused: ui.pauseToggle.checked }).catch((e) => setStatus(e.message, 'err')); };
  ui.blockToggle.onchange = function () { updateControl({ blocked: ui.blockToggle.checked }).catch((e) => setStatus(e.message, 'err')); };
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
      await loadDefaultInstance();
      await loadConversations();
      setStatus('Inbox pronta. Carregadas as ultimas 50 conversas.', 'ok');
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