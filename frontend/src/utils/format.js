import { Marked } from 'marked'
import hljs from 'highlight.js'
import DOMPurify from 'dompurify'
import { showImagePreview } from 'vant'

/**
 * 检测文本中的媒体 URL（图片和 PDF）
 * 支持 markdown 图片语法 ![alt](url) 和裸 URL
 * 返回 { text: 清理后的文本, images: [{url}], pdfs: [{url}] }
 */
const LOCAL_PATH_PREFIXES = ['/tmp/', '/root/', '/home/', '/var/']

function isLocalPath(url) {
  return LOCAL_PATH_PREFIXES.some(p => url.startsWith(p))
}

function toProxyUrl(path, token) {
  const qs = token ? `&token=${encodeURIComponent(token)}` : ''
  return `/api/local-file?path=${encodeURIComponent(path)}${qs}`
}

export function detectMediaUrls(text, token = '') {
  if (!text) return { text, images: [], pdfs: [] }

  const images = []
  const pdfs = []

  // 1. 处理 markdown 图片 ![alt](url)：保留语法在文本中，仅把本地路径替换为 proxy URL
  const mdImgRegex = /!\[([^\]]*)\]\(([^)\s]+)\)/g
  let cleaned = text.replace(mdImgRegex, (_match, alt, url) => {
    if (isLocalPath(url)) {
      return `![${alt}](${toProxyUrl(url, token)})`
    }
    return _match
  })

  // 2. 本地路径优先处理（避免后续 HTTP 正则改变周边字符导致匹配失败）
  // 2a. MEDIA: 前缀图片
  const localImgRegex = /(?:MEDIA|media):\s*(\/\S+\.(jpe?g|png|gif|webp|svg|bmp|ico))/gi
  cleaned = cleaned.replace(localImgRegex, (_match, path) => {
    images.push(toProxyUrl(path, token))
    return ''
  })

  // 2b. MEDIA: 前缀 PDF
  const localPdfRegex = /(?:MEDIA|media):\s*(\/\S+\.pdf)/gi
  cleaned = cleaned.replace(localPdfRegex, (_match, path) => {
    pdfs.push(toProxyUrl(path, token))
    return ''
  })

  // 2c. 裸本地文件路径
  // 关键修复：lookahead 不再排除 .，解决路径后跟句号（如句尾）无法匹配的问题
  const localPathRegex = /(?:^|(?<![\w/.\-]))((?:\/tmp\/|\/root\/|\/home\/|\/var\/)[\w/.\-]+\.(jpe?g|png|gif|webp|svg|bmp|ico|pdf|txt|csv))(?=$|(?![\w/\-]))/gi
  cleaned = cleaned.replace(localPathRegex, (_match, path) => {
    const proxyUrl = toProxyUrl(path, token)
    if (/\.(pdf|txt|csv)$/i.test(path)) {
      pdfs.push(proxyUrl)
    } else {
      images.push(proxyUrl)
    }
    return ''
  })

  // 3. 匹配裸图片 URL（排除 markdown 链接/图片语法中的 URL）
  const imgUrlRegex = /(?<!!?\[.*?\]\()https?:\/\/[^\s<>"]+\.(jpe?g|png|gif|webp|svg|bmp|ico)(\?[^\s<>"\)]*)?/gi
  cleaned = cleaned.replace(imgUrlRegex, (url) => {
    images.push(url)
    return ''
  })

  // 4. 匹配裸 PDF URL（排除 markdown 链接中的 URL）
  const pdfUrlRegex = /(?<!!?\[.*?\]\()https?:\/\/[^\s<>"]+\.pdf(\?[^\s<>"\)]*)?/gi
  cleaned = cleaned.replace(pdfUrlRegex, (url) => {
    pdfs.push(url)
    return ''
  })

  // 5. 匹配裸文本/CSV URL（排除 markdown 链接中的 URL，作为可下载文件处理）
  const fileUrlRegex = /(?<!!?\[.*?\]\()https?:\/\/[^\s<>"]+\.(txt|csv)(\?[^\s<>"\)]*)?/gi
  cleaned = cleaned.replace(fileUrlRegex, (url) => {
    pdfs.push(url)
    return ''
  })

  return { text: cleaned.trim(), images, pdfs }
}

/**
 * 判断 URL 是否为图片
 */
export function isImageUrl(url) {
  return /\.(jpe?g|png|gif|webp|svg|bmp|ico)(\?.*)?$/i.test(url)
}

/**
 * 判断 URL 是否为 PDF
 */
export function isPdfUrl(url) {
  return /\.pdf(\?.*)?$/i.test(url)
}

/**
 * 图片点击全屏预览
 */
export function previewImage(url, allImages = []) {
  showImagePreview({
    images: allImages.length > 0 ? allImages : [url],
    startPosition: allImages.indexOf(url),
    closeable: true,
  })
}

// Configure marked with highlight.js
const marked = new Marked({
  breaks: true,
  gfm: true,
  renderer: {
    image({ href, title, text }) {
      return `<img src="${href}" alt="${text || ''}" style="max-width:100%;height:auto;border-radius:8px;cursor:pointer">`
    },
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
      // 容错：空内容直接展示占位提示
      const codeText = (text || '').trim()
      if (!codeText) {
        return `<div class="code-block"><div class="code-header"><span class="code-lang">${language}</span><button class="code-copy">复制</button></div><pre><code class="hljs language-${language}"> </code></pre></div>`
      }
      try {
        const highlighted = hljs.highlight(codeText, { language }).value
        return `<div class="code-block"><div class="code-header"><span class="code-lang">${language}</span><button class="code-copy" data-copy-code>复制</button></div><pre><code class="hljs language-${language}">${highlighted}</code></pre></div>`
      } catch {
        // highlight 失败时降级为纯文本
        const escaped = codeText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        return `<div class="code-block"><div class="code-header"><span class="code-lang">${language}</span><button class="code-copy">复制</button></div><pre><code class="hljs language-${language}">${escaped}</code></pre></div>`
      }
    }
  }
})

/**
 * 修复流式 Markdown 中未闭合的代码块
 * 流式输出过程中，``` 开了但还没闭合会导致 marked 把后续内容全部吞掉
 */
function fixUnclosedCodeBlocks(text) {
  // 统计 ``` 出现次数（排除行内 ` 包裹的情况）
  const matches = text.match(/^```/gm)
  const count = matches ? matches.length : 0
  // 奇数个 => 有未闭合的代码块，补上闭合
  if (count % 2 !== 0) {
    return text + '\n```'
  }
  return text
}

/**
 * Render Markdown text to HTML (for AI messages)
 * 流式安全：自动修复未闭合代码块
 */
export function renderMarkdown(text) {
  if (!text) return ''
  const safeText = fixUnclosedCodeBlocks(text)
  const rawHtml = marked.parse(safeText)
  const purified = DOMPurify.sanitize(rawHtml, {
    ADD_TAGS: ['img'],
    ADD_ATTR: ['src', 'alt', 'style'],
  })
  return purified
}

/**
 * Format plain text for HTML rendering (escape + line breaks, for user messages)
 */
export function formatText(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
}

/**
 * Extract text content from a history entry.
 * Handles string content, array of parts, and fallback to .text field.
 */
export function extractText(entry) {
  if (!entry) return ''
  if (typeof entry === 'string') return entry

  const unwrap = entry.message || entry.item || entry.data || entry.payload || entry
  const content = unwrap.content ?? unwrap.text ?? unwrap.value
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p
        if (!p || typeof p !== 'object') return ''
        if (typeof p.text === 'string') return p.text
        if (typeof p.content === 'string') return p.content
        if (Array.isArray(p.content)) return extractText({ content: p.content })
        if (typeof p.value === 'string') return p.value
        return ''
      })
      .filter(Boolean)
      .join('')
  }
  if (content && typeof content === 'object') return extractText(content)
  return unwrap.text || entry.text || ''
}
