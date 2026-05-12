import {
  API_BASE,
  API_CHAT,
} from '../constants/index.js'
import {
  appendAssistantTextSafely,
  syncMessageMediaFromContent,
  addFileToMessage,
  startToolStep,
  updateToolResultStep,
  appendCommandOutputStep,
  addTextStep,
  addStatusStep,
  createAiMessage,
  findActiveStreamingMessage,
  findLastAssistantMessage,
  flushStreamUpdate,
  FILTERED_STREAM_TEXTS,
} from './useMessages.js'

const CHAT_RESULT_URL = (runId) => `${API_BASE}/chat/${runId}/result`

const MAX_SSE_TIMEOUT = 3 * 60 * 1000  // 3 minutes max inactivity timeout (hard fallback)

export function useStreaming(ctx) {
  const messages = ctx.messages

  /* --- Loading guard --- */

  function startLoadingGuard() {
    clearLoadingGuard()
    ctx.state.lastEventAt = Date.now()
    ctx.state.loadingTimer = setInterval(() => {
      if (ctx.loading.value && Date.now() - ctx.state.lastEventAt > MAX_SSE_TIMEOUT) {
        console.debug('[useChat] loading guard triggered — auto-resetting stuck loading state (inactive for 10m)')
        if (ctx.state.abortController) {
          ctx.state.abortController.abort()
          ctx.state.abortController = null
        }
        ctx.loading.value = false
        ctx.state.currentRunId = null
        clearLoadingGuard()
      }
    }, 30000)
  }

  function clearLoadingGuard() {
    if (ctx.state.loadingTimer) {
      clearInterval(ctx.state.loadingTimer)
      ctx.state.loadingTimer = null
    }
  }

  function refreshLoadingGuard() {
    ctx.state.lastEventAt = Date.now()
  }

  /* --- v2 recovery watchdog --- */

  function clearV2RecoveryTimer() {
    if (ctx.state.v2RecoveryTimer) {
      clearTimeout(ctx.state.v2RecoveryTimer)
      ctx.state.v2RecoveryTimer = null
    }
  }

  function setV2RecoveryTimer(handler, delayMs) {
    clearV2RecoveryTimer()
    ctx.state.v2RecoveryTimer = setTimeout(handler, delayMs)
  }

  /* --- Request id --- */

  function beginStreamingRequest() {
    ctx.state.activeRequestId += 1
    ctx.state.suspendedRequestId = null
    return ctx.state.activeRequestId
  }

  function isCurrentRequest(requestId) {
    return requestId === ctx.state.activeRequestId
  }

  /* --- Poll announce result --- */

  async function pollAnnounceResult(runId, aiMsg) {
    const maxAttempts = 20
    const interval = 5000
    const originalMainLen = (aiMsg.content || '').length

    for (let i = 0; i < maxAttempts; i++) {
      if (ctx.state.cancelled) return
      await new Promise(r => setTimeout(r, interval))
      try {
        const resp = await fetch(CHAT_RESULT_URL(runId), {
          headers: { Authorization: `Bearer ${ctx.token.value}` },
        })
        if (!resp.ok) break
        const data = await resp.json()
        const mainText = data.mainText ?? data.text ?? ''

        if (mainText && mainText.length > originalMainLen) {
          aiMsg.content = mainText
          ctx.scrollToBottom()
        }

        if (data.status === 'done') {
          if (mainText && mainText.length > (aiMsg.content || '').length) {
            aiMsg.content = mainText
            ctx.scrollToBottom()
          }
          return
        }
      } catch (err) {
        console.debug('[useChat] announce poll error:', err)
      }
    }
  }

  /* --- Try recover result (used by v2 watchdog and legacy retry) --- */

  async function tryRecoverResult(runId, aiMsg, tokenRef) {
    const maxAttempts = 30
    const interval = 3000

    for (let i = 0; i < maxAttempts; i++) {
      if (ctx.state.cancelled) return false
      try {
        const resp = await fetch(CHAT_RESULT_URL(runId), {
          headers: { Authorization: `Bearer ${tokenRef.value}` },
        })
        if (!resp.ok) {
          console.debug('[useChat] recover poll failed:', resp.status)
          break
        }
        const data = await resp.json()
        const mainText = data.mainText ?? data.text ?? ''

        if (mainText && mainText.length > aiMsg.content.replace('⏳ 恢复中...', '').length) {
          aiMsg.content = mainText
          syncMessageMediaFromContent(aiMsg, ctx.token.value)
          ctx.scrollToBottom()
        }

        if (data.status === 'done') {
          if (mainText) {
            aiMsg.content = mainText
            syncMessageMediaFromContent(aiMsg, ctx.token.value)
          }
          ctx.scrollToBottom()
          return true
        }
      } catch (err) {
        console.error('[useChat] recover poll error:', err)
      }
      await new Promise(r => setTimeout(r, interval))
    }
    return false
  }

  /* --- Per-request SSE stream processor --- */

  async function processSSEStream(resp, aiMsg) {
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sseCount = 0
    let streamDone = false
    let assistantDeltaText = ''

    ctx.state.currentRunId = resp.headers.get('X-Run-Id')

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6)
        if (raw === '[DONE]') continue
        try {
          const data = JSON.parse(raw)
          sseCount++
          aiMsg.sseCount = sseCount
          if (data.type === 'model') {
            if (ctx.onModelUpdate && data.model) {
              ctx.onModelUpdate(data.model, {
                source: data.source || 'sse',
                sessionKey: ctx.sessionKey.value,
                runId: ctx.state.currentRunId,
              })
            }
            continue
          }
          if (data.type === 'text' && data.content) {
            assistantDeltaText = appendAssistantTextSafely(assistantDeltaText, data.content)
            aiMsg.content = appendAssistantTextSafely(aiMsg.content, data.content)
            syncMessageMediaFromContent(aiMsg, ctx.token.value)
            await flushStreamUpdate()
          }
          if (data.type === 'file' && data.file) {
            addFileToMessage(aiMsg, data.file)
          }
          if (data.type === 'tool_use') {
            startToolStep(aiMsg, data)
            await flushStreamUpdate()
          }
          if (data.type === 'command_output' && data.text) {
            appendCommandOutputStep(aiMsg, data.text, ctx.token.value)
            await flushStreamUpdate()
          }
          if (data.type === 'tool_result') {
            updateToolResultStep(aiMsg, data, ctx.token.value)
            await flushStreamUpdate()
          }
          if (data.type === 'plan' && data.text) {
            addTextStep(aiMsg, 'plan', data.text)
            await flushStreamUpdate()
          }
          if (data.type === 'status' && data.message) {
            addStatusStep(aiMsg, data.message)
            await flushStreamUpdate()
          }
          if (data.type === 'full_result' && data.text) {
            if (!aiMsg.content || aiMsg.content !== data.text) {
              aiMsg.content = data.text
              syncMessageMediaFromContent(aiMsg, ctx.token.value)
              await flushStreamUpdate()
            }
          }
          if (data.type === 'done' || data.type === 'error') {
            streamDone = true
            break
          }
          refreshLoadingGuard()
        } catch (err) {
          console.error('[useChat] SSE parse error:', err, 'raw:', raw)
        }
      }
      if (streamDone) break
      ctx.scrollToBottom()
    }

    const finalAssistantText = (aiMsg.content || assistantDeltaText).trim()
    if (FILTERED_STREAM_TEXTS.includes(finalAssistantText)) {
      const idx = messages.value.indexOf(aiMsg)
      if (idx >= 0) {
        messages.value.splice(idx, 1)
        await flushStreamUpdate()
      }
    }

    if (streamDone && ctx.state.currentRunId) {
      const runId = ctx.state.currentRunId
      await pollAnnounceResult(runId, aiMsg)
    }
  }

  /* --- Lifecycle event handlers --- */

  function handleSnapshot(event) {
    const snap = event.payload || {}
    const activeRuns = snap.activeRuns || {}
    const activeRunIds = Object.keys(activeRuns)

    for (const [rid, runInfo] of Object.entries(activeRuns)) {
      if (runInfo.status === 'streaming') {
        ctx.state.currentRunId = rid
        const existingStreaming = findActiveStreamingMessage(messages.value)
        const existingLast = messages.value[messages.value.length - 1]
        if (existingStreaming) {
          ctx.state.aiMsg = existingStreaming
        } else if (existingLast && existingLast.role === 'assistant' && !existingLast.content && messages.value.length > 0) {
          ctx.state.aiMsg = existingLast
        } else {
          ctx.state.aiMsg = createAiMessage(Date.now() + Math.random())
          messages.value.push(ctx.state.aiMsg)
        }
        ctx.state.aiMsg.isStreaming = true
        ctx.state.aiMsg.runId = rid
        if (runInfo.mainText) {
          ctx.state.aiMsg.content = runInfo.mainText
          syncMessageMediaFromContent(ctx.state.aiMsg, ctx.token.value)
        }
        if (runInfo.steps?.length) {
          if (ctx.state.aiMsg) ctx.state.aiMsg.steps = runInfo.steps
        }
        ctx.loading.value = true
        ctx.scrollToBottom()
        console.debug('[useChat] snapshot restored active run:', rid, 'textLen:', (runInfo.mainText || '').length)
        return
      }
    }

    if (activeRunIds.length === 0 && snap.lastRunId && snap.lastRunText) {
      const existingByRunId = messages.value.find(m => m.runId === snap.lastRunId)
      const existingByContent = messages.value.find(m =>
        m.role === 'assistant' && m.content && m.content === snap.lastRunText
      )
      if (existingByRunId) {
        existingByRunId.content = snap.lastRunText
        syncMessageMediaFromContent(existingByRunId, ctx.token.value)
        console.debug('[useChat] snapshot updated existing message from lastRunText, len:', snap.lastRunText.length)
      } else if (existingByContent) {
        existingByContent.runId = snap.lastRunId
        console.debug('[useChat] snapshot matched existing message by content, skipping duplicate')
      } else {
        const lastAssistant = findLastAssistantMessage(messages.value)
        if (lastAssistant && !lastAssistant.content) {
          lastAssistant.content = snap.lastRunText
          lastAssistant.runId = snap.lastRunId
          syncMessageMediaFromContent(lastAssistant, ctx.token.value)
          console.debug('[useChat] snapshot filled last assistant from lastRunText, len:', snap.lastRunText.length)
        } else if (!lastAssistant || lastAssistant.content !== snap.lastRunText) {
          const aiMsg = createAiMessage(Date.now() + Math.random())
          aiMsg.content = snap.lastRunText
          aiMsg.runId = snap.lastRunId
          syncMessageMediaFromContent(aiMsg, ctx.token.value)
          messages.value.push(aiMsg)
          console.debug('[useChat] snapshot appended completed run as new message, len:', snap.lastRunText.length)
        }
      }
    }

    if (ctx.state.currentRunId && ctx.getStreamMode() === 'events') {
      // Already have a runId waiting for events, do not force-reset loading
    } else {
      ctx.loading.value = false
      if (ctx.state.aiMsg) ctx.state.aiMsg.isStreaming = false
      ctx.state.currentRunId = null
      ctx.state.aiMsg = null
      clearLoadingGuard()
      console.debug('[useChat] snapshot: no active runs, loading reset')
    }
  }

  function handleRunStarted(runId) {
    if (runId) {
      ctx.state.currentRunId = runId
    }
    if (ctx.state.aiMsg) {
      ctx.state.aiMsg.isStreaming = true
    }
  }

  function handleRunEnd(runId) {
    if (runId && ctx.state.currentRunId && runId !== ctx.state.currentRunId) {
      console.debug('[useChat] run.end ignored for stale runId:', runId, 'current:', ctx.state.currentRunId)
      return
    }
    ctx.loading.value = false
    if (ctx.state.aiMsg) ctx.state.aiMsg.isStreaming = false
    // Clean up empty assistant messages
    const lastMsg = messages.value[messages.value.length - 1]
    if (lastMsg?.role === 'assistant' && !lastMsg.content?.trim() && !lastMsg.steps?.length) {
      messages.value.pop()
    }
    ctx.scrollToBottom()
  }

  function handleRunDone(runId) {
    if (runId && ctx.state.currentRunId && runId !== ctx.state.currentRunId) {
      console.debug('[useChat] run.done ignored for stale runId:', runId, 'current:', ctx.state.currentRunId)
      return
    }
    ctx.loading.value = false
    if (ctx.state.aiMsg) ctx.state.aiMsg.isStreaming = false
    ctx.state.currentRunId = null
    // Clean up empty assistant messages
    const lastMsg = messages.value[messages.value.length - 1]
    if (lastMsg?.role === 'assistant' && !lastMsg.content?.trim() && !lastMsg.steps?.length) {
      messages.value.pop()
    }
    ctx.state.aiMsg = null
    ctx.scrollToBottom()
  }

  function handleRunError(payload, runId) {
    if (runId && ctx.state.currentRunId && runId !== ctx.state.currentRunId) {
      console.debug('[useChat] run.error ignored for stale runId:', runId, 'current:', ctx.state.currentRunId)
      return
    }
    const errorText = payload.error || ''
    ctx.loading.value = false
    if (ctx.state.aiMsg) ctx.state.aiMsg.isStreaming = false
    if (errorText) {
      const errMsg = createAiMessage(Date.now() + Math.random())
      errMsg.content = `⚠️ 模型错误：${errorText}`
      errMsg.isStreaming = false
      messages.value.push(errMsg)
      console.error('[useChat] run.error:', errorText)
    }
    ctx.state.currentRunId = null
    ctx.state.aiMsg = null
    ctx.scrollToBottom()
  }

  return {
    startLoadingGuard,
    clearLoadingGuard,
    refreshLoadingGuard,
    clearV2RecoveryTimer,
    setV2RecoveryTimer,
    beginStreamingRequest,
    isCurrentRequest,
    pollAnnounceResult,
    tryRecoverResult,
    processSSEStream,
    handleSnapshot,
    handleRunStarted,
    handleRunEnd,
    handleRunDone,
    handleRunError,
  }
}
