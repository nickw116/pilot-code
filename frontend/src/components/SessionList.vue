<template>
  <van-popup v-model:show="visible" position="left" :style="{ width: '78%', maxWidth: '360px', height: '100%' }" class="session-drawer">
    <div class="session-panel">
      <!-- Header -->
      <div class="session-header">
        <h3>会话列表</h3>
        <van-button size="small" class="new-session-btn" @click="handleNew">
          <span class="new-session-btn__content">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            <span>新建</span>
          </span>
        </van-button>
      </div>

      <!-- Session List -->
      <div class="session-list">
        <div
          v-for="s in sessions"
          :key="s.sessionKey"
          :class="['session-item', { active: s.active }]"
          @click="handleSwitch(s)"
        >
          <div class="session-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <div class="session-info">
            <div class="session-name">{{ getAgentName(s) }}</div>
            <div class="session-time">{{ formatTime(s) }}</div>
          </div>
          <button
            v-if="!s.active"
            class="session-delete"
            @click.stop="handleDelete(s)"
            title="删除"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6"/>
              <path d="M14 11v6"/>
            </svg>
          </button>
          <div v-else class="session-active-badge">当前</div>
        </div>

        <div v-if="sessions.length === 0 && !loading" class="session-empty">
          暂无会话
        </div>
        <div v-if="loading" class="session-empty">加载中...</div>
      </div>
    </div>
  </van-popup>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { showConfirmDialog } from 'vant'
import { API_BASE, API_SESSIONS, API_SESSION_NEW } from '../constants/index.js'

const props = defineProps({
  show: { type: Boolean, default: false },
  token: { type: String, default: '' },
  currentSessionKey: { type: String, default: '' },
  currentAgentId: { type: String, default: 'main' },
  agents: { type: Array, default: () => [] },
})

const emit = defineEmits(['update:show', 'switch', 'new', 'delete'])

const visible = computed({
  get: () => props.show,
  set: (v) => emit('update:show', v),
})

const sessions = ref([])
const loading = ref(false)

// Refresh session list when drawer opens or agent changes
watch([() => props.show, () => props.currentAgentId], ([v]) => {
  if (v) loadSessions()
})

async function loadSessions() {
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (props.currentAgentId) params.set('agent_id', props.currentAgentId)
    const r = await fetch(`${API_BASE}${API_SESSIONS}?${params}`, {
      headers: { Authorization: `Bearer ${props.token}` },
    })
    if (r.ok) {
      const data = await r.json()
      sessions.value = data.sessions || []
    }
  } catch (err) {
    console.error('[SessionList] load failed:', err)
  } finally {
    loading.value = false
  }
}

function handleSwitch(s) {
  if (s.active) {
    visible.value = false
    return
  }
  emit('switch', s.sessionKey)
  sessions.value.forEach(item => { item.active = false })
  const target = sessions.value.find(item => item.sessionKey === s.sessionKey)
  if (target) target.active = true
  visible.value = false
}

async function handleNew() {
  emit('new')
  visible.value = false
}

async function handleDelete(s) {
  try {
    await showConfirmDialog({
      title: '删除会话',
      message: '确定要删除这个会话吗？',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      confirmButtonColor: '#EF4444',
    })
  } catch {
    return // Cancelled
  }
  try {
    const r = await fetch(`${API_BASE}${API_SESSIONS}?sessionKey=${encodeURIComponent(s.sessionKey)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${props.token}` },
    })
    if (r.ok) {
      sessions.value = sessions.value.filter(x => x.sessionKey !== s.sessionKey)
      emit('delete', s.sessionKey)
    }
  } catch (err) {
    console.error('[SessionList] delete failed:', err)
  }
}

function getAgentName(s) {
  const agentId = s.agentId || ''
  return props.agents.find(a => a.id === agentId)?.name || agentId || '会话'
}

function formatTime(s) {
  const ts = s.createdAt
  if (!ts) return ''
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${mi}`
}
</script>

<style>
/* ── Session Drawer ── */
.session-drawer.van-popup {
  background: var(--bg);
}
.session-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.session-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 18px 14px;
  border-bottom: 1px solid var(--border);
}
.session-header h3 {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}
.new-session-btn {
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
}
.new-session-btn.van-button {
  background: var(--accent);
  border: none;
  color: white;
  box-shadow: 0 2px 8px rgba(6, 182, 212, 0.25);
  padding: 0 12px;
  height: 32px;
}
.new-session-btn .van-button__content {
  display: flex;
  align-items: center;
  justify-content: center;
}
.new-session-btn__content {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  line-height: 1;
}
.new-session-btn:active { transform: scale(0.95); }

/* ── Session List ── */
.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px;
  -webkit-overflow-scrolling: touch;
}
.session-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 14px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  background: rgba(255, 255, 255, 0.6);
  border: 1.5px solid transparent;
}
.session-item:hover {
  background: rgba(255, 255, 255, 0.9);
}
.session-item:active {
  transform: scale(0.98);
}
.session-item.active {
  background: rgba(124, 58, 237, 0.08);
  border-color: var(--primary);
  box-shadow: 0 2px 8px rgba(124, 58, 237, 0.1);
}

.session-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: rgba(124, 58, 237, 0.1);
  color: var(--primary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.session-item.active .session-icon {
  background: var(--primary);
  color: white;
}

.session-info {
  flex: 1;
  min-width: 0;
}
.session-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}
.session-time {
  font-size: 12px;
  color: #999;
  line-height: 1.3;
  margin-top: 2px;
}
.session-item.active .session-name {
  color: var(--primary);
  font-weight: 600;
}

.session-delete {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: none;
  background: rgba(239, 68, 68, 0.08);
  color: #EF4444;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s ease;
  padding: 0;
}
.session-delete:hover {
  background: rgba(239, 68, 68, 0.15);
}
.session-delete:active {
  transform: scale(0.85);
}

.session-active-badge {
  font-size: 11px;
  color: var(--primary);
  font-weight: 600;
  flex-shrink: 0;
  padding: 2px 8px;
  background: rgba(124, 58, 237, 0.1);
  border-radius: 6px;
}

.session-empty {
  text-align: center;
  color: #aaa;
  font-size: 14px;
  padding: 40px 0;
}
</style>
