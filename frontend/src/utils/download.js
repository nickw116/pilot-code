import { API_BASE, TOKEN_KEY } from '../constants/index.js'

const API_DOWNLOAD = `${API_BASE}/download`

/**
 * Trigger a reliable file download.
 *
 * For HTTP(S) URLs we proxy through the bridge so mobile browsers
 * honour the filename.  Local paths are also sent through the proxy.
 * Falls back to opening the original URL in a new tab if anything fails.
 */
export async function downloadFile(file) {
  const url = file?.url || ''
  const filename = file?.filename || 'download'

  if (!url) {
    console.warn('[download] empty url')
    return
  }

  const token = sessionStorage.getItem(TOKEN_KEY)
  const isHttpUrl = /^https?:\/\//i.test(url)

  // Always use the proxy for reliable cross-origin downloads on mobile
  const downloadUrl = isHttpUrl
    ? `${API_DOWNLOAD}?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`
    : `${API_DOWNLOAD}?path=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`

  try {
    const resp = await fetch(downloadUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`)
    }

    const blob = await resp.blob()
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(blobUrl)
  } catch (err) {
    console.error('[download] failed:', err)
    // Fallback: open original URL
    window.open(url, '_blank')
  }
}
