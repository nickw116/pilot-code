<template>
  <div v-if="shouldRender" :class="['message-item', message.role]">
    <div class="bubble">
      <div
        v-if="message.content || (message.media && (message.media.images.length > 0 || message.media.pdfs.length > 0))"
        class="text"
        :class="{ markdown: message.role === 'assistant' }"
        @click="onTextImageClick"
      >
        <!-- 文本内容：优先用 media.text（已清理图片 URL），为空则 fallback 到原始 content，避免链接/文本被误过滤后整栏空白 -->
        <span v-if="renderText.trim()" v-html="renderedHtml"></span>
        <span v-if="isStreaming" class="typing-cursor"></span>
        <!-- 图片预览（放在文本下方） -->
        <div v-if="message.media && message.media.images.length > 0" class="media-images">
          <img
            v-for="(imgUrl, imgIdx) in message.media.images"
            :key="imgIdx"
            :src="imgUrl"
            class="media-img"
            @click="onImageClick(imgUrl, message.media.images)"
            loading="lazy"
            @error="handleImgError"
          />
        </div>
        <!-- PDF / 文件链接（带下载按钮，放在文本下方） -->
        <div v-if="message.media && message.media.pdfs.length > 0" class="media-pdfs">
          <div
            v-for="(pdfUrl, pdfIdx) in message.media.pdfs"
            :key="pdfIdx"
            class="pdf-card"
          >
            <a
              :href="pdfUrl"
              target="_blank"
              rel="noopener"
              class="pdf-card-link"
            >
              <span class="pdf-icon">📄</span>
              <span class="pdf-name">{{ pdfFileName(pdfUrl) }}</span>
              <span class="pdf-action">查看</span>
            </a>
            <button
              type="button"
              class="pdf-download-btn"
              @click="downloadMediaUrl(pdfUrl)"
              title="下载"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
      <div v-else-if="showThinking" class="thinking">
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
      </div>
      <div v-if="message.role === 'assistant' && hasSteps" class="steps-list">
        <!-- steps rendered as raw JSON for now -->
        <div
          v-for="(step, index) in message.steps"
          :key="`${message.id}-${step.type}-${step.name || index}`"
          class="step-item"
        >
          <span class="step-type">{{ step.type }}</span>
          <span v-if="step.name" class="step-name">{{ step.name }}</span>
        </div>
      </div>
      <!-- 文件下载卡片 -->
      <div v-if="message.role === 'assistant' && message.files && message.files.length > 0" class="file-cards">
        <div
          v-for="file in message.files"
          :key="file.url"
          class="file-card"
          @click="onFileDownload(file)"
        >
          <span class="file-card-icon">{{ fileIcon(file.content_type) }}</span>
          <div class="file-card-info">
            <span class="file-card-name">{{ file.filename }}</span>
            <span class="file-card-size">{{ formatFileSize(file.size) }}</span>
          </div>
          <svg class="file-card-dl" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { formatText, renderMarkdown, previewImage } from '../utils/format.js'
import { downloadFile } from '../utils/download.js'

const props = defineProps({
  message: { type: Object, required: true },
  isStreaming: { type: Boolean, default: false },
  showThinking: { type: Boolean, default: false },
  formatFileSize: { type: Function, default: () => '' },
  fileIcon: { type: Function, default: () => '📄' },
})

/**
 * 获取消息渲染用的文本内容。
 * 优先使用 media.text（已移除图片/PDF URL 的清理版本），
 * 若其为空则 fallback 到原始 content，避免链接/文本被误过滤后整栏空白。
 */
const renderText = computed(() => {
  const msg = props.message
  if (msg.media && msg.media.text !== undefined) {
    return msg.media.text || msg.content || ''
  }
  return msg.content || ''
})

const renderedHtml = computed(() => {
  const text = renderText.value
  if (!text.trim()) return ''
  if (props.message.role === 'assistant') {
    // 用 non-enumerable 属性存放缓存，避免 Vue deep watch 递归追踪
    if (props.message._renderedContent === text && props.message._renderedCache) {
      return props.message._renderedCache
    }
    const html = renderMarkdown(text)
    Object.defineProperty(props.message, '_renderedContent', {
      value: text,
      enumerable: false,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(props.message, '_renderedCache', {
      value: html,
      enumerable: false,
      configurable: true,
      writable: true,
    })
    return html
  }
  return formatText(text)
})

const hasSteps = computed(() =>
  Array.isArray(props.message.steps) && props.message.steps.length > 0
)

const shouldRender = computed(() => {
  const msg = props.message
  if (msg.content?.trim()) return true
  if (msg.media?.images?.length || msg.media?.pdfs?.length) return true
  if (msg.steps?.length || msg.files?.length) return true
  if (msg.isAcpCard) return true
  if (props.isStreaming || msg.isStreaming) return true
  if (props.showThinking) return true
  return false
})

function onImageClick(url, list) {
  previewImage(url, list)
}

function onTextImageClick(e) {
  const img = e.target.closest('img')
  if (img) {
    previewImage(img.src)
  }
}

/**
 * 图片加载失败处理
 */
function handleImgError(e) {
  e.target.style.display = 'none'
}

/**
 * 提取 PDF 文件名
 */
function pdfFileName(url) {
  try {
    const parts = url.split('/')
    return decodeURIComponent(parts[parts.length - 1]) || 'document.pdf'
  } catch {
    return 'document.pdf'
  }
}

/**
 * 下载文件（fetch + Blob，兼容移动端）
 */
function onFileDownload(file) {
  downloadFile(file)
}

/**
 * 从 bare URL 下载媒体文件
 */
function downloadMediaUrl(url) {
  const filename = pdfFileName(url)
  downloadFile({ url, filename })
}
</script>

<style>
/* ── Message Item & Avatar ── */
.message-item {
  display: flex;
  margin-bottom: 16px;
  max-width: 85%;
  animation: fadeInUp 0.35s ease;
}
.message-item.user {
  margin-left: auto;
  flex-direction: row-reverse;
}
.message-item.assistant {
  margin-right: auto;
}

/* ── Bubble ── */
.bubble {
  padding: 12px 16px;
  border-radius: 20px;
  font-size: 14px;
  line-height: 1.65;
  word-break: break-word;
  overflow-wrap: anywhere;
  min-width: 40px;
  max-width: calc(100vw - 32px);
  position: relative;
}
.message-item.user .bubble {
  background: #D9D9D9;
  color: #000000;
  border-radius: 18px;
  box-shadow: none;
  max-width: 80%;
}
@media (min-width: 1200px) {
  .message-item.user .bubble {
    max-width: 600px;
  }
}
.message-item.assistant .bubble {
  background: #FFFFFF;
  color: #1F1F1F;
  border-radius: 18px;
  box-shadow: none;
  max-width: 85%;
}
@media (min-width: 1200px) {
  .message-item.assistant .bubble {
    max-width: 800px;
  }
}
.text { min-height: 8px; }

.assistant--acp {
  margin-top: 10px;
  margin-bottom: 22px;
}

.bubble--acp {
  background: #F9FAFB;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-top-left-radius: 20px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

/* ── Typing Cursor (流式输出末尾闪烁光标) ── */
.typing-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: var(--primary);
  border-radius: 1px;
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: blink-cursor 0.8s ease-in-out infinite;
}
@keyframes blink-cursor {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* ── Markdown Styles ── */
.text.markdown {
  font-size: 14px;
  line-height: 1.7;
}
.text.markdown p { margin: 0 0 8px; }
.text.markdown p:last-child { margin-bottom: 0; }
.text.markdown h1, .text.markdown h2, .text.markdown h3 {
  margin: 12px 0 6px;
  font-family: 'Space Grotesk', sans-serif;
  font-weight: 600;
  color: var(--text);
}
.text.markdown h1 { font-size: 18px; }
.text.markdown h2 { font-size: 16px; }
.text.markdown h3 { font-size: 15px; }
.text.markdown ul, .text.markdown ol {
  padding-left: 20px;
  margin: 6px 0;
}
.text.markdown li { margin: 3px 0; }
.text.markdown a {
  color: var(--primary);
  text-decoration: none;
  border-bottom: 1px dashed var(--primary);
}
.text.markdown a:hover { border-bottom-style: solid; }
.text.markdown strong { font-weight: 600; }
.text.markdown em { font-style: italic; }
.text.markdown blockquote {
  margin: 8px 0;
  padding: 6px 12px;
  border-left: 3px solid var(--primary);
  background: rgba(0, 122, 255, 0.05);
  border-radius: 0 8px 8px 0;
  color: #555;
}
.text.markdown table {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 13px;
}
.text.markdown th, .text.markdown td {
  border: 1px solid var(--border);
  padding: 6px 10px;
  text-align: left;
}
.text.markdown th {
  background: rgba(0, 122, 255, 0.06);
  font-weight: 600;
}
.text.markdown code:not(.hljs) {
  background: rgba(0, 122, 255, 0.1);
  color: var(--primary);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 13px;
  font-family: 'SF Mono', 'Fira Code', monospace;
}
.text.markdown img {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  display: block;
  margin: 6px 0;
  cursor: pointer;
}

/* === Media Preview Styles === */
.media-images {
  margin-bottom: 8px;
}
.media-img {
  max-width: 100%;
  max-height: 300px;
  border-radius: 8px;
  cursor: pointer;
  object-fit: contain;
  display: block;
  margin: 4px 0;
  transition: opacity 0.2s;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}
.media-img:hover {
  opacity: 0.85;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
}
.media-pdfs {
  margin-bottom: 8px;
}
.pdf-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: rgba(0, 122, 255, 0.06);
  border: 1px solid rgba(0, 122, 255, 0.15);
  border-radius: 8px;
  color: var(--text);
  text-decoration: none;
  margin: 4px 0;
  transition: background 0.2s, border-color 0.2s;
}
.pdf-card:hover {
  background: rgba(0, 122, 255, 0.12);
  border-color: rgba(0, 122, 255, 0.3);
}
.pdf-icon {
  font-size: 20px;
}
.pdf-name {
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdf-action {
  font-size: 12px;
  color: var(--primary);
  white-space: nowrap;
}
.pdf-card-link {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  color: inherit;
  text-decoration: none;
}
.pdf-download-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: none;
  background: rgba(0, 122, 255, 0.1);
  color: var(--primary);
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}
.pdf-download-btn:active {
  transform: scale(0.92);
  background: rgba(0, 122, 255, 0.2);
}

/* ── Code Block ── */
.code-block {
  margin: 8px 0;
  border-radius: 10px;
  overflow: hidden;
  background: #1e1e2e;
  border: 1px solid rgba(255,255,255,0.08);
}
.code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  background: rgba(255,255,255,0.06);
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.code-lang {
  font-size: 11px;
  color: rgba(255,255,255,0.5);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.code-copy {
  font-size: 11px;
  color: rgba(255,255,255,0.5);
  background: none;
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  transition: all 0.2s;
}
.code-copy:hover {
  color: #fff;
  border-color: rgba(255,255,255,0.4);
}
.code-block pre {
  margin: 0;
  padding: 12px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.code-block code {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 13px;
  line-height: 1.5;
  color: #e2e8f0;
}
.code-block code .hljs-keyword { color: #c792ea; }
.code-block code .hljs-string { color: #c3e88d; }
.code-block code .hljs-number { color: #f78c6c; }
.code-block code .hljs-comment { color: #637777; font-style: italic; }
.code-block code .hljs-built_in { color: #82aaff; }
.code-block code .hljs-function { color: #82aaff; }
.code-block code .hljs-title { color: #82aaff; }
.code-block code .hljs-params { color: #e2e8f0; }
.code-block code .hljs-attr { color: #ffcb6b; }
.code-block code .hljs-variable { color: #f07178; }
.code-block code .hljs-selector-tag { color: #89ddff; }
.code-block code .hljs-type { color: #ffcb6b; }

/* ── Thinking Animation ── */
.thinking {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 0;
}
.thinking--compact {
  padding: 6px 0;
}
.dot {
  width: 7px;
  height: 7px;
  background: var(--primary);
  border-radius: 50%;
  opacity: 0.7;
  animation: bounce 1.2s ease-in-out infinite;
}
.dot:nth-child(2) { animation-delay: 0.15s; }
.dot:nth-child(3) { animation-delay: 0.3s; }

@keyframes bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
  30% { transform: translateY(-8px); opacity: 1; }
}

/* ── Steps List (容器) ── */
.steps-list {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  background: rgba(0, 122, 255, 0.04);
  border-radius: 10px;
  border: 1px solid rgba(0, 122, 255, 0.1);
}

.step-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #555;
}

.step-type {
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(0, 122, 255, 0.1);
  color: var(--primary);
  font-weight: 600;
  font-size: 11px;
}

.step-name {
  color: var(--text);
}

/* ── File Download Cards ── */
.file-cards {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.file-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: rgba(0, 122, 255, 0.06);
  border: 1px solid rgba(0, 122, 255, 0.15);
  border-radius: 12px;
  color: var(--text);
  cursor: pointer;
  transition: all 0.2s ease;
  animation: fadeInUp 0.3s ease;
}
.file-card:hover {
  background: rgba(0, 122, 255, 0.12);
  border-color: var(--primary);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 122, 255, 0.15);
}
.file-card:active {
  transform: scale(0.98);
}
.file-card-icon {
  font-size: 28px;
  flex-shrink: 0;
}
.file-card-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.file-card-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.file-card-size {
  font-size: 11px;
  color: #888;
}
.file-card-dl {
  flex-shrink: 0;
  color: var(--primary);
  opacity: 0.6;
  transition: opacity 0.2s ease;
}
.file-card:hover .file-card-dl {
  opacity: 1;
}
</style>
