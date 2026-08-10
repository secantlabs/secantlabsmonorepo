import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Flux serves from a subpath of secantlabs.org, so assets must be relative to
// /flux/. The engine package is consumed as TypeScript source via the
// @secantlabs/engine alias — no build step needed.
//
// That subpath is also what makes Flux publishable during the Warp freeze, where
// apps/warp and apps/lessons are not. The hazard the monorepo README describes is
// a second CNAME reaching the gh-pages root and stealing the custom domain:
// apps/warp/public/CNAME asks for warp.us.com. Flux's public/ holds a favicon and
// nothing else — no CNAME, no root-level file — so the root `build` script
// assembles apps/flux/dist into apps/landing/dist/flux and the domain is
// untouched. deploy.yml still publishes apps/landing/dist alone.
export default defineConfig({
  base: "/flux/",
  plugins: [react()],
  resolve: {
    alias: {
      "@secantlabs/engine": resolve(__dirname, "../../packages/engine/src"),
    },
  },
  // 5177–5179 tend to be occupied on the dev machine; lessons owns 5176.
  server: { port: 5180, strictPort: true },
});
