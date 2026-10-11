import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import temml from "temml";
import { defineConfig, type Plugin } from "vitest/config";

const METHOD_HTML = fileURLToPath(new URL("./src/method.html", import.meta.url));

/** Parts of a display formula separated by a top-level \qquad (outside braces, environments, \left…\right). */
function displayParts(tex: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < tex.length; i++) {
    if (tex[i] === "{" || tex.startsWith("\\begin", i) || tex.startsWith("\\left", i)) depth++;
    else if (tex[i] === "}" || tex.startsWith("\\end", i) || tex.startsWith("\\right", i)) depth--;
    else if (depth === 0 && tex.startsWith("\\qquad", i)) {
      parts.push(tex.slice(start, i));
      start = i + "\\qquad".length;
    }
  }
  return [...parts, tex.slice(start)].filter((p) => p.trim());
}

/**
 * LaTeX in \[ … \] (display) and \( … \) (inline) as MathML; a formula error fails the build. Display
 * formulas become one <math> per \qquad-separated part, so the parts can wrap on narrow screens.
 */
function texToMathMl(html: string): string {
  return html
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) =>
      displayParts(tex).map((part) => temml.renderToString(part, { displayMode: true, throwOnError: true })).join(""))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex: string) => temml.renderToString(tex, { throwOnError: true }));
}

/**
 * The "Methode" view's text lives in src/method.html: it is inserted at <!-- include:method --> with its
 * formulas already rendered to MathML, which browsers display natively (no math library on the page).
 */
function methodPage(): Plugin {
  return {
    name: "method-page",
    transformIndexHtml: (html) =>
      html.replace("<!-- include:method -->", () => texToMathMl(readFileSync(METHOD_HTML, "utf8"))),
    // Dev server: editing the text reloads the page (Vite reports paths with forward slashes)
    handleHotUpdate({ file, server }) {
      if (file === METHOD_HTML.replace(/\\/g, "/")) {
        server.ws.send({ type: "full-reload" });
        return [];
      }
    },
  };
}

/**
 * Content Security Policy for the published build: scripts and workers only from this site,
 * and no network access at all (connect-src 'none'), so the page cannot send data anywhere.
 * Not applied to the dev server, whose hot reload needs a websocket.
 */
function csp(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'", // Plotly injects its styles at runtime
    "img-src 'self' data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
  return {
    name: "csp",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

/** node_modules package directories whose code ends up in a bundle (main page and worker). */
const bundled = new Set<string>();

/** Directory of package `name` as Node resolves it from package directory `from`. */
function packageDir(name: string, from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) throw new Error(`Dependency ${name} of ${from} not found`);
  }
}

/** License text of a package: its LICENSE / COPYING file, else the "License" section of its README. */
function licenseText(dir: string): string | null {
  const files = readdirSync(dir);
  const file = files.find((f) => /^(licen[cs]e|copying)(\.|-|$)/i.test(f));
  if (file) return readFileSync(join(dir, file), "utf8").trim();
  const readme = files.find((f) => /^readme(\.|$)/i.test(f));
  const section = readme && /^#+ *licen[cs]e\b.*\n([\s\S]*?)(?=^#+ |(?![\s\S]))/im.exec(readFileSync(join(dir, readme), "utf8"));
  return section ? section[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim() : null;
}

/**
 * Third-party notices: collects the npm packages bundled into the page and the worker and, in the
 * page build (emit), writes THIRD-PARTY-LICENSES.txt with the license text of each of them and of
 * their dependencies. Fails the
 * build if a bundled package has no license text, so a new dependency cannot slip through.
 */
function licenses(emit: boolean): Plugin {
  return {
    name: "third-party-licenses",
    apply: "build",
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const id of chunk.moduleIds) {
          const m = /^\0?(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/?]+)/.exec(id);
          if (m) bundled.add(m[1]);
        }
      }
      if (!emit) return; // the worker is built first; the page build writes the file
      // Prebuilt dist files embed their dependencies (jszip.min.js contains pako, readable-stream, …)
      const dirs = new Set<string>();
      const add = (dir: string) => {
        if (dirs.has(dir)) return;
        dirs.add(dir);
        const deps = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies ?? {};
        for (const dep of Object.keys(deps)) add(packageDir(dep, dir));
      };
      bundled.forEach(add);
      const entries = [...dirs].map((dir) => {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        const text = licenseText(dir);
        if (!text) this.error(`No license text found for bundled package ${pkg.name} (${dir})`);
        // Dual-licensed packages (JSZip: MIT OR GPL-3.0-or-later) are used under MIT
        const used = / OR /.test(pkg.license) && /\bMIT\b/.test(pkg.license) ? ", used under MIT" : "";
        return { name: pkg.name as string, text: `${pkg.name} ${pkg.version} (${pkg.license}${used})\n\n${text}` };
      }).sort((a, b) => a.name.localeCompare(b.name));
      const rule = "\n\n" + "-".repeat(78) + "\n\n";
      this.emitFile({
        type: "asset",
        fileName: "THIRD-PARTY-LICENSES.txt",
        source: "Third-party software included in this site\n\n"
          + entries.map((e) => `- ${e.text.split("\n")[0]}`).join("\n") + rule + entries.map((e) => e.text).join(rule) + "\n",
      });
    },
  };
}

export default defineConfig({
  // Relative asset paths: the build works under any sub-path (e.g. GitHub Pages /<repo>/).
  base: "./",
  plugins: [csp(), licenses(true), methodPage()],
  worker: { format: "es", plugins: () => [licenses(false)] },
  build: { chunkSizeWarningLimit: 1500 }, // Plotly alone is ~1.1 MB
  test: {
    testTimeout: 120_000,
  },
});
