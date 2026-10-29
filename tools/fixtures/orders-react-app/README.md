# orders React app (acceptance fixture)

The developer's code from the manual alpha.49 E2E (filter by status, side card, status/order in the URL), unchanged, plus `src/main.jsx` and `index.html`
so it can be bundled. `tools/scripts/quality-browser-acceptance.mjs` installs react / react-dom, bundles it with esbuild, and lets Praxis Quality drive it in a real
browser. `variants`: the script builds a bundle without the Cancelled order (so the empty-state criterion can be proven) and one with a seeded Escape bug.
