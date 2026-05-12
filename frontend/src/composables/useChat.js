import { ref } from 'vue'
import { useMessages } from './useMessages.js'
import { useStreaming } from './useStreaming.js'
import { useSend, formatFileSize, fileIcon, isSameSessionKey } from './useSend.js'

let _streamMode = 'legacy'  // 'legacy' (per-request SSE) or 'events' (persistent SSE + /chat/v2)

export function setStreamMode(mode) {
  _streamMode = mode
}

export function useChat(token, currentUser, sessionKey, options = {}) {
  const { onModelUpdate } = options

  // ── Shared state container ──
  const listRef = ref(null)
  const loading = ref(false)

  function scrollToBottom() {
    requestAnimationFrame(() => {
      const el = listRef.value
      if (el) {
        el.scrollTop = el.scrollHeight
        setTimeout(() => {
          el.scrollTop = el.scrollHeight
        }, 50)
      }
    })
  }

  const ctx = {
    token,
    sessionKey,
    onModelUpdate,
    loading,
    listRef,
    scrollToBottom,
    getStreamMode: () => _streamMode,
    // Mutable non-reactive coordination state (mutated by composables)
    state: {
      currentRunId: null,
      aiMsg: null,
      abortController: null,
      activeRequestId: 0,
      suspendedRequestId: null,
      cancelled: false,
      sendingLock: false,
      lastEventAt: 0,
      loadingTimer: null,
      v2RecoveryTimer: null,
    },
    // The composables below populate these references on ctx itself:
    // ctx.messages       (useMessages)
    // ctx.inputText, ctx.uploading, ctx.uploadProgress, ctx.attachments (useSend)
  }

  // ── Compose ──
  const messagesApi = useMessages(ctx)
  const streamingApi = useStreaming(ctx)
  const sendApi = useSend(ctx, streamingApi)

  const messages = ctx.messages

  // ── handleStreamEvent: dispatch to composable handlers ──
  function handleStreamEvent(event) {
    if (!event) return
    streamingApi.refreshLoadingGuard()
    streamingApi.clearV2RecoveryTimer()
    const kind = event.kind || event.stream
    const runId = event.runId
    const payload = event.payload || {}

    // Filter: only process events for current session
    if (event.sessionKey && !isSameSessionKey(event.sessionKey, sessionKey.value)) {
      return
    }

    if (kind === 'snapshot') {
      streamingApi.handleSnapshot(event)
      return
    }

    if (kind === 'run.started') {
      streamingApi.handleRunStarted(runId)
      return
    }

    if (kind === 'assistant.delta') {
      const delta = payload.delta || payload.text
      if (!delta) return
      const aiMsg = messagesApi.ensureCurrentAssistant()
      aiMsg.isStreaming = true
      loading.value = true
      messagesApi.applyAssistantDelta(delta)
      scrollToBottom()
      return
    }

    if (kind === 'command.output') {
      const aiMsg = ctx.state.aiMsg
      if (!aiMsg) return
      const steps = aiMsg.steps || (aiMsg.steps = [])
      steps.push({
        type: 'tool',
        name: payload.name || 'command',
        output: payload.output ?? payload.text ?? '',
        status: 'done',
      })
      scrollToBottom()
      return
    }

    if (kind === 'tool_use') {
      const aiMsg = ctx.state.aiMsg
      if (!aiMsg) return
      const steps = aiMsg.steps || (aiMsg.steps = [])
      steps.push({
        type: 'tool',
        name: payload.name || 'tool',
        input: payload.input,
        status: 'running',
      })
      scrollToBottom()
      return
    }

    if (kind === 'tool_result') {
      const aiMsg = ctx.state.aiMsg
      if (!aiMsg) return
      const steps = aiMsg.steps || (aiMsg.steps = [])
      // Find the last matching running tool step
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].type === 'tool' && steps[i].status === 'running') {
          steps[i].output = payload.output ?? payload.text ?? ''
          steps[i].status = 'done'
          break
        }
      }
      scrollToBottom()
      return
    }

    if (kind === 'full_result') {
      messagesApi.applyFullResult(payload.text)
      scrollToBottom()
      return
    }

    if (kind === 'run.error' || kind === 'run.failed') {
      streamingApi.handleRunError(payload, runId)
      return
    }

    if (kind === 'run.end') {
      streamingApi.handleRunEnd(runId)
      return
    }

    if (kind === 'run.done') {
      streamingApi.handleRunDone(runId)
      return
    }
  }

  return {
    messages,
    inputText: sendApi.inputText,
    loading,
    uploading: sendApi.uploading,
    uploadProgress: sendApi.uploadProgress,
    attachments: sendApi.attachments,
    historyLoading: sendApi.historyLoading,
    listRef,
    loadHistory: sendApi.loadHistory,
    send: sendApi.send,
    abort: sendApi.abort,
    uploadFile: sendApi.uploadFile,
    addAttachment: sendApi.addAttachment,
    removeAttachment: sendApi.removeAttachment,
    clearAttachments: sendApi.clearAttachments,
    clearChat: sendApi.clearChat,
    reset: sendApi.reset,
    suspend: sendApi.suspend,
    tryResume: sendApi.tryResume,
    scrollToBottom,
    handleStreamEvent,
    _formatFileSize: formatFileSize,
    _fileIcon: fileIcon,
  }
}
