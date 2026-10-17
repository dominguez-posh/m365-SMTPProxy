// Build (esbuild).
//   npm run build   -> dist/ (web app) and server/dist/server.mjs (server)
//   npm run dev     -> web app with live rebuild; start the server separately (npm start) for the API
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const serve = process.argv.includes("--serve");
const outdir = "dist";

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync("web/public", outdir, { recursive: true });

const web = {
  entryPoints: { app: "web/src/main.tsx" },
  bundle: true,
  outdir,
  format: "esm",
  target: ["es2022"],
  jsx: "automatic",
  minify: !serve,
  sourcemap: serve ? "inline" : false,
  define: { "process.env.NODE_ENV": JSON.stringify(serve ? "development" : "production") },
  logLevel: "info",
};

if (serve) {
  const ctx = await esbuild.context(web);
  await ctx.watch();
  console.log("Web-App wird bei Änderungen neu gebaut (dist/). Server separat starten: npm start");
} else {
  await esbuild.build(web);
  await esbuild.build({
    entryPoints: ["server/src/main.ts"],
    bundle: true,
    platform: "node",
    target: ["node22"],
    format: "esm",
    outfile: "server/dist/server.mjs",
    logLevel: "info",
  });
}
