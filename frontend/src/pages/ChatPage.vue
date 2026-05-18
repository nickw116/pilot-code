<template>
  <div class="chat-page">
    <van-nav-bar fixed placeholder class="nav-bar">
      <template #left>
        <div class="nav-left-actions">
          <div
            v-if="props.canAccessMonitor"
            class="nav-btn-wrapper nav-monitor-btn"
            @click="$emit('open-monitor')"
            title="全部会话"
          >
            <van-icon name="bars" class="nav-action-icon" />
          </div>
        </div>
      </template>
      <template #title>
        <div class="nav-title-wrap">
          <span v-if="props.monitorMode" class="nav-title nav-title--monitor">MONITOR</span>
          <span v-else class="nav-title">PILOT AGENT</span>
          <div class="nav-sub-row">
            <button
              v-if="props.currentModel"
              class="nav-model-btn"
              @click="openModelPicker"
              :disabled="props.loading"
            >
              <span class="nav-model-text">{{ props.currentModel }}</span>
              <van-icon name="arrow-down" class="nav-model-arrow" />
            </button>
          </div>
        </div>
      </template>
      <template #right>
        <div class="nav-right-actions">
          <div class="nav-btn-wrapper" @click="reloadPage" :class="{ 'is-loading': refreshing }">
            <van-icon :name="refreshing ? '' : 'replay'" class="nav-action-icon nav-action-icon--refresh">
              <template v-if="refreshing"><van-loading type="spinner" size="18" color="currentColor" /></template>
            </van-icon>
          </div>
          <div class="nav-btn-wrapper" @click="$emit('open-settings')">
            <van-icon name="setting-o" class="nav-action-icon nav-action-icon--setting" />
          </div>
        </div>
      </template>
    </van-nav-bar>

    <!-- 服务状态提示条 -->
    <transition name="banner-slide">
      <div v-if="serviceStatus === 'down'" class="service-banner service-banner--down">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>服务正在重启，请稍候…</span>
      </div>
      <div v-else-if="serviceStatus === 'recovered'" class="service-banner service-banner--recovered">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <span>服务已恢复</span>
      </div>
    </transition>

    <!-- 历史消息加载中 -->
    <div v-if="(props.monitorMode ? props.monitorHistoryLoading : props.historyLoading) && (props.monitorMode ? props.monitorMessages : props.messages).length === 0" class="history-loading">
      <div class="history-loading__spinner">
        <div class="history-loading__ring"></div>
      </div>
      <div class="history-loading__text">加载历史消息…</div>
    </div>

    <!-- Monitor mode read-only banner -->
    <div v-else-if="props.monitorMode && props.monitorMessages.length === 0" class="empty-state">
      <div class="empty-greeting">暂无消息</div>
    </div>

    <!-- 空会话引导区 -->
    <div v-else-if="!props.monitorMode && props.messages.length === 0" class="empty-state">
      <div class="empty-greeting">有什么我能帮你的吗？</div>
      <div class="empty-cards">
        <button
          v-for="(card, idx) in suggestionCards"
          :key="idx"
          class="empty-card"
          @click="fillSuggestion(card.text)"
        >
          <span class="empty-card-icon">{{ card.icon }}</span>
          <span class="empty-card-text">{{ card.text }}</span>
        </button>
      </div>
    </div>

    <MessageList
      v-else
      ref="messageListRef"
      :messages="props.monitorMode ? props.monitorMessages : props.messages"
      :loading="props.monitorMode ? false : props.loading"
      :format-file-size="props.formatFileSize"
      :file-icon="props.fileIcon"
      :acp-logs="props.acpLogs"
      :acp-status="props.acpStatus"
      :current-agent-id="props.currentAgentId"
      @load-more="emit('load-more')"
    />

    <!-- Monitor mode: read-only banner -->
    <div v-if="props.monitorMode" class="monitor-banner">
      <span class="monitor-banner__info">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
        只读查看: {{ props.monitorUserInfo }}
      </span>
      <van-button size="small" type="primary" class="monitor-exit-btn" @click="$emit('exit-monitor')">退出</van-button>
    </div>

    <!-- Normal mode: message input -->
    <MessageInput
      v-else
      v-model="inputText"
      :loading="loading"
      :uploading="uploading"
      :upload-progress="uploadProgress"
      :attachments="attachments"
      @send="send"
      @abort="abort"
      @upload="(file) => $emit('upload', file)"
      @remove-attachment="(idx) => $emit('remove-attachment', idx)"
    />

    <!-- 模型选择器 -->
    <van-action-sheet
      v-model:show="modelPickerVisible"
      :actions="modelActions"
      cancel-text="取消"
      description="选择模型"
      close-on-click-action
      @select="onModelSelect"
    />
  </div>
</template>

<script setup>
import { ref, watch, nextTick, onMounted, computed } from 'vue'
import { API_BASE, TOKEN_KEY } from '../constants/index.js'
import MessageInput from '../components/MessageInput.vue'
import MessageList from '../components/MessageList.vue'

const props = defineProps({
  messages: { type: Array, default: () => [] },
  inputText: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  historyLoading: { type: Boolean, default: false },
  uploading: { type: Boolean, default: false },
  uploadProgress: { type: Number, default: 0 },
  attachments: { type: Array, default: () => [] },
  formatFileSize: { type: Function, default: () => '' },
  fileIcon: { type: Function, default: () => '📄' },
  serviceStatus: { type: String, default: 'up' },  // 'up' | 'down' | 'recovered'
  currentModel: { type: String, default: '' },
  sseConnected: { type: Boolean, default: false },
  sseReconnecting: { type: Boolean, default: false },
  acpStatus: { type: Object, default: () => ({ count: 0, runs: [] }) },
  acpLogs: { type: Array, default: () => [] },
  acpBridge: { type: Object, default: () => null },
  models: { type: Array, default: () => [] },
  sessionKey: { type: String, default: '' },
  currentAgentId: { type: String, default: 'main' },
  monitorMode: { type: Boolean, default: false },
  monitorMessages: { type: Array, default: () => [] },
  monitorHistoryLoading: { type: Boolean, default: false },
  monitorUserInfo: { type: String, default: '' },
  canAccessMonitor: { type: Boolean, default: false },
})

const emit = defineEmits(['update:inputText', 'send', 'abort', 'upload', 'remove-attachment', 'open-settings', 'hot-refresh', 'switch-model', 'load-more', 'open-monitor', 'exit-monitor'])

// ── 模型选择器 ──
const modelPickerVisible = ref(false)

const modelActions = computed(() => {
  // 兜底：如果后端 models 为空但 currentModel 有值，至少把当前模型放进去
  const list = props.models.length > 0
    ? props.models
    : (props.currentModel ? [props.currentModel] : [])
  return list.map((m) => {
    const isObj = m && typeof m === 'object'
    const name = isObj ? (m.name || m.id || m.model || String(m)) : String(m)
    const value = isObj ? (m.id || m.model || m.name || String(m)) : String(m)
    return {
      name,
      value,
      color: value === props.currentModel ? '#007AFF' : undefined,
    }
  })
})

function openModelPicker() {
  if (props.loading) return
  modelPickerVisible.value = true
}

function onModelSelect(action) {
  const value = action.value || action.name
  if (value && value !== props.currentModel) {
    emit('switch-model', value)
  }
}

const messageListRef = ref(null)

onMounted(() => {
  // placeholder for any mount-time setup
})

const inputText = ref(props.inputText)
watch(() => props.inputText, (v) => { inputText.value = v })
watch(inputText, (v) => { emit('update:inputText', v) })

function send(e) {
  if (props.loading || props.uploading) {
    e?.preventDefault?.()
    return
  }
  nextTick(() => messageListRef.value?.scrollToBottom())
  emit('send', e)
}

function abort() {
  emit('abort')
}

const refreshing = ref(false)

function reloadPage() {
  if (refreshing.value) return
  refreshing.value = true
  emit('hot-refresh')
  setTimeout(() => { refreshing.value = false }, 1500)
}

const suggestionCards = [
  { icon: '💡', text: '帮我写一段Python爬虫代码' },
  { icon: '📝', text: '帮我写一封工作周报' },
  { icon: '🔍', text: '解释一下什么是RAG技术' },
  { icon: '🛠️', text: '如何优化React应用性能' },
  { icon: '📊', text: '帮我分析一组销售数据' },
  { icon: '🌐', text: '把这段话翻译成英文' },
]

function fillSuggestion(text) {
  inputText.value = text
}
</script>

<style>
/* ── Chat Page ── */
.chat-page {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

/* ── Nav Bar ── */
.nav-bar {
  background: #FFFFFF;
  border-bottom: 1px solid #E5E5E5;
}
.nav-title {
  font-weight: 600;
  font-size: 16px;
  color: #1F1F1F;
}
.nav-title-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  line-height: 1.2;
  max-width: 100%;
  overflow: hidden;
}
.nav-model {
  font-size: 11px;
  color: rgba(39, 39, 42, 0.6);
  font-weight: 400;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-model-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #fff;
  border: 1px solid #E5E5E5;
  font-size: 11px;
  color: #007AFF;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  outline: none;
  max-width: 160px;
}
.nav-model-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.nav-model-btn:active:not(:disabled) {
  background: rgba(0, 122, 255, 0.08);
  border-color: rgba(0, 122, 255, 0.3);
  transform: scale(0.96);
}
.nav-model-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-model-arrow {
  font-size: 10px;
  color: #007AFF;
  flex-shrink: 0;
  transition: transform 0.2s ease;
}
.nav-model-btn:active:not(:disabled) .nav-model-arrow {
  transform: rotate(180deg);
}
.nav-sub-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-top: 1px;
  max-width: 100%;
  overflow: hidden;
}
.nav-bar .van-nav-bar__title {
  color: var(--text);
  /* 恢复 Vant 默认 margin: 0 auto 居中能力，calc 限制最大宽度避免与左右重叠 */
  margin: 0 auto;
  max-width: calc(100% - 140px);
  padding: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.nav-bar .van-nav-bar__arrow { color: var(--text); }

/* 阻止 Vant nav-bar haptics 反馈导致整体变透明（双亮问题根因） */
.nav-bar .van-nav-bar__right.van-haptics-feedback:active,
.nav-bar .van-nav-bar__left.van-haptics-feedback:active {
  opacity: 1 !important;
}

.nav-bar .van-nav-bar__right,
.nav-bar .van-nav-bar__left,
.nav-bar .van-nav-bar__content,
.nav-right-actions {
  -webkit-tap-highlight-color: transparent !important;
  tap-highlight-color: transparent !important;
}

/* 右侧操作按钮 */
.nav-right-actions {
  display: flex;
  align-items: center;
  gap: 0;
  margin-right: -12px;
}
.nav-btn-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  position: relative;
  isolation: isolate;
  -webkit-tap-highlight-color: transparent;
  tap-highlight-color: transparent;
  touch-action: manipulation;
  outline: none;
  -webkit-user-select: none;
  user-select: none;
  cursor: pointer;
}
.nav-action-icon {
  font-size: 20px;
  color: var(--text);
  pointer-events: none;
  transition: transform 0.35s ease, color 0.2s ease;
}
@media (hover: hover) {
  .nav-btn-wrapper:hover .nav-action-icon {
    color: var(--primary);
  }
  .nav-btn-wrapper:hover .nav-action-icon--refresh {
    transform: rotate(-120deg);
  }
  .nav-btn-wrapper:hover .nav-action-icon--setting {
    transform: rotate(90deg);
  }
}
.nav-btn-wrapper:active .nav-action-icon--refresh {
  transform: scale(0.9) rotate(-60deg);
  color: var(--primary);
}
.nav-btn-wrapper.is-loading .nav-action-icon--refresh {
  animation: spin 0.8s linear infinite;
  pointer-events: none;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.nav-btn-wrapper:active .nav-action-icon--setting {
  transform: scale(0.9) rotate(45deg);
  color: var(--primary);
}

/* 左侧菜单按钮 */
.nav-menu-icon {
  font-size: 22px;
  color: var(--text);
  cursor: pointer;
  padding: 8px;
  margin: -8px;
  transition: transform 0.3s ease;
}
.nav-menu-icon:active { transform: scale(0.9); }

/* 左侧操作 */
.nav-left-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* ── Service Status Banner ── */
.service-banner {
  position: fixed;
  top: 46px;
  left: 0;
  right: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.service-banner--down {
  background: rgba(245, 158, 11, 0.12);
  color: #B45309;
  border-bottom: 1px solid rgba(245, 158, 11, 0.25);
}
.service-banner--recovered {
  background: rgba(16, 185, 129, 0.12);
  color: #047857;
  border-bottom: 1px solid rgba(16, 185, 129, 0.25);
}

/* ── Banner Transition ── */
.banner-slide-enter-active,
.banner-slide-leave-active {
  transition: all 0.35s ease;
}
.banner-slide-enter-from,
.banner-slide-leave-to {
  opacity: 0;
  transform: translateY(-100%);
}

/* ── History Loading ── */
.history-loading {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 24px;
}
.history-loading__spinner {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}
.history-loading__ring {
  width: 36px;
  height: 36px;
  border: 3px solid #EDE9FE;
  border-top-color: #7C3AED;
  border-radius: 50%;
  animation: history-spin 0.8s linear infinite;
}
.history-loading__text {
  font-size: 14px;
  color: #8E8E8E;
  animation: history-fade 1.5s ease-in-out infinite;
}
@keyframes history-spin {
  to { transform: rotate(360deg); }
}
@keyframes history-fade {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

/* ── Empty State ── */
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 24px;
}
.empty-greeting {
  font-size: 22px;
  font-weight: 600;
  color: #1F1F1F;
  text-align: center;
  margin-bottom: 24px;
}
.empty-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 400px;
}
.empty-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  background: #FFFFFF;
  border: 1px solid #E5E5E5;
  border-radius: 24px;
  cursor: pointer;
  text-align: left;
  font-size: 14px;
  color: #1F1F1F;
  transition: background 0.2s ease;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.empty-card:active {
  background: #F4F5F7;
}
.empty-card-icon {
  font-size: 18px;
  flex-shrink: 0;
}
.empty-card-text {
  flex: 1;
}

/* ── Monitor Nav Button ── */
.nav-monitor-btn {
  margin-left: 2px;
}
.nav-monitor-btn:active svg {
  color: var(--primary);
  transform: scale(0.9);
}
.nav-title--monitor {
  color: #F59E0B;
  letter-spacing: 1px;
}

/* ── Monitor Read-only Banner ── */
.monitor-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.08), rgba(245, 158, 11, 0.15));
  border-top: 1px solid rgba(245, 158, 11, 0.2);
  gap: 10px;
}
.monitor-banner__info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #92400E;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.monitor-exit-btn.van-button {
  flex-shrink: 0;
  border-radius: 8px;
  height: 28px;
  font-size: 12px;
  font-weight: 600;
}
</style>
