/**
 * useEventStream — Persistent SSE connection to /api/events
 *
 * Phase 2: fires onEvent callback for every event received.
 * Phase 1 still active: console logging.
 */
import { ref, onBeforeUnmount } from 'vue'
import { API_BASE } from '../constants/index.js'

const RECONNECT_DELAYS = [500, 1000, 2000, 5000, 10000, 15000]
const FETCH_TIMEOUT_MS = 30000 // 30s fetch timeout to prevent hung connections
const STALL_TIMEOUT_MS = 180000 // 3min without any data = treat as stalled (agent tools can take minutes)

const ACK_BATCH_SIZE = 5
const ACK_IDLE_MS = 2000
const SEEN_EVENT_IDS_LIMIT = 200

export function useEventStream(tokenRef, sessionKeyRef, options = {}) {
  const connected = ref(false)
  const reconnecting = ref(false)
  const lastEventId = ref(null)
  const lastAckEventId = ref(null)
  const eventCount = ref(0)
  const lastDataAt = ref(0)

  const onEvent = options.onEvent || null

  let abortController = null
  let reconnectAttempt = 0
  let reconnectTimer = null
  let active = false
  let stallTimer = null

  // --- ACK queue ---
  let ackPendingCount = 0
  let ackIdleTimer = null

  // --- Dedup ---
  const _seenEventIds = new Set()
  const _seenEventIdsList = [] // FIFO helper for eviction

  function _sendAck() {
    const targetId = lastEventId.value
    if (!targetId || targetId === lastAckEventId.value) return
    lastAckEventId.value = targetId
    fetch(`${API_BASE}/events/ack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenRef.value}`,
      },
      body: JSON.stringify({
        sessionKey: sessionKeyRef.value,
        eventId: targetId,
      }),
    }).catch(() => {
      // fire-and-forget: silently ignore failures
    })
  }

  function _scheduleAck() {
    ackPendingCount++
    if (ackPendingCount >= ACK_BATCH_SIZE) {
      ackPendingCount = 0
      _clearAckIdleTimer()
      _sendAck()
      return
    }
    _resetAckIdleTimer()
  }

  function _clearAckIdleTimer() {
    if (ackIdleTimer) {
      clearTimeout(ackIdleTimer)
      ackIdleTimer = null
    }
  }

  function _resetAckIdleTimer() {
    _clearAckIdleTimer()
    ackIdleTimer = setTimeout(() => {
      ackIdleTimer = null
      if (ackPendingCount > 0) {
        ackPendingCount = 0
        _sendAck()
      }
    }, ACK_IDLE_MS)
  }

  function _isDuplicate(eventId) {
    if (!eventId) return false
    if (_seenEventIds.has(eventId)) return true
    _seenEventIds.add(eventId)
    _seenEventIdsList.push(eventId)
    if (_seenEventIdsList.length > SEEN_EVENT_IDS_LIMIT) {
      // Evict oldest half
      const toEvict = Math.floor(SEEN_EVENT_IDS_LIMIT / 2)
      for (let i = 0; i < toEvict; i++) {
        _seenEventIds.delete(_seenEventIdsList.shift())
      }
    }
    return false
  }

  function _dedupSnapshot(event) {
    const payload = event.payload || {}
    if (Array.isArray(payload.messages)) {
      payload.messages = payload.messages.filter((m) => !m.eventId || !_isDuplicate(m.eventId))
    }
    // Also dedup any nested events array if present
    if (Array.isArray(payload.events)) {
      payload.events = payload.events.filter((e) => !e.eventId || !_isDuplicate(e.eventId))
    }
    return event
  }

  async function connect() {
    if (active) return
    active = true
    reconnectAttempt = 0
    _doConnect()
  }

  function _clearStallTimer() {
    if (stallTimer) {
      clearTimeout(stallTimer)
      stallTimer = null
    }
  }

  function _resetStallTimer(controller) {
    _clearStallTimer()
    stallTimer = setTimeout(() => {
      console.debug('[EventStream] stalled — no data for', STALL_TIMEOUT_MS, 'ms, aborting')
      try {
        controller.abort()
      } catch (_e) {
        // ignore
      }
    }, STALL_TIMEOUT_MS)
  }

  async function _doConnect() {
    if (!active || !tokenRef.value || !sessionKeyRef.value) {
      return
    }

    if (abortController) {
      abortController.abort()
      abortController = null
    }

    abortController = new AbortController()
    const controller = abortController

    const params = new URLSearchParams({
      sessionKey: sessionKeyRef.value,
    })
    if (lastEventId.value) {
      params.set('lastEventId', lastEventId.value)
    }

    const url = `${API_BASE}/events?${params}`
    reconnecting.value = true

    const fetchTimeoutId = setTimeout(() => {
      console.debug('[EventStream] fetch timeout, aborting')
      try {
        controller.abort()
      } catch (_e) {}
    }, FETCH_TIMEOUT_MS)

    try {
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${tokenRef.value}`,
          Accept: 'text/event-stream',
        },
        signal: controller.signal,
      })

      clearTimeout(fetchTimeoutId)

      if (!resp.ok) {
        console.error('[EventStream] HTTP error:', resp.status, resp.statusText)
        _scheduleReconnect()
        return
      }

      connected.value = true
      reconnecting.value = false
      reconnectAttempt = 0
      lastDataAt.value = Date.now()

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      _resetStallTimer(controller)

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        _resetStallTimer(controller)
        lastDataAt.value = Date.now()

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6)
          if (!raw || raw === '{}') continue

          try {
            const event = JSON.parse(raw)
            eventCount.value++
            if (event.eventId) lastEventId.value = event.eventId

            // Dedup check before firing callback
            if (event.eventId && _isDuplicate(event.eventId)) {
              continue
            }
            if (event.kind === 'snapshot') {
              _dedupSnapshot(event)
            }

            // Phase 2: fire callback
            if (onEvent) {
              onEvent(event)
            }

            // Schedule ACK after successful processing
            _scheduleAck()
          } catch (err) {
            // Skip non-JSON (ping etc)
          }
        }
      }

      _scheduleReconnect()
    } catch (err) {
      clearTimeout(fetchTimeoutId)
      if (err.name === 'AbortError') {
        return
      }
      console.error('[EventStream] error:', err.message || err.name || err)
      _scheduleReconnect()
    } finally {
      _clearStallTimer()
      connected.value = false
      reconnecting.value = false
      abortController = null
    }
  }

  function _scheduleReconnect() {
    if (!active) return
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]
    reconnectAttempt++
    reconnecting.value = true
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      _doConnect()
    }, delay)
  }

  function disconnect() {
    active = false
    _clearStallTimer()
    _clearAckIdleTimer()
    ackPendingCount = 0
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (abortController) {
      abortController.abort()
      abortController = null
    }
    connected.value = false
    reconnecting.value = false
  }

  return { connected, reconnecting, lastEventId, lastAckEventId, eventCount, lastDataAt, connect, disconnect }
}

function _previewEvent(event) {
  const p = event.payload || {}
  if (event.kind === 'assistant.delta') return { delta: (p.delta || '').slice(0, 60) }
  if (event.kind?.startsWith('item.')) return { name: p.name, phase: p.phase }
  if (event.kind === 'command.output') return { text: (p.text || '').slice(0, 40) }
  if (event.kind?.startsWith('run.')) return { phase: p.phase }
  if (event.kind === 'full_result') return { textLen: (p.text || '').length }
  return {}
}
