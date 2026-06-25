import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Proxy backend calls during local development. `/api` covers the JSON
    // endpoints (generate/render); `/media` serves the rendered MP4s — the
    // render response's `videoUrl` is `/media/...`, so without this proxy the
    // <video> in the preview panel would hit Vite instead of the backend.
    proxy: {
      '/api': 'http://localhost:8000',
      '/media': 'http://localhost:8000',
    },
  },
})
