import { ref } from 'vue'
import { showNotify } from 'vant'
import {
  API_BASE,
  FILTERED_MESSAGES,
  COMMAND_NEW,
  COMMAND_STOP,
  API_HISTORY,
  API_CHAT,
  API_ABORT,
  API_UPLOAD,
  API_SESSION_NEW,
  API_CHAT_V2,
} from '../constants/index.js'
import { extractText, detectMediaUrls } from '../utils/format.js'
import {
  createAiMessage,
  createEmptyMedia,
  syncMessageMediaFromContent,
  addFileToMessage,
  ensureCurrentAssistant,
} from './useMessages.js'

const CHAT_RESULT_URL = (runId) => `${API_BASE}/chat/${runId}/result`

/* --- History helpers --- */

function publicSessionKey(value) {
  const text = String(value || '')
  if (!text.startsWith('agent:')) return text
  const parts = text.split(':')
  return parts.length >= 3 ? parts.slice(2).join(':') : text
}

export function isSameSessionKey(left, right) {
  return publicSessionKey(left) === publicSessionKey(right)
}

function historyField(entry, key) {
  for (const source of [entry, entry?.message, entry?.item, entry?.data, entry?.payload]) {
    if (source && typeof source === 'object' && source[key] != null) return source[key]
  }
  return ''
}

function normalizeHistoryRole(entry) {
  const raw = String(
    historyField(entry, 'role') ||
    historyField(entry, 'author') ||
    historyField(entry, 'speaker') ||
    historyField(entry, 'type') ||
    ''
  ).trim().toLowerCase()

  if (['user', 'human', 'client', 'customer', 'input', 'request'].includes(raw)) return 'user'
  if (['assistant', 'ai', 'agent', 'model', 'bot', 'response'].includes(raw)) return 'assistant'
  if (raw.includes('user') || raw.includes('human')) return 'user'
  if (raw.includes('assistant') || raw.includes('agent') || raw.includes('model')) return 'assistant'
  return ''
}

/* --- Format helpers --- */

export function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

export function fileIcon(contentType) {
  if (!contentType) return '📄'
  if (contentType.startsWith('image/')) return '🖼️'
  if (contentType.includes('pdf')) return '📕'
  if (contentType.includes('presentation') || contentType.includes('pptx')) return '📊'
  if (contentType.includes('spreadsheet') || contentType.includes('sheet') || contentType.includes('excel')) return '📗'
  if (contentType.includes('word') || contentType.includes('document')) return '📘'
  if (contentType.includes('zip') || contentType.includes('compressed') || contentType.includes('archive')) return '📦'
  if (contentType.includes('text')) return '📝'
  return '📄'
}

/* --- Composable --- */

export function useSend(ctx, streamingApi) {
  const inputText = ref('')
  const uploading = ref(false)
  const uploadProgress = ref(0)
  const attachments = ref([])
  const historyLoading = ref(false)

  ctx.inputText = inputText
  ctx.uploading = uploading
  ctx.uploadProgress = uploadProgress
  ctx.attachments = attachments

  const messages = ctx.messages

  /* --- History --- */

  function handleSessionStatus(statusInfo) {
    if (statusInfo.status === 'generating') {
      ctx.loading.value = true
      if (statusInfo.runId) {
        ctx.state.currentRunId = statusInfo.runId
      }
      console.debug('[useChat] restored generating state from server, runId:', statusInfo.runId)
    } else if (statusInfo.status === 'interrupted') {
      ctx.loading.value = false
      console.warn('[useChat] last session was interrupted')
    } else if (statusInfo.status === 'error') {
      ctx.loading.value = false
      console.warn('[useChat] last session ended with error:', statusInfo.error)
    } else {
      ctx.loading.value = false
    }
  }

  async function loadHistory() {
    historyLoading.value = true
    try {
      const params = new URLSearchParams({ sessionKey: ctx.sessionKey.value, limit: '200' })
      const r = await fetch(
        `${API_BASE}${API_HISTORY}?${params}`,
        { headers: { Authorization: `Bearer ${ctx.token.value}` } }
      )
      if (!r.ok) {
        console.error('[useChat] loadHistory failed:', r.status)
        return
      }
      const data = await r.json()
      const entries = data.entries || data.messages || []
      console.debug('[useChat] history entries:', entries.length)

      if (data.status) {
        handleSessionStatus(data.status)
      }

      const historyMessages = entries
        .map((e) => ({ entry: e, role: normalizeHistoryRole(e) }))
        .filter(({ role }) => role === 'user' || role === 'assistant')
        .filter(({ entry }) => {
          const t = extractText(entry).trim()
          return t && !FILTERED_MESSAGES.includes(t)
        })
        .map(({ entry, role }) => {
          const content = extractText(entry)
          const acpLogs = Array.isArray(entry.acpLogs) && entry.acpLogs.length > 0
            ? entry.acpLogs
            : undefined
          return {
            id: entry.id || entry.runId || Date.now() + Math.random(),
            role,
            content,
            runId: entry.runId || entry.run_id || null,
            files: [],
            media: role === 'assistant' ? detectMediaUrls(content, ctx.token.value) : createEmptyMedia(),
            steps: [],
            acpLogs: acpLogs || [],
          }
        })

      console.debug('[useChat] filtered messages:', historyMessages.length)

      const historyRunIds = new Set(historyMessages.map(m => m.runId).filter(Boolean))

      const streamingMessages = messages.value.filter((m) => m.isStreaming)

      const preservedMessages = streamingMessages.filter((m) => {
        if (m.runId && historyRunIds.has(m.runId)) return false
        return true
      })

      const finalMessages = [...historyMessages]
      for (const pm of preservedMessages) {
        if (pm.runId && historyRunIds.has(pm.runId)) continue
        finalMessages.push(pm)
      }

      messages.value = finalMessages

      ctx.scrollToBottom()
    } catch (err) {
      console.error('[useChat] loadHistory failed:', err)
    } finally {
      historyLoading.value = false
    }
  }

  /* --- Upload --- */

  async function uploadFile(file) {
    uploading.value = true
    uploadProgress.value = 0
    try {
      const formData = new FormData()
      formData.append('file', file)

      const resp = await fetch(`${API_BASE}${API_UPLOAD}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.token.value}` },
        body: formData,
      })

      if (!resp.ok) {
        const errText = await resp.text()
        throw new Error(`上传失败 (${resp.status}): ${errText}`)
      }

      const data = await resp.json()
      uploadProgress.value = 100
      return data
    } catch (err) {
      console.error('[useChat] upload failed:', err)
      throw err
    } finally {
      uploading.value = false
      uploadProgress.value = 0
    }
  }

  /* --- Attachments --- */

  function addAttachment(url, name, type, meta = {}) {
    attachments.value.push({ url, name, type, ...meta })
  }

  function removeAttachment(index) {
    attachments.value.splice(index, 1)
  }

  function clearAttachments() {
    attachments.value = []
  }

  /* --- Abort --- */

  async function abort() {
    if (ctx.state.abortController) {
      ctx.state.abortController.abort()
      ctx.state.abortController = null
    }

    try {
      await fetch(`${API_BASE}${API_ABORT}?sessionKey=${ctx.sessionKey.value}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.token.value}` },
      })
    } catch (err) {
      console.error('[useChat] abort failed:', err)
    }

    ctx.loading.value = false
  }

  /* --- Suspend / resume --- */

  function suspend() {
    const savedRunId = ctx.state.currentRunId
    if (ctx.state.abortController) {
      console.debug('[useChat] suspend: aborting frontend fetch, runId=', savedRunId)
      ctx.state.suspendedRequestId = ctx.state.activeRequestId
      ctx.state.abortController.abort()
      ctx.state.abortController = null
    }
    ctx.loading.value = false
    streamingApi.clearLoadingGuard()
    return savedRunId
  }

  async function tryResume(savedRunId) {
    ctx.state.cancelled = false
    if (!savedRunId) return false
    console.debug('[useChat] tryResume: runId=', savedRunId)

    try {
      const resp = await fetch(CHAT_RESULT_URL(savedRunId), {
        headers: { Authorization: `Bearer ${ctx.token.value}` },
      })
      if (!resp.ok) {
        console.debug('[useChat] tryResume: result endpoint returned', resp.status)
        return false
      }
      const data = await resp.json()
      console.debug('[useChat] tryResume: status=', data.status, 'textLen=', (data.text || '').length)

      if (data.status === 'done' && data.text) {
        const existingByRunId = messages.value.find(m => m.runId === savedRunId)
        if (existingByRunId) {
          existingByRunId.content = data.text
          if (data.files) existingByRunId.files = data.files
          syncMessageMediaFromContent(existingByRunId, ctx.token.value)
        } else {
          const lastAssistant = [...messages.value].reverse().find(m => m.role === 'assistant')
          if (lastAssistant && data.text.includes(lastAssistant.content.trim())) {
            lastAssistant.content = data.text
            if (data.files) lastAssistant.files = data.files
            syncMessageMediaFromContent(lastAssistant, ctx.token.value)
          } else {
            const aiMsg = createAiMessage(Date.now())
            aiMsg.content = data.text
            aiMsg.runId = savedRunId
            syncMessageMediaFromContent(aiMsg, ctx.token.value)
            aiMsg.files = []
            for (const file of (data.files || [])) addFileToMessage(aiMsg, file)
            messages.value.push(aiMsg)
          }
        }
        ctx.scrollToBottom()
        return true
      }

      if (data.status === 'streaming') {
        const existingByRunId = messages.value.find(m => m.runId === savedRunId)
        if (existingByRunId) {
          existingByRunId.content = data.text || ''
          syncMessageMediaFromContent(existingByRunId, ctx.token.value)
          ctx.loading.value = true
          ctx.scrollToBottom()
          const recovered = await streamingApi.tryRecoverResult(savedRunId, existingByRunId, ctx.token)
          ctx.loading.value = false
          ctx.scrollToBottom()
          return recovered
        }
        const aiMsg = createAiMessage(Date.now())
        aiMsg.content = data.text || ''
        aiMsg.runId = savedRunId
        syncMessageMediaFromContent(aiMsg, ctx.token.value)
        messages.value.push(aiMsg)
        ctx.loading.value = true
        ctx.scrollToBottom()

        const recovered = await streamingApi.tryRecoverResult(savedRunId, aiMsg, ctx.token)
        ctx.loading.value = false
        ctx.scrollToBottom()
        return recovered
      }
    } catch (err) {
      console.error('[useChat] tryResume failed:', err)
    }
    return false
  }

  /* --- Reset --- */

  function clearChat() {
    messages.value = []
  }

  function reset() {
    ctx.state.cancelled = true
    messages.value = []
    inputText.value = ''
    ctx.loading.value = false
    ctx.state.abortController = null
    ctx.state.currentRunId = null
    ctx.state.suspendedRequestId = null
    attachments.value = []
    streamingApi.clearLoadingGuard()
    streamingApi.clearV2RecoveryTimer()
  }

  /* --- Send --- */

  async function send(e) {
    ctx.state.cancelled = false
    if (e && e.type === 'keydown') {
      e.preventDefault()
    }

    const text = inputText.value.trim()
    const hasAttachments = attachments.value.length > 0
    if (!text && !hasAttachments) return

    if (uploading.value) {
      showNotify({ type: 'warning', message: '文件仍在上传，请稍候' })
      return
    }

    if (text === COMMAND_STOP && ctx.loading.value) {
      inputText.value = ''
      await abort()
      return
    }

    if (ctx.state.sendingLock || ctx.loading.value) {
      showNotify({ type: 'warning', message: '上一条消息仍在生成，请稍候或先停止' })
      return
    }
    ctx.state.sendingLock = true

    try {
      if (text === COMMAND_NEW && !hasAttachments) {
        inputText.value = ''
        try {
          const r = await fetch(`${API_BASE}${API_SESSION_NEW}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${ctx.token.value}` },
          })
          if (r.ok) {
            const data = await r.json()
            ctx.sessionKey.value = data.sessionKey
            messages.value = []
            ctx.scrollToBottom()
          }
        } catch (err) {
          console.error('[useChat] /new failed:', err)
        }
        return
      }

      let fullMessage = ''
      const sendImages = []
      const sendVideos = []
      const sendAudios = []
      if (hasAttachments) {
        const parts = attachments.value.map(a => {
          if (a.textContent) {
            return `[文件: ${a.name}]\n\`\`\`\n${a.textContent}\n\`\`\``
          }
          if (a.preview) {
            const dataUrl = a.preview
            const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
            if (match) {
              if (match[1].startsWith('video/')) {
                sendVideos.push({ data: match[2], mimeType: match[1] })
              } else if (match[1].startsWith('audio/')) {
                sendAudios.push({ data: match[2], mimeType: match[1] })
              } else {
                sendImages.push({ data: match[2], mimeType: match[1] })
              }
            }
            const mime = match?.[1] || ''
            if (mime.startsWith('video/')) return `[视频: ${a.name}]`
            if (mime.startsWith('audio/')) return `[音频: ${a.name}]`
            return `[图片: ${a.name}]`
          }
          return `[文件: ${a.name}] (${a.type || 'unknown'}, ${(a.size ? formatFileSize(a.size) : 'size unknown')})`
        })
        fullMessage = parts.join('\n\n')
        if (text) fullMessage += '\n\n' + text
      } else {
        fullMessage = text
      }

      inputText.value = ''
      attachments.value = []
      messages.value.push({ id: Date.now(), role: 'user', content: fullMessage })

      // -- Phase 2: persistent SSE mode (fire-and-forget) --
      if (ctx.getStreamMode() === 'events') {
        const aiMsg = createAiMessage()
        aiMsg.isStreaming = true
        messages.value.push(aiMsg)
        ctx.state.aiMsg = aiMsg
        ctx.loading.value = true
        ctx.scrollToBottom()
        streamingApi.startLoadingGuard()
        try {
          const resp = await fetch(`${API_BASE}${API_CHAT_V2}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${ctx.token.value}`,
            },
            body: JSON.stringify({
              message: fullMessage,
              session_key: ctx.sessionKey.value,
              images: sendImages.length > 0 ? sendImages : undefined,
              videos: sendVideos.length > 0 ? sendVideos : undefined,
              audios: sendAudios.length > 0 ? sendAudios : undefined,
            }),
          })
          if (!resp.ok) {
            const errText = await resp.text()
            console.error('[useChat] v2 HTTP error:', resp.status, errText)
            aiMsg.isStreaming = false
            aiMsg.content = `请求失败 (${resp.status})`
            ctx.loading.value = false
            streamingApi.clearLoadingGuard()
            return
          }
          const data = await resp.json()
          ctx.state.currentRunId = data.runId || null
          aiMsg.runId = ctx.state.currentRunId
          console.debug('[useChat] v2 sent, runId:', data.runId)

          const v2RunId = ctx.state.currentRunId
          streamingApi.setV2RecoveryTimer(async () => {
            if (ctx.loading.value && ctx.state.currentRunId === v2RunId && ctx.state.aiMsg) {
              console.warn('[useChat] v2 recovery watchdog triggered -- no events for runId:', v2RunId)
              const recovered = await streamingApi.tryRecoverResult(v2RunId, ctx.state.aiMsg, ctx.token)
              if (recovered) {
                ctx.loading.value = false
                if (ctx.state.aiMsg) ctx.state.aiMsg.isStreaming = false
                ctx.state.aiMsg = null
                streamingApi.clearLoadingGuard()
              } else {
                if (!ctx.state.aiMsg.content) {
                  ctx.state.aiMsg.content = '⚠️ 事件流中断，未能恢复完整回复'
                }
                ctx.loading.value = false
                if (ctx.state.aiMsg) ctx.state.aiMsg.isStreaming = false
                ctx.state.aiMsg = null
                streamingApi.clearLoadingGuard()
              }
            }
            ctx.state.v2RecoveryTimer = null
          }, 180000)
        } catch (err) {
          console.error('[useChat] v2 send failed:', err)
          aiMsg.isStreaming = false
          aiMsg.content = '发送失败，请重试'
          showNotify({ type: 'warning', message: '发送失败，请重试' })
          ctx.loading.value = false
          streamingApi.clearLoadingGuard()
        }
        return
      }

      // -- Legacy: per-request SSE mode --
      const aiMsg = createAiMessage()
      messages.value.push(aiMsg)
      ctx.loading.value = true
      ctx.scrollToBottom()
      streamingApi.startLoadingGuard()

      const requestId = streamingApi.beginStreamingRequest()
      ctx.state.abortController = new AbortController()
      ctx.state.currentRunId = null

      try {
        const resp = await fetch(`${API_BASE}${API_CHAT}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ctx.token.value}`,
          },
          body: JSON.stringify({
            message: fullMessage,
            session_key: ctx.sessionKey.value,
          }),
          signal: ctx.state.abortController.signal,
        })
        if (!resp.ok) {
          const errText = await resp.text()
          console.error('[useChat] HTTP error:', resp.status, errText)
          aiMsg.content = `请求失败 (${resp.status})`
          ctx.loading.value = false
          return
        }

        ctx.state.currentRunId = resp.headers.get('X-Run-Id')
        aiMsg.runId = ctx.state.currentRunId
        console.debug('[useChat] runId:', ctx.state.currentRunId)

        await streamingApi.processSSEStream(resp, aiMsg)
      } catch (err) {
        if (ctx.state.suspendedRequestId === requestId) {
          console.debug('[useChat] SSE aborted due to session switch, preserving runId:', ctx.state.currentRunId)
          return
        }
        if (err.name === 'AbortError') {
          if (!aiMsg.content) aiMsg.content = '🛑 已停止生成'
        } else {
          if (streamingApi.isCurrentRequest(requestId) && ctx.state.currentRunId) {
            console.warn('[useChat] stream interrupted, attempting recovery for runId:', ctx.state.currentRunId)
            const recovered = await streamingApi.tryRecoverResult(ctx.state.currentRunId, aiMsg, ctx.token)
            if (recovered) {
              return
            }
          }
          console.error('[useChat] send failed:', err)
          showNotify({ type: 'warning', message: '连接中断，请重试' })
        }
      } finally {
        if (ctx.state.suspendedRequestId === requestId) {
          ctx.state.suspendedRequestId = null
          return
        }
        if (!streamingApi.isCurrentRequest(requestId)) return
        ctx.loading.value = false
        ctx.state.abortController = null
        ctx.state.currentRunId = null
        streamingApi.clearLoadingGuard()
        streamingApi.clearV2RecoveryTimer()
        ctx.scrollToBottom()
      }
    } finally {
      ctx.state.sendingLock = false
    }
  }

  return {
    inputText,
    uploading,
    uploadProgress,
    attachments,
    historyLoading,
    loadHistory,
    uploadFile,
    addAttachment,
    removeAttachment,
    clearAttachments,
    abort,
    suspend,
    tryResume,
    clearChat,
    reset,
    send,
  }
}
