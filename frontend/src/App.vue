<template>
  <div class="app">
    <router-view v-slot="{ Component, route }">
      <component
        :is="Component"
        v-if="route.name === 'Login'"
        v-model:username="username"
        v-model:password="password"
        @login="handleLogin"
      />
      <component
        :is="Component"
        v-else-if="route.name === 'Chat'"
        :messages="messages"
        :input-text="inputText"
        :loading="loading"
        :history-loading="historyLoading"
        :uploading="uploading"
        :upload-progress="uploadProgress"
        :attachments="attachments"
        :format-file-size="formatFileSize"
        :file-icon="fileIcon"
        :service-status="serviceStatus"
        :current-model="currentModel"
        :sse-connected="eventStream.connected"
        :sse-reconnecting="eventStream.reconnecting"
        :models="models"
        :session-key="sessionKey"
        :current-agent-id="currentAgentId"
        :monitor-mode="monitorMode"
        :monitor-messages="monitorMessages"
        :monitor-history-loading="monitorLoading"
        :monitor-user-info="monitorUserInfo"
        :can-access-monitor="canAccessMonitor"
        @update:input-text="inputText = $event"
        @send="handleSend"
        @abort="handleAbort"
        @upload="handleUpload"
        @remove-attachment="removeAttachment"
        @open-settings="showSettings = true"
        @hot-refresh="handleHotRefresh"
        @switch-model="handleSwitchModel"
        @open-monitor="showMonitor = true"
        @exit-monitor="handleExitMonitor"
      />
    </router-view>

    <SessionMonitor
      v-if="canAccessMonitor"
      v-model:show="showMonitor"
      :token="token"
      :agents="agents"
      :current-session-key="sessionKey"
      @view-session="handleViewMonitorSession"
      @new="handleNewSession"
    />

    <SettingsPopup
      v-model:show="showSettings"
      :current-user="currentUser"
      :session-key="sessionKey"
      :agents="agents"
      :current-agent-id="currentAgentId"
      @clear-chat="handleClearChat"
      @logout="handleLogout"
      @change-password="handleChangePassword"
      @switch-agent="handleSwitchAgent"
    />
  </div>
</template>

<script setup>
import { ref, computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from './composables/useAuth.js'
import { useChat, setStreamMode } from './composables/useChat.js'
import { showNotify } from 'vant'
import { useEventStream } from './composables/useEventStream.js'
import { useServiceStatus } from './composables/useServiceStatus.js'
import SessionMonitor from './components/SessionMonitor.vue'
import SettingsPopup from './components/SettingsPopup.vue'
import { API_BASE, API_SESSION, API_SESSIONS, API_SESSION_NEW, API_MODEL_SWITCH, API_AGENTS, API_ADMIN_SESSIONS, API_HISTORY } from './constants/index.js'

const router = useRouter()

// 会话级状态缓存：sessionKey → { runId }
const MAX_CACHE_SIZE = 50
const _sessionStateCache = new Map()
const _sessionModelCache = new Map()

function setCacheWithLimit(map, key, value) {
  if (map.size >= MAX_CACHE_SIZE) {
    const firstKey = map.keys().next().value
    map.delete(firstKey)
  }
  map.set(key, value)
}

const {
  loggedIn,
  token,
  currentUser,
  username,
  password,
  sessionKey,
  initFromStorage,
  login: authLogin,
  logout: authLogout,
  changePassword,
} = useAuth()

const {
  messages,
  inputText,
  loading,
  uploading,
  uploadProgress,
  attachments,
  historyLoading,
  loadHistory,
  send: chatSend,
  abort: chatAbort,
  suspend: chatSuspend,
  tryResume: chatTryResume,
  uploadFile,
  addAttachment,
  removeAttachment,
  clearAttachments,
  clearChat,
  reset: chatReset,
  handleStreamEvent,
  _formatFileSize: formatFileSize,
  _fileIcon: fileIcon,
} = useChat(token, currentUser, sessionKey, {
  onModelUpdate: (model, meta = {}) => {
    const authoritative = isAuthoritativeModelSource(meta.source)
    setCurrentModel(model, {
      source: meta.source || 'sse',
      session: meta.sessionKey || sessionKey.value,
      force: authoritative,
    })
    if (!authoritative) {
      window.setTimeout(() => {
        fetchModel()
      }, 300)
    }
  },
})

// Persistent SSE event stream (Phase 2 — drives UI)
const eventStream = useEventStream(token, sessionKey, {
  onEvent: (event) => {
    handleStreamEvent(event)
  },
})

const showSettings = ref(false)
const currentModel = ref('')
const models = ref([])
const agents = ref([])
const currentAgentId = ref('main')
const { serviceStatus } = useServiceStatus()
let modelPollTimer = null
const MODEL_POLL_INTERVAL = 30000
let _historyLoading = false

// --- Monitor mode state ---
const showMonitor = ref(false)
const monitorMode = ref(false)
const monitorSessionKey = ref('')
const monitorMessages = ref([])
const monitorLoading = ref(false)
const monitorUserInfo = ref('')

const canAccessMonitor = computed(() => {
  return currentUser.value &&
    (currentUser.value.allowedAgent === 'main' || currentUser.value.allowedAgent === 'dev')
})

const monitorEventStream = useEventStream(token, monitorSessionKey, {
  onEvent: (event) => handleMonitorStreamEvent(event),
})

function normalizeModel(model) {
  return typeof model === 'string' ? model.trim() : ''
}

function isAuthoritativeModelSource(source) {
  return typeof source === 'string' && (
    source.startsWith('sessions.list') ||
    source.startsWith('agent.') ||
    source === 'config'
  )
}

function setCurrentModel(model, options = {}) {
  const normalized = normalizeModel(model)
  if (!normalized) return false

  const targetSession = options.session || sessionKey.value
  if (targetSession && targetSession !== sessionKey.value) {
    return false
  }

  const existing = targetSession ? _sessionModelCache.get(targetSession) : null
  if (!options.force && existing && isAuthoritativeModelSource(existing.source)) {
    console.debug('[App] ignored non-authoritative model update after authoritative model:', normalized)
    return false
  }

  currentModel.value = normalized
  if (targetSession) {
    setCacheWithLimit(_sessionModelCache, targetSession, {
      model: normalized,
      source: options.source || 'api',
      updatedAt: Date.now(),
    })
  }
  return true
}

function applyCachedModelForSession(targetSession) {
  const cached = targetSession ? _sessionModelCache.get(targetSession) : null
  if (cached?.model) {
    currentModel.value = cached.model
    return true
  }
  currentModel.value = ''
  return false
}

onMounted(async () => {
  const ok = await initFromStorage()
  if (ok) {
    _historyLoading = true
    const LOAD_HISTORY_TIMEOUT = 5000
    const historyWithTimeout = Promise.race([
      loadHistory(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loadHistory timeout')), LOAD_HISTORY_TIMEOUT)),
    ])
    try {
      await historyWithTimeout
    } catch (e) {
      console.warn('[App] loadHistory timed out:', e.message)
    }
    _historyLoading = false
    fetchModel()
    fetchAgents()
    eventStream.connect()
  } else if (router.currentRoute.value.name !== 'Login') {
    router.replace({ name: 'Login' })
  }
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
  eventStream.disconnect()
  stopModelPolling()
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})

watch([loading, sessionKey, loggedIn], ([isLoading, activeSession, isLoggedIn]) => {
  if (isLoggedIn && isLoading && activeSession) {
    startModelPolling()
  } else {
    stopModelPolling()
  }
  if (activeSession) updateCurrentAgentId()
})

watch(
  [loggedIn, token, sessionKey],
  ([isLoggedIn, authToken, activeSession], [prevLoggedIn, prevToken, prevSession]) => {
    const ready = Boolean(isLoggedIn && authToken && activeSession)
    if (!ready) {
      eventStream.disconnect()
      return
    }

    const sessionChanged = activeSession !== prevSession
    const tokenChanged = authToken !== prevToken
    const loginChanged = isLoggedIn !== prevLoggedIn

    if (sessionChanged || tokenChanged || loginChanged) {
      console.debug('[App] reconnecting event stream', {
        sessionChanged,
        tokenChanged,
        loginChanged,
        sessionKey: activeSession,
      })
      eventStream.disconnect()
      if (!_historyLoading) {
        eventStream.connect()
      }
    }
  },
  { immediate: true }
)

// Phase 2: switch to persistent SSE mode when connected
watch(() => eventStream.connected.value, (isConnected, wasConnected) => {
  if (isConnected) {
    setStreamMode('events')
    console.debug('[App] switched to persistent SSE mode (v2)')
    if (loading.value) {
      const connectedAt = eventStream.lastDataAt.value
      setTimeout(() => {
        if (loading.value && eventStream.lastDataAt.value === connectedAt) {
          console.warn('[App] SSE connected but no events received in 3s — resetting stuck loading')
          loading.value = false
        }
      }, 3000)
    }
  } else {
    setStreamMode('legacy')
    console.debug('[App] switched to legacy SSE mode')
    if (wasConnected === true && loading.value) {
      console.warn('[App] event stream disconnected while loading=true — resetting')
      loading.value = false
    }
  }
})

function handleBeforeUnload() {
  eventStream.disconnect()
  monitorEventStream.disconnect()
}

async function handleLogin() {
  const ok = await authLogin()
  if (ok) {
    _historyLoading = true
    const LOAD_HISTORY_TIMEOUT = 5000
    const historyWithTimeout = Promise.race([
      loadHistory(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('loadHistory timeout')), LOAD_HISTORY_TIMEOUT)),
    ])
    try {
      await historyWithTimeout
    } catch (e) {
      console.warn('[App] loadHistory timed out:', e.message)
    }
    _historyLoading = false
    fetchModel()
    fetchAgents()
    eventStream.connect()
    router.push({ name: 'Chat' })
  }
}

async function fetchModel(options = {}) {
  const requestSessionKey = sessionKey.value
  if (!requestSessionKey) return false
  try {
    const params = requestSessionKey ? `?sessionKey=${encodeURIComponent(requestSessionKey)}` : ''
    const r = await fetch(`${API_BASE}/models${params}`, {
      headers: { Authorization: `Bearer ${token.value}` },
    })
    if (r.ok) {
      const data = await r.json()
      // 兼容多种返回格式：{ models: [...] } 或直接返回数组
      const modelList = Array.isArray(data.models)
        ? data.models
        : (Array.isArray(data) ? data : [])
      if (modelList.length) {
        models.value = modelList
        console.debug('[App] models loaded:', modelList.length, modelList)
      } else {
        console.warn('[App] models list empty, raw response:', data)
      }
      const defaultModel = data.default || data.current_model || (modelList.length ? (modelList[0].id || modelList[0].model || modelList[0].name) : '')
      if (defaultModel) {
        return setCurrentModel(defaultModel, {
          source: options.source || 'api',
          session: requestSessionKey,
          force: options.force === true,
        })
      }
    } else {
      console.warn('[App] fetchModel HTTP error:', r.status)
    }
  } catch (err) {
    console.error('[App] fetch model failed:', err)
  }
  return false
}

function startModelPolling() {
  if (modelPollTimer || !sessionKey.value || !loggedIn.value) return

  fetchModel({ source: 'api.poll', force: true })
  modelPollTimer = window.setInterval(() => {
    if (!loading.value || !sessionKey.value || !loggedIn.value) {
      stopModelPolling()
      return
    }
    fetchModel({ source: 'api.poll', force: true })
  }, MODEL_POLL_INTERVAL)
}

function stopModelPolling() {
  if (!modelPollTimer) return
  window.clearInterval(modelPollTimer)
  modelPollTimer = null
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible' && token.value) {
    const isStreaming = loading.value
    console.debug('[App] visibilitychange: page visible, streaming=', isStreaming, 'sseConnected=', eventStream.connected.value)

    if (eventStream.connected.value) {
      // SSE still alive — don't tear it down, just refresh stale data
      if (!isStreaming) {
        loadHistory().catch((e) => {
          console.warn('[App] visibilitychange: loadHistory failed', e)
        })
      }
    } else {
      // Connection lost while in background — reconnect
      eventStream.connect()
      if (!isStreaming) {
        loadHistory().catch((e) => {
          console.warn('[App] visibilitychange: loadHistory failed', e)
        })
      }
    }
  }
}

function handleSend(e) {
  chatSend(e)
}

function handleAbort() {
  chatAbort()
}

async function handleSwitchModel(model) {
  if (!model || !sessionKey.value) return
  try {
    const r = await fetch(`${API_BASE}${API_MODEL_SWITCH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token.value}`,
      },
      body: JSON.stringify({
        model,
        session_key: sessionKey.value,
      }),
    })
    if (r.ok) {
      const data = await r.json()
      setCurrentModel(data.model || model, {
        source: 'config',
        session: sessionKey.value,
        force: true,
      })
      showNotify({ type: 'success', message: `已切换到 ${data.model || model}` })
    } else {
      const text = await r.text()
      showNotify({ type: 'danger', message: `切换失败: ${text}` })
    }
  } catch (err) {
    console.error('[App] switch model failed:', err)
    showNotify({ type: 'danger', message: '切换模型失败，请重试' })
  }
}

async function fetchAgents() {
  try {
    const r = await fetch(`${API_BASE}${API_AGENTS}`, {
      headers: { Authorization: `Bearer ${token.value}` },
    })
    if (r.ok) {
      const data = await r.json()
      agents.value = data.agents || []
      updateCurrentAgentId()
    }
  } catch (err) {
    console.error('[App] fetch agents failed:', err)
  }
}

function updateCurrentAgentId() {
  const sk = sessionKey.value
  let parsed = null
  if (sk && sk.startsWith('agent:')) {
    const parts = sk.split(':')
    if (parts.length >= 2) {
      parsed = parts[1]
    }
  }
  // 1. server-side preference
  if (!parsed && currentUser.value?.preferredAgent) {
    parsed = currentUser.value.preferredAgent
  }
  // 2. role default (allowedAgent)
  if (!parsed && currentUser.value?.allowedAgent) {
    parsed = currentUser.value.allowedAgent
  }
  // 3. ultimate fallback
  if (!parsed) parsed = 'main'
  const allowed = agents.value.map(a => a.id)
  if (allowed.length > 0 && !allowed.includes(parsed)) {
    parsed = allowed[0]
  }
  currentAgentId.value = parsed
}

async function handleSwitchAgent(agentId) {
  if (loading.value) {
    showNotify({ type: 'warning', message: '请等待当前回复完成' })
    return
  }
  try {
    const r = await fetch(`${API_BASE}${API_SESSIONS}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token.value}`,
      },
      body: JSON.stringify({ agent_id: agentId }),
    })
    if (r.ok) {
      const data = await r.json()
      sessionKey.value = data.sessionKey
      currentAgentId.value = agentId
      // Persist preference to server
      fetch(`${API_BASE}/user/preferred-agent`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.value}` },
        body: JSON.stringify({ agent_id: agentId }),
      }).catch(() => {})
      messages.value = []
      currentModel.value = ''
      await fetchModel()
      showNotify({ type: 'success', message: `已切换到 ${(agents.value.find(a => a.id === agentId))?.name || agentId}` })
      showSettings.value = false
    } else {
      const text = await r.text()
      showNotify({ type: 'danger', message: `切换失败: ${text}` })
    }
  } catch (err) {
    console.error('[App] switch agent failed:', err)
    showNotify({ type: 'danger', message: '切换助手失败，请重试' })
  }
}

  async function handleUpload(file) {
  try {
    const data = await uploadFile(file)
    const meta = {}
    if (data.textContent) meta.textContent = data.textContent
    if (data.preview) meta.preview = data.preview
    if (data.size) meta.size = data.size
    addAttachment(data.url, data.filename || file.name, file.type || data.mimetype || 'application/octet-stream', meta)
  } catch (err) {
    messages.value.push({
      id: Date.now(),
      role: 'assistant',
      content: `❌ 文件上传失败: ${err.message}`,
    })
  }
}

async function handleHotRefresh() {
  if (loading.value) {
    showNotify({ type: 'warning', message: '正在生成中，请稍后刷新' })
    return
  }
  await loadHistory()
  await fetchModel({ force: true })
}

function handleClearChat() {
  clearChat()
  showSettings.value = false
}

function handleLogout() {
  eventStream.disconnect()
  monitorEventStream.disconnect()
  stopModelPolling()
  authLogout()
  chatReset()
  currentModel.value = ''
  monitorMode.value = false
  showSettings.value = false
  router.push({ name: 'Login' })
}

function handleChangePassword(oldPw, newPw, callback) {
  changePassword(oldPw, newPw).then(callback)
}

// ── Monitor Mode ──

function normalizeMonitorRole(role) {
  const r = (role || '').toLowerCase()
  if (['user', 'human', 'client', 'input'].includes(r)) return 'user'
  if (['assistant', 'ai', 'agent', 'model', 'bot'].includes(r)) return 'assistant'
  return role
}

async function handleViewMonitorSession(s) {
  monitorMode.value = true
  monitorSessionKey.value = s.sessionKey
  monitorUserInfo.value = `${s.displayName || s.username} · ${s.agentId}`
  monitorMessages.value = []
  monitorLoading.value = true

  try {
    const params = new URLSearchParams({ sessionKey: s.sessionKey, limit: '200' })
    const r = await fetch(`${API_BASE}${API_HISTORY}?${params}`, {
      headers: { Authorization: `Bearer ${token.value}` },
    })
    if (r.ok) {
      const data = await r.json()
      const entries = data.entries || data.messages || []
      monitorMessages.value = entries
        .filter(e => e.content && !['NO_REPLY', 'HEARTBEAT_OK'].includes(e.content))
        .map((e, i) => ({
          id: e.id || i + 1,
          role: normalizeMonitorRole(e.role),
          content: e.content,
          runId: e.runId,
          files: [],
          media: [],
          steps: [],
          acpLogs: [],
        }))
    }
  } catch (err) {
    console.error('[App] monitor loadHistory failed:', err)
  } finally {
    monitorLoading.value = false
  }

  // Start SSE for real-time streaming
  monitorEventStream.connect()
}

function handleExitMonitor() {
  monitorEventStream.disconnect()
  monitorMode.value = false
  monitorSessionKey.value = ''
  monitorMessages.value = []
  monitorUserInfo.value = ''
}

function handleMonitorStreamEvent(event) {
  const kind = event.kind
  if (!kind) return

  if (kind === 'assistant.delta') {
    const delta = event.payload?.delta || ''
    if (!delta) return
    const last = monitorMessages.value[monitorMessages.value.length - 1]
    if (last && last.role === 'assistant' && last._streaming) {
      last.content += delta
    } else {
      monitorMessages.value.push({
        id: Date.now(),
        role: 'assistant',
        content: delta,
        files: [],
        media: [],
        steps: [],
        acpLogs: [],
        _streaming: true,
      })
    }
  } else if (kind === 'full_result') {
    const text = event.payload?.text || ''
    if (text) {
      const last = monitorMessages.value[monitorMessages.value.length - 1]
      if (last && last.role === 'assistant' && last._streaming) {
        last.content = text
        last._streaming = false
      }
    }
  } else if (kind === 'run.done' || kind === 'run.end') {
    const last = monitorMessages.value[monitorMessages.value.length - 1]
    if (last && last._streaming) {
      last._streaming = false
    }
  } else if (kind === 'assistant.thinking') {
    // Ignore thinking deltas in monitor mode to keep it simple
  } else if (kind === 'tool_use') {
    const payload = event.payload || {}
    const toolName = payload.name || payload.tool || 'tool'
    const last = monitorMessages.value[monitorMessages.value.length - 1]
    if (last && last.role === 'assistant') {
      if (!last.steps) last.steps = []
      last.steps.push({ name: toolName, status: 'running', output: '' })
    }
  } else if (kind === 'tool_result') {
    const last = monitorMessages.value[monitorMessages.value.length - 1]
    if (last && last.steps && last.steps.length > 0) {
      const step = last.steps[last.steps.length - 1]
      if (step.status === 'running') {
        step.status = 'done'
        step.output = event.payload?.output || ''
      }
    }
  } else if (kind === 'snapshot') {
    // Ignore snapshots in monitor mode
  }
}

// ── Session Management ──

async function handleSwitchSession(newSessionKey) {
  // 1. 保存当前会话的进行中状态
  const oldSessionKey = sessionKey.value
  if (loading.value) {
    const runId = chatSuspend()
    if (runId) {
      setCacheWithLimit(_sessionStateCache, oldSessionKey, { runId })
    }
  }

  // 2. 通知服务端切换会话
  try {
    await fetch(`${API_BASE}${API_SESSIONS}/active`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token.value}`,
      },
      body: JSON.stringify({ sessionKey: newSessionKey }),
    })
  } catch (err) {
    console.error('[App] switch session failed:', err)
    return
  }

  // 3. 切换到新会话
  sessionKey.value = newSessionKey
  messages.value = []
  applyCachedModelForSession(newSessionKey)

  // 4. 加载历史（带超时保护）
  const LOAD_HISTORY_TIMEOUT = 5000
  const historyWithTimeout = Promise.race([
    loadHistory(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('loadHistory timeout')), LOAD_HISTORY_TIMEOUT)),
  ])
  try {
    await historyWithTimeout
  } catch (e) {
    console.warn('[App] loadHistory timed out:', e.message)
  }
  fetchModel()

  // 5. 如果新会话有残留的进行中任务，尝试恢复
  const cached = _sessionStateCache.get(newSessionKey)
  if (cached?.runId) {
    const recovered = await chatTryResume(cached.runId)
    if (recovered) {
      _sessionStateCache.delete(newSessionKey)
    }
  }
}

async function handleNewSession() {
  try {
    const r = await fetch(`${API_BASE}${API_SESSIONS}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token.value}`,
      },
      body: JSON.stringify({ agent_id: currentAgentId.value }),
    })
    if (r.ok) {
      const data = await r.json()
      sessionKey.value = data.sessionKey
      messages.value = []
      currentModel.value = ''
      await fetchModel()
    }
  } catch (err) {
    console.error('[App] new session failed:', err)
  }
}
</script>

<style>
/* ── Variables ── */
:root {
  --primary: #007AFF;
  --secondary: #8E8E8E;
  --accent: #007AFF;
  --bg: #F7F8FA;
  --text: #1F1F1F;
  --border: #E5E5E5;
  --white: #ffffff;
  --gradient-user: none;
}

/* ── Base Reset ── */
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', Roboto, sans-serif; overflow: hidden; color: var(--text); -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
#app, .app { height: 100%; }
a { color: inherit; text-decoration: none; }
button { font-family: inherit; }

/* ── Transitions ── */
* { scroll-behavior: auto; }

/* ── Global Vant Overrides ── */
.van-cell-group--inset { border-radius: 14px; overflow: hidden; }
.van-cell { background: #FFFFFF; }
.van-field__label { color: var(--text); font-weight: 500; }
</style>
