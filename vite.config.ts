import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    // ffmpeg.wasm carrega o core via toBlobURL em runtime; não bundlar.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split vendor dependencies so they cache independently of app code.
        // When only app code changes (most deploys), users don't re-download
        // React/Supabase/Zustand. Views are further code-split via React.lazy
        // in App.tsx, so each route gets its own chunk automatically.
        //
        // Vite 8 uses Rolldown, which requires manualChunks as a function.
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
              return 'react-vendor';
            }
            if (id.includes('@supabase')) {
              return 'supabase';
            }
            if (id.includes('@ffmpeg')) {
              return 'ffmpeg';
            }
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
  },
})
