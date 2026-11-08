import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "react/jsx-runtime", replacement: fileURLToPath(new URL("./node_modules/react/jsx-runtime.js", import.meta.url)) },
      { find: "react/jsx-dev-runtime", replacement: fileURLToPath(new URL("./node_modules/react/jsx-dev-runtime.js", import.meta.url)) },
      { find: /^react$/, replacement: fileURLToPath(new URL("./node_modules/react/index.js", import.meta.url)) },
      { find: "react-dom/client", replacement: fileURLToPath(new URL("./node_modules/react-dom/client.js", import.meta.url)) },
      { find: /^react-dom$/, replacement: fileURLToPath(new URL("./node_modules/react-dom/index.js", import.meta.url)) },
      { find: /^three$/, replacement: fileURLToPath(new URL("./node_modules/three/build/three.module.js", import.meta.url)) },
      { find: "@prototipo", replacement: fileURLToPath(new URL("../prototipo", import.meta.url)) },
    ],
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8788",
    },
    fs: {
      allow: [".."],
    },
  },
});
