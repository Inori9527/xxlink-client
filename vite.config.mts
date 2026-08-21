import path from 'node:path'

import legacy from '@vitejs/plugin-legacy'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import svgr from 'vite-plugin-svgr'

const browserPreviewAliases =
  process.env.VITE_XXLINK_BROWSER_PREVIEW === '1'
    ? {
        '@tauri-apps/api/app': path.resolve('./src/dev-preview/tauri-app.ts'),
        '@tauri-apps/api/core': path.resolve(
          './src/dev-preview/invoke-mock.ts',
        ),
        '@tauri-apps/api/event': path.resolve(
          './src/dev-preview/tauri-event.ts',
        ),
        '@tauri-apps/api/webviewWindow': path.resolve(
          './src/dev-preview/tauri-webview-window.ts',
        ),
        '@tauri-apps/api/window': path.resolve(
          './src/dev-preview/tauri-window.ts',
        ),
        '@tauri-apps/api': path.resolve('./src/dev-preview/tauri-api.ts'),
        '@tauri-apps/plugin-http': path.resolve(
          './src/dev-preview/tauri-http.ts',
        ),
        '@tauri-apps/plugin-shell': path.resolve(
          './src/dev-preview/tauri-shell.ts',
        ),
        'tauri-plugin-mihomo-api': path.resolve(
          './src/dev-preview/mihomo-api.ts',
        ),
      }
    : {}

export default defineConfig({
  root: 'src',
  server: { port: 3000 },
  plugins: [
    svgr(),
    react(),
    legacy({
      modernTargets: ['edge>=109', 'safari>=14'],
      renderLegacyChunks: false,
      modernPolyfills: ['es.object.has-own', 'web.structured-clone'],
      additionalModernPolyfills: [
        path.resolve('./src/polyfills/matchMedia.js'),
        path.resolve('./src/polyfills/WeakRef.js'),
        path.resolve('./src/polyfills/RegExp.js'),
      ],
    }),
  ],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        // Keep MUI + its Emotion style engine in a single shared chunk.
        // Without this, Rollup would split Emotion into a lazy chunk that
        // only loads when a dynamically-imported component references it,
        // leaving the main bundle's MUI usage (e.g. the login page, which
        // is in the entry chunk) with an undefined style engine and
        // completely unstyled components.
        manualChunks: (id: string) => {
          if (
            id.includes('/node_modules/@mui/') ||
            id.includes('/node_modules/@emotion/')
          ) {
            return 'mui-core'
          }
          return undefined
        },
      },
    },
  },
  optimizeDeps: {
    include: [
      '@mui/material',
      '@mui/system',
      '@emotion/react',
      '@emotion/styled',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve('./src'),
      '@root': path.resolve('.'),
      ...browserPreviewAliases,
    },
  },
  define: {
    OS_PLATFORM: `"${process.platform}"`,
  },
})
