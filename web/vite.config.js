import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind to all interfaces so a phone on the same wifi can open it. The /api proxy
    // below still runs on THIS machine, so the phone never needs to reach the API
    // directly — it talks only to Vite, which forwards server-side.
    host: true,
    // The SPA calls /api/* and Vite forwards to the Express server, so the browser
    // never deals with cross-origin requests in development.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
