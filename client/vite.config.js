import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/devices': { target: 'http://192.168.88.103:3000', changeOrigin: true },
      '/connect': { target: 'http://192.168.88.103:3000', changeOrigin: true },
      '/disconnect': { target: 'http://192.168.88.103:3000', changeOrigin: true },
      '/scan': { target: 'http://192.168.88.103:3000', changeOrigin: true },
      '^/ws': {
        target: 'ws://192.168.88.103:3000',
        ws: true,
        changeOrigin: true,
      },
      '^/events': {
        target: 'http://192.168.88.103:3000',
        changeOrigin: true,
      },
    },
  },
})
