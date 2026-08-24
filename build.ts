/**
 * Production build: ESM bundle (browser target, minified) + declaration files.
 *
 * Run via `bun run build` (see package.json). Not shipped in the published
 * tarball (`files: ["dist"]`).
 */

import { $ } from "bun";

const entry = "./src/index.ts";
const outdir = "./dist";

console.log("token-diet: bundling ESM for browsers…");

// `src/index.ts` rebinds exports (`export const x = impl`) because Bun 1.4
// DCE's live `export { x }` of side-effect-free modules into an empty barrel.
const result = await Bun.build({
  entrypoints: [entry],
  outdir,
  target: "browser",
  format: "esm",
  minify: true,
});

if (!result.success) {
  console.error("token-diet: Bun.build failed.");
  for (const log of result.logs) {
    console.error(String(log));
  }
  process.exit(1);
}

for (const output of result.outputs) {
  console.log(`  wrote ${output.path} (${output.size} bytes)`);
}

console.log("token-diet: generating .d.ts with tsc…");

try {
  await $`tsc --emitDeclarationOnly --outDir dist`;
} catch (error) {
  console.error("token-diet: tsc --emitDeclarationOnly failed (non-zero exit).");
  if (error instanceof Error) {
    console.error(error.message);
  }
  process.exit(1);
}

console.log("token-diet: build complete.");
