/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The DEVELOPMENT backend runs on :3002; the client dev server proxies /api to
// it so the browser stays same-origin and the session cookie flows.
//
// 3002, NOT 3001. Production listens on 3001, and this default is the single
// line that decides which backend the dev frontend talks to. Pointed at 3001 it
// would serve a local-looking UI backed by live production data whenever the
// production service is running — the dev backend would not even need to be up.
// Nothing here may be "simplified" back to the production port.
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3002';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      // We register + surface updates ourselves via useRegisterSW (PwaManager).
      injectRegister: false,
      includeAssets: ['icons/*.png', 'favicon.ico', 'browserconfig.xml'],
      manifest: {
        // A stable id keeps an installed app bound to this application even if
        // start_url ever changes; without it the browser derives the identity
        // from start_url and a change would register as a different app.
        id: '/',
        name: 'Kas Booking Dispatch',
        short_name: 'Kas',
        description: 'Trung tâm điều phối đặt phòng Booking.com nội bộ.',
        lang: 'vi',
        dir: 'ltr',
        display: 'standalone',
        // Preferred first: a desktop window with no browser chrome at all.
        // Browsers that do not know `window-controls-overlay` fall through to
        // `standalone`, which is what ships today, so this cannot regress.
        display_override: ['window-controls-overlay', 'standalone', 'minimal-ui'],
        orientation: 'any',
        start_url: '/',
        scope: '/',
        theme_color: '#2563eb',
        background_color: '#ffffff',
        categories: ['business', 'productivity', 'utilities'],
        icons: [
          { src: 'icons/icon-16.png', sizes: '16x16', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-32.png', sizes: '32x32', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-48.png', sizes: '48x48', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-64.png', sizes: '64x64', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-72.png', sizes: '72x72', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-96.png', sizes: '96x96', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-128.png', sizes: '128x128', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-144.png', sizes: '144x144', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-152.png', sizes: '152x152', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-180.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-256.png', sizes: '256x256', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-384.png', sizes: '384x384', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Maskable is a SEPARATE purpose on purpose: an icon declared
          // "any maskable" is padded on Android and looks shrunken on desktop.
          { src: 'icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-maskable-384.png', sizes: '384x384', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Jump-list entries on the taskbar / Start menu. Each points at a route
        // that already exists; none creates a new capability.
        shortcuts: [
          {
            name: 'Đơn mới',
            short_name: 'Đơn mới',
            description: 'Đơn được gửi đến chi nhánh, chờ tạo trên PMS.',
            url: '/app/new',
            icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Nhập đơn',
            short_name: 'Nhập đơn',
            description: 'Dán nội dung đặt phòng để điều phối.',
            url: '/app/dispatch',
            icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Tổng quan',
            short_name: 'Tổng quan',
            description: 'Tình hình điều phối hôm nay.',
            url: '/app/dashboard',
            icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
        ],
      },
      workbox: {
        // Precache the built static frontend only.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // SPA navigation falls back to the app shell, but NEVER for /api — so an
        // authenticated API request can never be answered from the cache.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/],
        // No runtime caching at all: operational/API data is always fetched live.
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    // Bind to all interfaces so receptionist machines on the LAN can reach the
    // dev server; production is served same-origin by the backend.
    host: true,
    //
    // THE PRODUCTION HOSTNAME IS DELIBERATELY NOT ALLOW-LISTED HERE.
    //
    // It used to be, "reachable through the operator's tunnel hostname as well
    // as the LAN" — and that one line is how the hotel ran on the DEVELOPMENT
    // server for an entire deployment. The tunnel pointed at 5173, Vite
    // accepted the production hostname because it was listed here, and Vite's
    // own /api proxy forwarded to the real backend. Everything worked:
    // logins, dispatch, bookings. Nothing looked wrong.
    //
    // But a dev server serves /src/main.tsx and @vite/client, and never the
    // built manifest or service worker, so the app was permanently
    // uninstallable and nobody could see why — the symptom was a missing
    // button, three layers away from the cause.
    //
    // Without this entry Vite refuses the tunnel outright with "Blocked
    // request. This host is not allowed", which turns a silent wrong-mode
    // deployment into an immediate, obvious failure. Production is served by
    // the backend on one origin; that is what KasService.cmd starts.
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
