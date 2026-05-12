import { ref, onMounted, onBeforeUnmount } from 'vue'
import { API_BASE } from '../constants/index.js'

/**
 * 轻量健康检查 composable：
 * - 每 15 秒探测 /api/health
 * - 连续 2 次失败 → serviceStatus = 'down'（橙色提示）
 *   设计为连续 2 次失败才触发"服务重启"提示，避免弱网环境下偶发超时误报
 * - fetch 超时设为 10000ms（10 秒），适应移动端弱网环境
 * - 任意一次成功立即重置 failCount，快速恢复信任
 * - 恢复 → serviceStatus = 'recovered'（绿色提示，3 秒后自动消失）
 */
export function useServiceStatus() {
  const serviceStatus = ref('up') // 'up' | 'down' | 'recovered'
  let timer = null
  let recoverTimer = null
  let wasDown = false
  let failCount = 0

  async function check() {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)
      const resp = await fetch(`${API_BASE}/health`, { signal: controller.signal })
      clearTimeout(timeout)

      if (resp.ok) {
        // 任意一次成功立即重置失败计数
        failCount = 0

        if (wasDown) {
          // 从断开恢复
          serviceStatus.value = 'recovered'
          wasDown = false
          // 3 秒后隐藏恢复提示
          if (recoverTimer) clearTimeout(recoverTimer)
          recoverTimer = setTimeout(() => {
            if (serviceStatus.value === 'recovered') {
              serviceStatus.value = 'up'
            }
          }, 3000)
        }
      } else {
        markDown()
      }
    } catch {
      markDown()
    }
  }

  function markDown() {
    failCount++
    if (failCount >= 2 && !wasDown) {
      wasDown = true
      serviceStatus.value = 'down'
    }
  }

  onMounted(() => {
    check()
    timer = setInterval(check, 15000)
  })

  onBeforeUnmount(() => {
    if (timer) clearInterval(timer)
    if (recoverTimer) clearTimeout(recoverTimer)
  })

  return { serviceStatus }
}
