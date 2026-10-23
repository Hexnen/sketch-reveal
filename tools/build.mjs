// Składa src/entry.ts (reveal-core z repo Hexnen/roleplay, gałąź feat/foundry-sketch-reveal) w vendor/reveal-core.js
import { build } from "esbuild";
await build({
  entryPoints: ["src/entry.ts"], bundle: true, format: "esm", target: "es2022",
  outfile: "vendor/reveal-core.js", minify: true, legalComments: "none", logLevel: "info",
});
