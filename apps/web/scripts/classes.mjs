// Fails on any Tailwind class that has a canonical spelling, the check the Tailwind editor
// extension shows as a warning, so CI catches what the editor would. `--write` fixes them.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { __unstable__loadDesignSystem } from "tailwindcss";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const write = process.argv.includes("--write");

async function loadStylesheet(id, base) {
  const file =
    id === "tailwindcss" ? require.resolve("tailwindcss/index.css") : path.resolve(base, id);
  return { path: file, base: path.dirname(file), content: await readFile(file, "utf8") };
}

const cssPath = path.join(root, "src/app/globals.css");
const design = await __unstable__loadDesignSystem(await readFile(cssPath, "utf8"), {
  base: path.dirname(cssPath),
  loadStylesheet,
});

const memo = new Map();
function canonical(token) {
  if (!memo.has(token)) {
    const valid = design.candidatesToCss([token])[0] !== null;
    const fixed = valid ? design.canonicalizeCandidates([token], { rem: 16 })[0] : token;
    memo.set(token, fixed);
  }
  return memo.get(token);
}

async function* sources(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(p);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) yield p;
  }
}

const STRING = /"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g;
let found = 0;
for await (const file of sources(path.join(root, "src"))) {
  const text = await readFile(file, "utf8");
  const out = text.replace(STRING, (literal, _d, _s, _t, offset) =>
    literal.replace(/[^\s"'`${}]+/g, (token) => {
      const fixed = canonical(token);
      if (fixed === token) return token;
      found++;
      const line = text.slice(0, offset).split("\n").length;
      console.log(`${path.relative(root, file)}:${line}  ${token} -> ${fixed}`);
      return fixed;
    }),
  );
  if (write && out !== text) await writeFile(file, out);
}

if (found > 0 && !write) {
  console.log(
    `\n${found} Tailwind class(es) have a canonical spelling; run pnpm format to fix them.`,
  );
  process.exit(1);
}
