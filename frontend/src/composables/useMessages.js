import { ref, reactive, nextTick } from 'vue'
import { detectMediaUrls } from '../utils/format.js'

export const MAX_TOOL_SUMMARY_LENGTH = 200
export const FILTERED_STREAM_TEXTS = ['NO_REPLY', 'HEARTBEAT_OK']

export const flushStreamUpdate = () => nextTick()

/* ─── Pure helpers ─── */

export function appendAssistantTextSafely(currentText = '', incomingText = '') {
  if (!incomingText) return currentText
  if (!currentText) return incomingText
  if (incomingText === currentText) return currentText
  if (currentText.endsWith(incomingText)) return currentText
  if (incomingText.startsWith(currentText)) return incomingText

  let overlap = 0
  const maxOverlap = Math.min(currentText.length, incomingText.length)
  for (let i = maxOverlap; i > 0; i--) {
    if (currentText.slice(-i) === incomingText.slice(0, i)) {
      overlap = i
      break
    }
  }
  return currentText + incomingText.slice(overlap)
}

export function createEmptyMedia() {
  return { text: '', images: [], pdfs: [] }
}

export function ensureMessageMedia(msg) {
  if (!msg.media) {
    msg.media = createEmptyMedia()
  } else {
    if (!Array.isArray(msg.media.images)) msg.media.images = []
    if (!Array.isArray(msg.media.pdfs)) msg.media.pdfs = []
    if (typeof msg.media.text !== 'string') msg.media.text = ''
  }
  return msg.media
}

export function syncMessageMediaFromContent(msg, token = '', contentField = 'content') {
  if (!msg || msg.role !== 'assistant') return
  const parsed = detectMediaUrls(msg[contentField] || '', token)
  const media = ensureMessageMedia(msg)
  media.text = parsed.text || ''
  media.images = Array.from(new Set([...(media.images || []), ...(parsed.images || [])]))
  media.pdfs = Array.from(new Set([...(media.pdfs || []), ...(parsed.pdfs || [])]))
}

export function scanAndMergeMedia(msg, text, token = '') {
  if (!msg || !text || msg.role !== 'assistant') return
  const parsed = detectMediaUrls(text, token)
  if (!parsed.images.length && !parsed.pdfs.length) return
  const media = ensureMessageMedia(msg)
  media.images = Array.from(new Set([...media.images, ...parsed.images]))
  media.pdfs = Array.from(new Set([...media.pdfs, ...parsed.pdfs]))
}

export function addFileToMessage(msg, file) {
  if (!msg || !file) return
  const url = file.url || ''
  const contentType = (file.content_type || file.contentType || '').toLowerCase()
  const filename = (file.filename || '').toLowerCase()
  const isImage = contentType.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|ico)(\?|$)/i.test(filename) || /\.(png|jpe?g|gif|webp|svg|bmp|ico)(\?|$)/i.test(url)
  const isPdf = contentType.includes('pdf') || /\.pdf(\?|$)/i.test(filename) || /\.pdf(\?|$)/i.test(url)

  if ((isImage || isPdf) && /^https?:\/\//i.test(url)) {
    const media = ensureMessageMedia(msg)
    if (isImage && !media.images.includes(url)) media.images.push(url)
    if (isPdf && !media.pdfs.includes(url)) media.pdfs.push(url)
    return
  }

  if (!Array.isArray(msg.files)) msg.files = []
  if (!msg.files.some((item) => item.url === file.url && item.filename === file.filename)) {
    msg.files.push(file)
  }
}

export function createAiMessage(id = Date.now() + 1) {
  return reactive({
    id,
    role: 'assistant',
    content: '',
    acpContent: '',
    acpExpanded: true,
    acpSteps: [],
    sseCount: 0,
    files: [],
    media: createEmptyMedia(),
    steps: [],
    isStreaming: false,
  })
}

export function createAcpMessage(id = Date.now() + Math.random()) {
  return reactive({
    id,
    role: 'assistant',
    content: '',
    acpContent: '',
    acpStatus: 'running',
    sseCount: 0,
    files: [],
    media: createEmptyMedia(),
    steps: [],
    isAcpCard: true,
    acpExpanded: true,
  })
}

export function findActiveStreamingMessage(messageList = []) {
  for (let i = messageList.length - 1; i >= 0; i--) {
    const msg = messageList[i]
    if (msg?.role === 'assistant' && !msg.isAcpCard && msg.isStreaming) {
      return msg
    }
  }
  return null
}

export function findLastAssistantMessage(messageList = []) {
  for (let i = messageList.length - 1; i >= 0; i--) {
    const msg = messageList[i]
    if (msg?.role === 'assistant' && !msg.isAcpCard) {
      return msg
    }
  }
  return null
}

export function ensureCurrentAssistant(messagesRef, currentMsg) {
  if (currentMsg) return currentMsg
  const existing = findActiveStreamingMessage(messagesRef.value)
  if (existing) return existing
  const aiMsg = createAiMessage(Date.now() + Math.random())
  aiMsg.isStreaming = true
  messagesRef.value.push(aiMsg)
  return aiMsg
}

export function truncateStepSummary(text = '') {
  if (!text) return ''
  return text.length > MAX_TOOL_SUMMARY_LENGTH
    ? `${text.slice(0, MAX_TOOL_SUMMARY_LENGTH)}...`
    : text
}

export function ensureSteps(aiMsg) {
  if (!Array.isArray(aiMsg.steps)) {
    aiMsg.steps = []
  }
  return aiMsg.steps
}

export function findLatestToolStep(aiMsg, toolName) {
  const steps = ensureSteps(aiMsg)
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.type === 'tool' && step.name === toolName) {
      return step
    }
  }
  return null
}

export function appendStep(aiMsg, step) {
  ensureSteps(aiMsg).push(step)
  return step
}

export function addTextStep(aiMsg, type, text) {
  if (!text) return null
  return appendStep(aiMsg, { type, text })
}

export function addStatusStep(aiMsg, message) {
  if (!message) return null
  return appendStep(aiMsg, { type: 'status', message })
}

export function startToolStep(aiMsg, data) {
  const name = data.name || data.tool || 'tool'
  const step = findLatestToolStep(aiMsg, name)
  if (step && step.status === 'running') {
    return step
  }
  return appendStep(aiMsg, {
    type: 'tool',
    name,
    tool: data.tool || name,
    status: 'running',
    output: '',
    summary: '',
    expanded: true,
  })
}

export function updateToolResultStep(aiMsg, data, token = '') {
  const name = data.name || data.tool || 'tool'
  let step = findLatestToolStep(aiMsg, name)
  if (!step) {
    const steps = ensureSteps(aiMsg)
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].type === 'tool' && steps[i].status === 'running') {
        step = steps[i]
        break
      }
    }
  }
  if (!step) {
    step = startToolStep(aiMsg, data)
  }
  step.status = 'done'
  step.tool = data.tool || step.tool || name
  step.summary = truncateStepSummary(data.summary || '')
  const scanText = data.summary || data.content || data.text || ''
  if (scanText) scanAndMergeMedia(aiMsg, scanText, token)
  return step
}

export function appendCommandOutputStep(aiMsg, text, token = '') {
  if (!text) return null
  const steps = ensureSteps(aiMsg)
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.type === 'tool' && step.status === 'running') {
      step.output = step.output ? `${step.output}${text}` : text
      scanAndMergeMedia(aiMsg, text, token)
      return step
    }
  }
  scanAndMergeMedia(aiMsg, text, token)
  return appendStep(aiMsg, {
    type: 'tool',
    name: 'command',
    tool: 'command',
    status: 'running',
    output: text,
    summary: '',
    expanded: true,
  })
}

/* ─── Composable ─── */

export function useMessages(ctx) {
  const messages = ref([])
  ctx.messages = messages

  function ensureCurrentAssistantMsg() {
    const aiMsg = ensureCurrentAssistant(messages, ctx.state.aiMsg)
    ctx.state.aiMsg = aiMsg
    return aiMsg
  }

  function findActiveStreaming() {
    return findActiveStreamingMessage(messages.value)
  }

  function findLastAssistant() {
    return findLastAssistantMessage(messages.value)
  }

  /**
   * Handle assistant.delta event (main stream content).
   * Returns true if handled, false to delegate to ACP path.
   */
  function applyAssistantDelta(delta) {
    if (!delta) return
    const aiMsg = ensureCurrentAssistantMsg()
    aiMsg.content = appendAssistantTextSafely(aiMsg.content, delta)
    syncMessageMediaFromContent(aiMsg, ctx.token.value)
  }

  /**
   * Handle full_result event (overwrites content if clearly more complete).
   */
  function applyFullResult(fullText) {
    if (!ctx.state.aiMsg) return
    if (!fullText) return
    if (FILTERED_STREAM_TEXTS.includes(fullText.trim())) {
      const idx = messages.value.indexOf(ctx.state.aiMsg)
      if (idx >= 0) messages.value.splice(idx, 1)
      ctx.state.aiMsg = null
      return
    }
    const aiMsg = ctx.state.aiMsg
    const currentContent = aiMsg.content || ''
    if (!currentContent.trim()) {
      aiMsg.content = fullText
    } else if (fullText.startsWith(currentContent) || currentContent.startsWith(fullText)) {
      aiMsg.content = fullText
    } else if (fullText.length > currentContent.length * 1.5) {
      aiMsg.content = fullText
    }
    syncMessageMediaFromContent(aiMsg, ctx.token.value)
  }

  /**
   * Visible steps: for compatibility, expose helpers that filter
   * step arrays. Currently steps live on individual messages and
   * are read directly by ChatPage.vue, but exposing this here keeps
   * the door open for future filtering logic.
   */
  function visibleSteps(msg) {
    if (!msg) return []
    return ensureSteps(msg)
  }

  return {
    messages,
    ensureCurrentAssistant: ensureCurrentAssistantMsg,
    findActiveStreaming,
    findLastAssistant,
    applyAssistantDelta,
    applyFullResult,
    visibleSteps,
  }
}
