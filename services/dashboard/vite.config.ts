import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` serves the UI on :5173 and proxies the API to a running
// gateway (default: the local cluster). The gateway rejects cookie-authed
// writes whose Origin isn't its own host, so the proxy presents the target's
// origin. In the cluster none of this applies: UI, /api and /mcp share a host.
const target = process.env.GATEWAY_URL ?? "http://app.127.0.0.1.nip.io";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target,
        changeOrigin: true,
        configure: (proxy) => proxy.on("proxyReq", (req) => req.setHeader("origin", target)),
      },
    },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 600 },
});
