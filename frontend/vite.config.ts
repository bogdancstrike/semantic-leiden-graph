import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: true,
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        // Only self-contained libraries get their own chunk. antd and its rc-*
        // dependencies are left to Rollup: hand-splitting them can produce a
        // cross-chunk cycle that leaves a constructor undefined at first render.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('/d3-')) return 'vendor-d3'
          if (id.includes('papaparse')) return 'vendor-csv'
          if (id.includes('/echarts/') || id.includes('/zrender/')) return 'vendor-echarts'
          if (id.includes('@tanstack')) return 'vendor-query'
          return undefined
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
