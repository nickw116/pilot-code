<template>
  <div class="input-area">
    <!-- 附件预览 -->
    <div class="attachment-preview" v-if="attachments.length > 0">
      <div
        v-for="(att, idx) in attachments"
        :key="att.url"
        class="attachment-item"
      >
        <div class="attachment-thumb" v-if="att.type && att.type.startsWith('image/')" @click="previewAttachment(att)">
          <img :src="att.preview || att.url" alt="" />
        </div>
        <div class="attachment-thumb attachment-file" v-else>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
        </div>
        <button class="attachment-remove" @click="$emit('remove-attachment', idx)">×</button>
      </div>
    </div>

    <div class="input-bar">
      <input type="file" ref="fileInputRef" accept="image/*,video/*,audio/*,application/*,text/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.rar,.7z,.csv,.json,.xml,.html,.css,.js,.py,.java,.md" style="display: none" @change="handleFileSelect" />
      <van-button
        size="small"
        class="attach-btn"
        @click="fileInputRef?.click()"
        :disabled="uploading || loading"
        title="附件"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
        </svg>
      </van-button>
      <van-button
        size="small"
        :class="['voice-btn', { 'voice-btn--active': voiceRecording, 'voice-btn--processing': voiceProcessing }]"
        @click="toggleVoice"
        :disabled="loading || voiceProcessing"
        :title="voiceRecording ? '点击停止录音' : (voiceProcessing ? '正在识别...' : '语音输入')"
      >
        <svg v-if="!voiceProcessing" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
        <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="voice-spin">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
        <span v-if="voiceRecording" class="voice-dot"></span>
      </van-button>
      <div class="input-wrapper">
        <van-field
          :model-value="modelValue"
          :placeholder="voiceProcessing ? '正在识别语音...' : (uploading ? `上传中 ${uploadProgress}%...` : (attachments.length ? '添加文字说明（可选）...' : '输入消息，可粘贴图片...'))"
          :border="false"
          type="textarea"
          rows="1"
          autosize
          class="input-field"
          :disabled="uploading"
          @update:model-value="$emit('update:modelValue', $event)"
          @keydown.enter.exact="onSend"
          @paste="handlePaste"
          @drop="handleDrop"
        />
        <van-button
          size="small"
          class="send-btn"
          @click="onSend"
          :disabled="(!modelValue.trim() && !attachments.length) || uploading"
          v-if="!loading"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </van-button>
        <van-button
          size="small"
          class="stop-btn"
          @click="$emit('abort')"
          v-else
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2"/>
          </svg>
        </van-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onUnmounted } from 'vue'
import { showImagePreview, showNotify } from 'vant'
import { API_BASE, TOKEN_KEY } from '../constants/index.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  uploading: { type: Boolean, default: false },
  uploadProgress: { type: Number, default: 0 },
  attachments: { type: Array, default: () => [] },
})

const emit = defineEmits([
  'update:modelValue',
  'send',
  'abort',
  'upload',
  'remove-attachment',
])

const fileInputRef = ref(null)
const voiceRecording = ref(false)
const voiceProcessing = ref(false)
let mediaRecorder = null
let audioChunks = []

function toggleVoice() {
  if (voiceProcessing.value) return
  if (voiceRecording.value) {
    stopVoice()
    return
  }
  startVoice()
}

async function startVoice() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    audioChunks = []

    const options = {}
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      options.mimeType = 'audio/webm;codecs=opus'
    } else if (MediaRecorder.isTypeSupported('audio/webm')) {
      options.mimeType = 'audio/webm'
    } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
      options.mimeType = 'audio/ogg;codecs=opus'
    } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
      options.mimeType = 'audio/mp4'
    }

    mediaRecorder = new MediaRecorder(stream, options)
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data)
    }
    mediaRecorder.onerror = (e) => {
      console.error('[voice] recorder error:', e)
      stream.getTracks().forEach(t => t.stop())
      voiceRecording.value = false
      showNotify({ type: 'warning', message: '录音出错，请重试' })
    }
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop())
      voiceRecording.value = false
      if (audioChunks.length > 0) {
        sendVoiceToServer()
      } else {
        showNotify({ type: 'warning', message: '未录到音频，请重试' })
      }
    }
    mediaRecorder.start(1000)
    voiceRecording.value = true
  } catch (e) {
    console.error('[voice] start failed:', e)
    const msg = e?.name === 'NotAllowedError' ? '请允许麦克风权限后重试'
      : e?.name === 'NotFoundError' ? '未找到麦克风设备'
      : `录音启动失败: ${e?.message || e}`
    showNotify({ type: 'warning', message: msg })
  }
}

function stopVoice() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop()
  }
}

async function sendVoiceToServer() {
  const mimeType = mediaRecorder?.mimeType || audioChunks[0]?.type || 'audio/webm'
  const blob = new Blob(audioChunks, { type: mimeType })
  audioChunks = []

  console.log('[voice] sending audio:', blob.size, 'bytes, type:', mimeType)

  if (blob.size < 100) {
    showNotify({ type: 'warning', message: '录音时间太短，请重试' })
    return
  }

  voiceProcessing.value = true
  try {
    const formData = new FormData()
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm'
    formData.append('audio', blob, `voice_${Date.now()}.${ext}`)

    const token = sessionStorage.getItem(TOKEN_KEY)
    const resp = await fetch(`${API_BASE}/stt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    })
    if (!resp.ok) {
      const err = await resp.text()
      console.error('[voice] stt HTTP error:', resp.status, err)
      throw new Error(`HTTP ${resp.status}`)
    }
    const data = await resp.json()
    const text = data.text || ''
    if (text) {
      const current = props.modelValue
      emit('update:modelValue', current ? current + '\n' + text : text)
    } else {
      showNotify({ type: 'warning', message: '未能识别语音内容' })
    }
  } catch (e) {
    console.error('[voice] stt failed:', e)
    showNotify({ type: 'warning', message: '语音识别失败，请重试' })
  } finally {
    voiceProcessing.value = false
  }
}

onUnmounted(() => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
})

function previewAttachment(att) {
  const src = att.preview || att.url
  if (!src) return
  showImagePreview({
    images: [src],
    closeable: true,
  })
}

function renameFile(file) {
  const ts = Date.now().toString().slice(-8)
  const dotIdx = file.name.lastIndexOf('.')
  const base = dotIdx > 0 ? file.name.slice(0, dotIdx) : file.name
  const ext = dotIdx > 0 ? file.name.slice(dotIdx) : ''
  return new File([file], `${ts}_${base}${ext}`, { type: file.type })
}

function onSend(e) {
  if (props.loading || props.uploading) {
    e?.preventDefault?.()
    return
  }
  emit('send', e)
}

function handleFileSelect(e) {
  const file = e.target.files[0]
  if (!file) return
  emit('upload', renameFile(file))
  // reset input so same file can be re-selected
  e.target.value = ''
}

/**
 * 监听输入框的 paste 事件，自动提取剪贴板中的文件并上传
 */
function handlePaste(e) {
  const items = e.clipboardData?.items
  if (!items) return

  for (const item of items) {
    if (item.kind === 'file') {
      e.preventDefault()
      const file = item.getAsFile()
      if (file) emit('upload', renameFile(file))
      return // 只处理第一个文件
    }
  }
}

/**
 * 监听输入框的 drop 事件，支持拖放文件
 */
function handleDrop(e) {
  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return

  e.preventDefault()
  emit('upload', renameFile(files[0]))
}
</script>

<style>
/* ── Input Area ── */
.input-area {
  position: relative;
  flex-shrink: 0;
  background: #FFFFFF;
  padding-top: 8px;
}

/* ── Attach Button ── */
.attach-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.attach-btn.van-button {
  background: #E8E8E8;
  border: none;
  color: #8E8E8E;
}
.attach-btn:active { transform: scale(0.92); }
.attach-btn.van-button--disabled {
  opacity: 0.5;
  color: #aaa;
}

/* ── Voice Button ── */
.voice-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  position: relative;
}
.voice-btn.van-button {
  background: #E8E8E8;
  border: none;
  color: #8E8E8E;
}
.voice-btn:active { transform: scale(0.92); }
.voice-btn.van-button--disabled {
  opacity: 0.5;
  color: #aaa;
}
.voice-btn--active.van-button {
  background: #EF4444;
  color: #FFFFFF;
  animation: voice-pulse 1.2s ease-in-out infinite;
}
.voice-dot {
  position: absolute;
  bottom: 2px;
  right: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #EF4444;
  animation: dot-blink 0.8s ease-in-out infinite;
}
@keyframes voice-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }
  50% { box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); }
}
@keyframes dot-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
.voice-btn--processing.van-button {
  background: #007AFF;
  color: #FFFFFF;
}
.voice-spin {
  animation: voice-spin-anim 1s linear infinite;
}
@keyframes voice-spin-anim {
  to { transform: rotate(360deg); }
}

/* ── Attachment Preview ── */
.attachment-preview {
  display: flex;
  gap: 8px;
  padding: 8px 14px 0;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.attachment-item {
  position: relative;
  flex-shrink: 0;
  animation: fadeInUp 0.25s ease;
}
.attachment-thumb {
  width: 64px;
  height: 64px;
  border-radius: 10px;
  overflow: hidden;
  border: 2px solid var(--border);
  background: var(--white);
  cursor: pointer;
}
.attachment-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.attachment-file {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--secondary);
}
.attachment-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #EF4444;
  color: white;
  border: 2px solid white;
  font-size: 13px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  box-shadow: 0 2px 6px rgba(239, 68, 68, 0.4);
}
.attachment-remove:active {
  transform: scale(0.85);
}

/* ── Input Bar ── */
.input-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  padding-bottom: max(6px, env(safe-area-inset-bottom));
  margin: 0 12px 8px;
  background: #F0F2F5;
  border-radius: 24px;
  box-shadow: none;
}
/* ── Input Wrapper (field + send/stop button) ── */
.input-wrapper {
  display: flex;
  align-items: center;
  flex: 1;
  background: transparent;
  border-radius: 0;
  border: none;
  box-shadow: none;
  padding: 0;
  gap: 4px;
}
.input-field.van-cell {
  flex: 1;
  background: transparent;
  border-radius: 0;
  border: none;
  box-shadow: none;
  padding: 6px 10px;
  font-size: 15px;
}
.input-field .van-field__control {
  color: var(--text);
}
.input-field .van-field__control::placeholder {
  color: #8E8E8E;
}
.send-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.send-btn.van-button {
  background: #007AFF;
  border: none;
  color: #FFFFFF;
}
.send-btn:active { transform: scale(0.92); }
.send-btn.van-button--disabled {
  background: var(--border);
  color: #aaa;
}

.stop-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  animation: pulse-stop 1.5s ease-in-out infinite;
}
.stop-btn.van-button {
  background: #EF4444;
  border: none;
  color: white;
}
.stop-btn:active { transform: scale(0.92); }

@keyframes pulse-stop {
  0%, 100% { box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4); }
  50% { box-shadow: 0 4px 20px rgba(239, 68, 68, 0.7); }
}
</style>
