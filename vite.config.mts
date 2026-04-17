import path from 'node:path'

import legacy from '@vitejs/plugin-legacy'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import svgr from 'vite-plugin-svgr'

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
        manualChunks: {
          'mui-core': [
            '@mui/material',
            '@mui/system',
            '@mui/icons-material',
            '@mui/lab',
            '@emotion/react',
            '@emotion/styled',
          ],
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
    },
  },
  define: {
    OS_PLATFORM: `"${process.platform}"`,
  },
})
