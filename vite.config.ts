import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'editor': ['@uiw/react-codemirror', '@codemirror/lang-markdown', '@codemirror/view'],
          'graph': ['react-force-graph-2d'],
          'flow': ['@xyflow/react'],
        },
      },
    },
  },
});
