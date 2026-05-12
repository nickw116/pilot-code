import { ref } from 'vue'
import { showNotify } from 'vant'
import {
  API_BASE,
  TOKEN_KEY,
  API_STATUS,
  API_LOGIN,
  API_SESSION,
  API_CHANGE_PASSWORD,
} from '../constants/index.js'

export function useAuth() {
  const loggedIn = ref(false)
  const token = ref('')
  const currentUser = ref(null)
  const username = ref('')
  const password = ref('')
  const sessionKey = ref('')

  async function fetchSessionKey() {
    try {
      const r = await fetch(`${API_BASE}${API_SESSION}`, {
        headers: { Authorization: `Bearer ${token.value}` },
      })
      if (r.ok) {
        const data = await r.json()
        sessionKey.value = data.sessionKey
      }
    } catch (err) {
      console.error('[useAuth] fetchSessionKey failed:', err)
    }
  }

  async function checkToken() {
    try {
      const r = await fetch(`${API_BASE}${API_STATUS}`, {
        headers: { Authorization: `Bearer ${token.value}` },
      })
      if (r.ok) {
        const data = await r.json()
        currentUser.value = { username: data.user, role: data.role }
        loggedIn.value = true
        await fetchSessionKey()
        return true
      } else {
        sessionStorage.removeItem(TOKEN_KEY)
      }
    } catch (err) {
      console.error('[useAuth] checkToken failed:', err)
      sessionStorage.removeItem(TOKEN_KEY)
    }
    return false
  }

  function initFromStorage() {
    const saved = sessionStorage.getItem(TOKEN_KEY)
    if (saved) {
      token.value = saved
      return checkToken()
    }
    return Promise.resolve(false)
  }

  async function login() {
    if (!username.value.trim() || !password.value.trim()) return false
    try {
      const r = await fetch(`${API_BASE}${API_LOGIN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.value,
          password: password.value,
        }),
      })
      if (r.ok) {
        const data = await r.json()
        token.value = data.token
        currentUser.value = { username: data.username, role: data.role }
        sessionStorage.setItem(TOKEN_KEY, data.token)
        await fetchSessionKey()
        loggedIn.value = true
        return true
      } else {
        showNotify({ type: 'danger', message: '用户名或密码错误' })
      }
    } catch (err) {
      console.error('[useAuth] login failed:', err)
      alert('连接失败')
    }
    return false
  }

  function logout() {
    sessionStorage.removeItem(TOKEN_KEY)
    token.value = ''
    currentUser.value = null
    sessionKey.value = ''
    loggedIn.value = false
  }

  async function changePassword(oldPassword, newPassword) {
    try {
      const r = await fetch(`${API_BASE}${API_CHANGE_PASSWORD}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token.value}`,
        },
        body: JSON.stringify({
          old_password: oldPassword,
          new_password: newPassword,
        }),
      })
      const data = await r.json()
      if (r.ok) {
        // 密码修改成功，服务端已撤销所有 token，前端 logout
        logout()
        return { ok: true }
      } else {
        return { ok: false, message: data.detail || '修改失败' }
      }
    } catch (err) {
      return { ok: false, message: '连接失败' }
    }
  }

  return {
    loggedIn,
    token,
    currentUser,
    username,
    password,
    sessionKey,
    initFromStorage,
    login,
    logout,
    changePassword,
  }
}
