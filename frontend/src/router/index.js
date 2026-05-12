import { createRouter, createWebHashHistory } from 'vue-router'
import LoginPage from '../pages/LoginPage.vue'
import ChatPage from '../pages/ChatPage.vue'
import { TOKEN_KEY } from '../constants/index.js'

const routes = [
  {
    path: '/',
    redirect: '/chat',
  },
  {
    path: '/login',
    name: 'Login',
    component: LoginPage,
    meta: { requiresAuth: false },
  },
  {
    path: '/chat',
    name: 'Chat',
    component: ChatPage,
    meta: { requiresAuth: true },
  },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

// 简单的 token 存在性检查（详细校验由 App.vue 的 useAuth.initFromStorage 异步完成）
router.beforeEach((to) => {
  const hasToken = !!sessionStorage.getItem(TOKEN_KEY)

  if (to.meta.requiresAuth && !hasToken) {
    return { name: 'Login' }
  }
  if (to.name === 'Login' && hasToken) {
    return { name: 'Chat' }
  }
  return true
})

export default router
