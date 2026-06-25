import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Proxy API calls to the FastAPI backend during local development.
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
