<template>
  <van-popup v-model:show="visible" position="left" :style="{ width: '78%', maxWidth: '360px', height: '100%' }" class="session-drawer">
    <div class="session-panel">
      <!-- Header -->
      <div class="session-header">
        <h3>全部会话</h3>
        <div class="session-header-actions">
          <van-button size="small" class="new-session-btn" @click="handleNew">
            <span class="new-session-btn__content">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              <span>新建</span>
            </span>
          </van-button>
          <van-button size="small" class="refresh-btn" @click="loadAllSessions">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </van-button>
        </div>
      </div>

      <!-- Agent Filter -->
      <div class="agent-filter">
        <div
          v-for="opt in agentOptions"
          :key="opt.id"
          :class="['agent-filter-item', { active: selectedAgentId === opt.id }]"
          @click="selectedAgentId = opt.id"
        >{{ opt.name }}</div>
      </div>

      <!-- Session List -->
      <div class="session-list">
        <div
          v-for="s in sessions"
          :key="s.sessionKey"
          :class="['session-item', { active: s.sessionKey === props.currentSessionKey }]"
          @click="handleView(s)"
        >
          <div :class="['session-icon', `agent-${s.agentId}`]">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <div class="session-info">
            <div class="session-name">
              <span class="user-badge">{{ s.displayName || s.username }}</span>
              <span :class="['agent-badge', `agent-${s.agentId}`]">{{ getAgentName(s) }}</span>
            </div>
            <div class="session-meta">
              <span v-if="s.title" class="session-title">{{ s.title }}</span>
              <span class="session-time">{{ formatTime(s) }}</span>
              <span v-if="s.status === 'generating'" class="status-generating">生成中</span>
            </div>
          </div>
          <div v-if="s.sessionKey === props.currentSessionKey" class="session-active-badge">当前</div>
          <div v-else class="session-view-btn">查看</div>
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
import { API_BASE, API_ADMIN_SESSIONS } from '../constants/index.js'

const props = defineProps({
  show: { type: Boolean, default: false },
  token: { type: String, default: '' },
  agents: { type: Array, default: () => [] },
  currentSessionKey: { type: String, default: '' },
})

const emit = defineEmits(['update:show', 'view-session', 'new'])

const visible = computed({
  get: () => props.show,
  set: (v) => emit('update:show', v),
})

const sessions = ref([])
const loading = ref(false)
const selectedAgentId = ref('')

const agentOptions = computed(() => {
  const opts = [{ id: '', name: '全部' }]
  for (const a of props.agents) {
    opts.push({ id: a.id, name: a.name })
  }
  return opts
})

watch([() => props.show, selectedAgentId], ([isOpen]) => {
  if (isOpen) loadAllSessions()
})

async function loadAllSessions() {
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (selectedAgentId.value) params.set('agent_id', selectedAgentId.value)
    const r = await fetch(`${API_BASE}${API_ADMIN_SESSIONS}?${params}`, {
      headers: { Authorization: `Bearer ${props.token}` },
    })
    if (r.ok) {
      const data = await r.json()
      sessions.value = data.sessions || []
    } else if (r.status === 403) {
      sessions.value = []
    }
  } catch (err) {
    console.error('[SessionMonitor] load failed:', err)
  } finally {
    loading.value = false
  }
}

function handleView(s) {
  emit('view-session', s)
  visible.value = false
}

function handleNew() {
  emit('new')
  visible.value = false
}

function getAgentName(s) {
  const agentId = s.agentId || ''
  return props.agents.find(a => a.id === agentId)?.name || agentId
}

function formatTime(s) {
  const ts = s.createdAt || s.updatedAt
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
/* ── Drawer base ── */
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
.session-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* New session button */
.new-session-btn {
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
}
.new-session-btn.van-button {
  background: var(--accent);
  border: none;
  color: white;
  box-shadow: 0 2px 8px rgba(0, 122, 255, 0.25);
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

/* Refresh button */
.refresh-btn.van-button {
  background: transparent;
  border: 1.5px solid var(--border);
  color: #666;
  border-radius: 8px;
  width: 32px;
  height: 32px;
  padding: 0;
}
.refresh-btn.van-button:active {
  transform: scale(0.9);
}
.refresh-btn .van-button__content {
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ── Agent filter bar ── */
.agent-filter {
  display: flex;
  gap: 6px;
  padding: 10px 14px;
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
}
.agent-filter-item {
  flex-shrink: 0;
  padding: 4px 12px;
  border-radius: 14px;
  font-size: 12px;
  font-weight: 500;
  color: #666;
  background: rgba(255, 255, 255, 0.6);
  border: 1.5px solid var(--border);
  cursor: pointer;
  transition: all 0.2s ease;
}
.agent-filter-item.active {
  color: white;
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 2px 6px rgba(0, 122, 255, 0.2);
}

/* ── Session list ── */
.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px;
  -webkit-overflow-scrolling: touch;
}
.session-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 14px;
  border-radius: 14px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  background: rgba(255, 255, 255, 0.6);
  border: 1.5px solid transparent;
}
.session-item:hover {
  background: rgba(255, 255, 255, 0.95);
  border-color: rgba(0, 122, 255, 0.15);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}
.session-item:active {
  transform: scale(0.98);
  background: rgba(0, 122, 255, 0.04);
}
.session-item.active {
  background: rgba(0, 122, 255, 0.06);
  border-color: var(--accent);
  box-shadow: 0 2px 8px rgba(0, 122, 255, 0.1);
}
.session-item.active .session-icon {
  background: var(--accent);
  color: white;
}
.session-item.active .user-badge {
  color: var(--accent);
}

/* Session icon */
.session-icon {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.session-icon.agent-main {
  background: rgba(59, 130, 246, 0.1);
  color: #3B82F6;
}
.session-icon.agent-dev {
  background: rgba(16, 185, 129, 0.1);
  color: #10B981;
}
.session-icon.agent-user {
  background: rgba(156, 163, 175, 0.1);
  color: #6B7280;
}

/* Session info */
.session-info {
  flex: 1;
  min-width: 0;
}
.session-name {
  display: flex;
  align-items: center;
  gap: 6px;
  line-height: 1.3;
}
.user-badge {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.agent-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 500;
}
.agent-badge.agent-main { background: rgba(59, 130, 246, 0.1); color: #3B82F6; }
.agent-badge.agent-dev { background: rgba(16, 185, 129, 0.1); color: #10B981; }
.agent-badge.agent-user { background: rgba(156, 163, 175, 0.1); color: #6B7280; }

.session-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.session-title {
  font-size: 12px;
  color: #999;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
}
.session-time {
  font-size: 12px;
  color: #aaa;
}

/* Generating status */
.status-generating {
  font-size: 10px;
  color: #F59E0B;
  font-weight: 600;
  animation: pulse-opacity 1.5s ease-in-out infinite;
}
@keyframes pulse-opacity {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* View button & Active badge — shared alignment */
.session-view-btn,
.session-active-badge {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  line-height: 20px;
  padding: 2px 10px;
  border-radius: 6px;
  white-space: nowrap;
  align-self: center;
}
.session-view-btn {
  color: var(--accent);
  background: rgba(0, 122, 255, 0.06);
  border: 1px solid rgba(0, 122, 255, 0.15);
  transition: all 0.2s ease;
}
.session-item:hover .session-view-btn {
  background: rgba(0, 122, 255, 0.1);
  border-color: rgba(0, 122, 255, 0.3);
}
.session-active-badge {
  color: var(--accent);
  background: rgba(0, 122, 255, 0.08);
}

/* Empty state */
.session-empty {
  text-align: center;
  color: #aaa;
  font-size: 14px;
  padding: 40px 0;
}

/* Active badge */
.session-active-badge {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  padding: 3px 10px;
  border-radius: 6px;
  background: rgba(0, 122, 255, 0.08);
}
</style>
