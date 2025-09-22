import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/devices': { target: 'http://localhost:3000', changeOrigin: true },
      '/connect': { target: 'http://localhost:3000', changeOrigin: true },
      '/disconnect': { target: 'http://localhost:3000', changeOrigin: true },
      '/scan': { target: 'http://localhost:3000', changeOrigin: true },
      '^/ws': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
      '^/events': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
