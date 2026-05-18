<template>
  <div class="acp-log-panel" :class="{ collapsed: isCollapsed }">
    <div class="acp-header" @click="toggleCollapse">
      <span class="acp-header-icon">{{ statusIcon }}</span>
      <span class="acp-header-title">
        {{ agentLabel }} {{ statusLabel }}
        <span v-if="logs.length" class="acp-header-count">({{ logs.length }}步)</span>
      </span>
      <span class="acp-header-toggle">{{ isCollapsed ? '展开' : '收起' }}</span>
    </div>
    <div v-if="!isCollapsed" class="acp-body" ref="bodyRef">
      <div v-for="(log, idx) in logs" :key="idx" :class="['acp-line', `acp-${log.type}`]">
        <span class="acp-line-prefix">{{ linePrefix(log) }}</span>
        <span class="acp-line-text">{{ formatLine(log) }}</span>
        <span v-if="log.durationMs" class="acp-line-duration">{{ log.durationMs }}ms</span>
      </div>
      <div v-if="isRunning && statusLabel === '思考中'" class="acp-line acp-waiting">
        <span class="acp-line-prefix">...</span>
        <span class="acp-line-text acp-blink">Claude Code 正在分析任务</span>
      </div>
      <div v-else-if="isRunning && statusLabel === '生成中'" class="acp-line acp-waiting">
        <span class="acp-line-prefix">...</span>
        <span class="acp-line-text acp-blink">Claude Code 正在生成回复</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick, computed } from 'vue'

const props = defineProps({
  logs: { type: Array, default: () => [] },
  isRunning: { type: Boolean, default: false },
  acpStatus: { type: String, default: '' },
  agentName: { type: String, default: 'Claude Code' },
})

const bodyRef = ref(null)
const isCollapsed = ref(false)

const agentLabel = computed(() => props.agentName)

const statusIcon = computed(() => {
  if (!props.isRunning) return '✅'
  return '⏳'
})

const statusLabel = computed(() => {
  if (!props.isRunning) return '已完成'
  if (props.acpStatus === 'thinking') return '思考中'
  if (props.acpStatus === 'responding') return '生成中'
  if (props.logs.length > 0) return '运行中'
  return '启动中'
})

const hasRunningTool = computed(() => {
  for (let i = props.logs.length - 1; i >= 0; i--) {
    if (props.logs[i].type === 'tool_start') return true
    if (props.logs[i].type === 'tool_end') return false
  }
  return false
})

function toggleCollapse() {
  if (!props.isRunning) {
    isCollapsed.value = !isCollapsed.value
  }
}

function linePrefix(log) {
  switch (log.type) {
    case 'tool_start': return '>'
    case 'tool_end': return '✓'
    case 'reasoning': return '💭'
    case 'text_delta': return '📝'
    case 'step_start': return '▶'
    case 'step_finish': return '■'
    case 'log': return '·'
    default: return '·'
  }
}

function formatLine(log) {
  switch (log.type) {
    case 'tool_start':
      return `${log.tool}(${log.text})`
    case 'tool_end':
      return `${log.tool}: ${truncate(log.text, 120)}`
    case 'reasoning':
      return truncate(log.text, 200)
    case 'text_delta':
      return truncate(log.text, 300)
    case 'step_start':
      return log.text
    case 'step_finish':
      return log.text
    case 'log':
      return truncate(log.text, 200)
    default:
      return truncate(log.text, 200)
  }
}

function truncate(text, max) {
  if (!text) return ''
  const first = text.indexOf('\n')
  const oneLine = first > 0 ? text.slice(0, first) : text
  return oneLine.length > max ? oneLine.slice(0, max) + '...' : oneLine
}

watch(
  () => props.logs.length,
  () => {
    nextTick(() => {
      const el = bodyRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }
)
</script>

<style scoped>
.acp-log-panel {
  margin-top: 8px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: #1e1e2e;
  font-family: 'SF Mono', 'Fira Code', 'Menlo', monospace;
  font-size: 12px;
  line-height: 1.5;
}
.acp-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.06);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  color: #e2e8f0;
  cursor: pointer;
  user-select: none;
}
.acp-header-icon {
  font-size: 12px;
  flex-shrink: 0;
}
.acp-header-title {
  flex: 1;
  font-size: 12px;
  font-weight: 500;
}
.acp-header-count {
  color: #6b7280;
  font-weight: 400;
  font-size: 11px;
}
.acp-header-toggle {
  color: #6b7280;
  font-size: 11px;
}
.collapsed .acp-header {
  border-bottom: none;
}
.acp-body {
  max-height: 280px;
  overflow-y: auto;
  padding: 6px 0;
  -webkit-overflow-scrolling: touch;
}
.acp-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 1px 10px;
  color: #c9d1d9;
  white-space: nowrap;
}
.acp-line-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.acp-line-duration {
  color: #6b7280;
  font-size: 10px;
  flex-shrink: 0;
}
.acp-line-prefix {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  font-weight: 600;
}
.acp-tool_start .acp-line-prefix {
  color: #58a6ff;
}
.acp-tool_start .acp-line-text {
  color: #79c0ff;
}
.acp-tool_end .acp-line-prefix {
  color: #3fb950;
}
.acp-tool_end .acp-line-text {
  color: #8b949e;
}
.acp-reasoning .acp-line-prefix {
  color: #d2a8ff;
}
.acp-reasoning .acp-line-text {
  color: #bc8cff;
}
.acp-text_delta .acp-line-prefix {
  color: #e6edf3;
}
.acp-text_delta .acp-line-text {
  color: #e6edf3;
}
.acp-step_start .acp-line-prefix {
  color: #58a6ff;
}
.acp-step_finish .acp-line-prefix {
  color: #3fb950;
}
.acp-step_finish .acp-line-text {
  color: #8b949e;
}
.acp-log .acp-line-prefix {
  color: #6b7280;
}
.acp-log .acp-line-text {
  color: #6b7280;
}
.acp-waiting {
  color: #6b7280;
}
.acp-blink {
  animation: acp-blink 1s ease-in-out infinite;
}
@keyframes acp-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
</style>
