import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { build as buildWithEsbuild } from "esbuild";
import react from "@vitejs/plugin-react";

function reactVendorPlugin(): Plugin {
  let vendorBundle = "";

  return {
    name: "react-vendor",
    apply: "build",
    async buildStart() {
      const result = await buildWithEsbuild({
        stdin: {
          contents: `
            import React from "react";
            import ReactDOM from "react-dom/client";
            import { Fragment, jsx, jsxs } from "react/jsx-runtime";

            export const StrictMode = React.StrictMode;
            export const createRoot = ReactDOM.createRoot;
            export const hydrateRoot = ReactDOM.hydrateRoot;
            export const useEffect = React.useEffect;
            export const useMemo = React.useMemo;
            export const useRef = React.useRef;
            export const useState = React.useState;
            export { Fragment, jsx, jsxs };
          `,
          resolveDir: ".",
          sourcefile: "react-vendor.js",
        },
        bundle: true,
        define: { "process.env.NODE_ENV": '"production"' },
        format: "esm",
        minify: true,
        platform: "browser",
        target: "es2020",
        write: false,
      });

      vendorBundle = result.outputFiles[0].text;
    },
    transformIndexHtml(html) {
      const importMap = '<script type="importmap">{"imports":{"react":"/assets/vendor-react.js","react/jsx-runtime":"/assets/vendor-react.js","react-dom/client":"/assets/vendor-react.js"}}</script>';
      return html.replace("</head>", `${importMap}</head>`);
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "assets/vendor-react.js",
        source: vendorBundle,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), reactVendorPlugin()],
  build: {
    rollupOptions: {
      external: ["react", "react/jsx-runtime", "react-dom/client"],
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
});
