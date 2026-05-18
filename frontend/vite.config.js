import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { VantResolver } from '@vant/auto-import-resolver'
import postcssPresetEnv from 'postcss-preset-env'

export default defineConfig(() => {
  const buildVersion = Date.now()

  return {
    plugins: [
      vue(),
      Components({
        resolvers: [VantResolver()],
      }),
    ],
    css: {
      postcss: {
        plugins: [
          postcssPresetEnv({
            stage: 1,
            features: {
              'nesting-rules': true,
            },
          }),
        ],
      },
    },
    base: '/pilotAgent/',
    build: {
      rollupOptions: {
        output: {
          entryFileNames: `assets/[name]-${buildVersion}-[hash].js`,
          chunkFileNames: `assets/[name]-${buildVersion}-[hash].js`,
          assetFileNames: `assets/[name]-${buildVersion}-[hash][extname]`,
        },
      },
    },
    server: {
      proxy: {
        '/api': 'http://127.0.0.1:8081',
      },
    },
  }
})
