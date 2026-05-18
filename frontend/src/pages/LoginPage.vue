<template>
  <div class="login-page">
    <div class="login-box">
      <!-- CSS Robot Icon -->
      <div class="bot-icon">
        <div class="bot-head"></div>
        <div class="bot-eye left"></div>
        <div class="bot-eye right"></div>
        <div class="bot-mouth"></div>
        <div class="bot-antenna"></div>
      </div>
      <h2>PILOT AGENT</h2>
      <van-cell-group inset class="login-fields">
        <van-field :model-value="username" @update:model-value="$emit('update:username', $event)" label="用户名" placeholder="用户名" />
        <van-field :model-value="password" @update:model-value="$emit('update:password', $event)" label="密码" type="password" placeholder="密码" />
      </van-cell-group>
      <van-button type="primary" block class="login-btn" @click="$emit('login')">
        进入
      </van-button>
    </div>
  </div>
</template>

<script setup>
defineProps({
  username: { type: String, default: '' },
  password: { type: String, default: '' },
})

defineEmits(['update:username', 'update:password', 'login'])
</script>

<style>
/* ── Login Page ── */
.login-page {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(160deg, #E8F0FE 0%, #F8FAFF 40%, #FFFFFF 100%);
  padding: 20px;
}
.login-box {
  background: #FFFFFF;
  border: 1px solid #E5E5E5;
  border-radius: 24px;
  padding: 40px 28px;
  width: 100%;
  max-width: 380px;
  box-shadow: 0 8px 30px rgba(0, 122, 255, 0.08);
  animation: fadeInUp 0.5s ease;
}
.login-box h2 {
  font-family: 'Space Grotesk', sans-serif;
  text-align: center;
  margin-bottom: 28px;
  color: #1F1F1F;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.5px;
}

/* CSS Robot Icon */
.bot-icon {
  width: 64px;
  height: 64px;
  margin: 0 auto 16px;
  position: relative;
}
.bot-head {
  width: 48px;
  height: 40px;
  background: #F0F5FF;
  border-radius: 12px;
  border: 1px solid #E0EAFF;
  position: absolute;
  left: 8px;
  top: 14px;
}
.bot-eye {
  width: 8px;
  height: 8px;
  background: #007AFF;
  border-radius: 50%;
  position: absolute;
  top: 28px;
}
.bot-eye.left { left: 18px; }
.bot-eye.right { right: 18px; }
.bot-mouth {
  width: 20px;
  height: 6px;
  border-bottom: 3px solid #007AFF;
  border-radius: 0 0 10px 10px;
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
}
.bot-antenna {
  width: 4px;
  height: 12px;
  background: #D0DFFF;
  position: absolute;
  top: 2px;
  left: 50%;
  transform: translateX(-50%);
  border-radius: 2px;
}
.bot-antenna::after {
  content: '';
  width: 10px;
  height: 10px;
  background: #007AFF;
  border-radius: 50%;
  position: absolute;
  top: -6px;
  left: -3px;
  box-shadow: 0 0 10px rgba(0, 122, 255, 0.4);
}

.login-fields { margin-top: 0; }
.login-fields .van-cell-group--inset { margin: 0; }
.login-btn {
  margin-top: 28px;
  height: 46px;
  font-size: 16px;
  font-weight: 600;
  font-family: 'Space Grotesk', sans-serif;
}
.login-btn.van-button {
  margin-top: 28px;
  border-radius: 14px;
  background: #007AFF;
  border: none;
  box-shadow: 0 4px 16px rgba(0, 122, 255, 0.25);
  transition: all 0.25s ease;
}
.login-btn.van-button:hover {
  background: #3395FF;
  box-shadow: 0 6px 24px rgba(0, 122, 255, 0.35);
  transform: translateY(-1px);
}
.login-btn:active { transform: scale(0.97) translateY(0); }

@keyframes fadeInUp {
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
