# BatteryAnalyzer

Browser-based battery analyser for PV systems with a home battery: it reads 15-minute measurements and
simulates how a larger or smaller battery would have changed grid import, feed-in and costs. All results
are estimates from a simplified model and may contain errors. Supported file formats are defined in
`src/core/formats/`. Everything runs client-side: the file is opened and analysed in the browser, nothing
is sent to a server. Static build, hosted on GitHub Pages.

## Privacy

- The chosen ZIP/CSV is read with the File API and analysed in memory; it is never uploaded.
- The published page carries a Content Security Policy with `connect-src 'none'`: it cannot
  send requests anywhere, even by mistake.
- Every loaded file is kept in the browser's IndexedDB (local only), one file per dataset, so it
  can be reopened from the start screen ("Daten wechseln"); the last used one opens on the next
  visit. Each dataset (or all) can be deleted there. Settings live in localStorage.
- No cookies, no tracking or analytics. The host, GitHub Pages, logs visitors' IP addresses for
  security purposes; the start screen's privacy note and the footer say so and link GitHub's
  privacy statement.

## Development

```powershell
npm install
npm test          # unit tests (Vitest)
npm run dev       # local dev server (no CSP, hot reload)
npm run build     # static site in dist/
npm run preview   # serve dist/ with the CSP, like on GitHub Pages
```

## Structure

- `src/core/` – calculation logic, no UI
  - `data.ts` – read CSV files and ZIPs (JSZip + small CSV parser), recognise the format, merge,
    derive grid flow; independent of the file format
  - `formats/` – one module per supported file format (header recognition and parsing into rows);
    currently `solar-manager.ts` (Solar Manager export, CSV or ZIP)
  - `tariff.ts` – tariff periods (from–to dates): HT/NT prices in CHF/kWh, fixed fee and HT times for
    Mon–Fri, Saturday and Sunday; days outside every period use the nearest one
  - `sim.ts` – larger (add-on) and smaller battery simulation
  - `analysis.ts` – flows, aggregation, KPIs, size curve, efficiency, full cycles
- `src/curve.worker.ts` – size curve (41 simulations) in a web worker, as daily sums
- `src/ui/` – figures (Plotly), calendar helpers, number format, browser storage, DOM helpers
  - `tariff-editor.ts` – tariff periods in the "Daten" view (add / remove, dates, prices, HT times)
  - `power-editor.ts` – power steps in the "Daten" view (from which total size, charge / discharge power)
  - `method.ts` – charts of the "Methode" view: two example days run through the real loader and
    simulation, plus the parameter values shown in its text
  - `example-days.ts` – the two example days of the "Methode" view (15-minute measurements)
- `src/method.html` – text of the "Methode" view with LaTeX formulas; the build inserts it into
  `index.html` and renders the formulas to MathML with Temml (build time only, nothing shipped)
- `src/main.ts` – app state, views, events, rendering; `index.html`, `src/style.css`

## Deployment (GitHub Pages)

`.github/workflows/pages.yml` tests, builds and publishes on every push to `main`.
One-time setup in the GitHub repo: Settings → Pages → Source: **GitHub Actions**.
Asset paths are relative, so the site works under `https://<user>.github.io/<repo>/`.

## License

MIT, see [LICENSE](LICENSE). The build writes `THIRD-PARTY-LICENSES.txt` next to the page (linked
in its footer) with the license texts of all bundled npm packages (Plotly, JSZip and their
dependencies; JSZip is used under the MIT option of its MIT/GPL-3.0 dual license). The build fails
if a bundled package has no license text.
