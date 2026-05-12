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
          :key="s.session_key"
          :class="['session-item', { active: s.active }]"
          @click="handleSwitch(s)"
        >
          <div class="session-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <div class="session-info">
            <div class="session-title">{{ s.title || formatTitle(s) }}</div>
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
})

const emit = defineEmits(['update:show', 'switch', 'new', 'delete'])

const visible = computed({
  get: () => props.show,
  set: (v) => emit('update:show', v),
})

const sessions = ref([])
const loading = ref(false)

// Refresh session list when drawer opens
watch(() => props.show, (v) => {
  if (v) loadSessions()
})

async function loadSessions() {
  loading.value = true
  try {
    const r = await fetch(`${API_BASE}${API_SESSIONS}`, {
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
    // Already active, just close drawer
    visible.value = false
    return
  }
  emit('switch', s.session_key)
  // Update local active state immediately
  sessions.value.forEach(item => { item.active = false })
  const target = sessions.value.find(item => item.session_key === s.session_key)
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
    const r = await fetch(`${API_BASE}${API_SESSIONS}?sessionKey=${encodeURIComponent(s.session_key)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${props.token}` },
    })
    if (r.ok) {
      sessions.value = sessions.value.filter(x => x.session_key !== s.session_key)
      emit('delete', s.session_key)
    }
  } catch (err) {
    console.error('[SessionList] delete failed:', err)
  }
}

function formatTitle(s) {
  // Extract a readable name from session key
  // Format: agent:{agent}:h5-{username}-{YYYYMMDD}-{HHMMSS}
  const parts = s.session_key.split('-')
  if (parts.length >= 3) {
    const datePart = parts[parts.length - 2]  // YYYYMMDD
    const timePart = parts[parts.length - 1]  // HHMMSS
    if (/^\d{8}$/.test(datePart) && /^\d{6}$/.test(timePart)) {
      const month = String(Number(datePart.slice(4, 6)))
      const day = String(Number(datePart.slice(6, 8)))
      const hour = timePart.slice(0, 2)
      const min = timePart.slice(2, 4)
      return `会话 ${month}月${day}日 ${hour}:${min}`
    }
  }
  return s.session_key.slice(0, 30)
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
.session-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-item.active .session-title {
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
