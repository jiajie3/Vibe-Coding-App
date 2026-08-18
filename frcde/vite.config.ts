import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // 0.0.0.0 so the console is reachable from another device on the Wi-Fi,
    // the same way CFPI reaches the API. Nothing here touches the internet.
    host: true,
    port: 5173,
    // The console imports shared rules from cfpi/src/core — the deadline
    // semantics and, on the server side, the coverage engine. Vite refuses to
    // serve files above its root without this.
    fs: { allow: ['..'] },
    proxy: {
      '/v1': 'http://localhost:4000',
      '/uploads': 'http://localhost:4000',
    },
  },
});
