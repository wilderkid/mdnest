#!/usr/bin/env bash
# Copies third-party runtime assets into place (idempotent). Run after `npm install`.
set -euo pipefail
cd "$(dirname "$0")/.."
NM=node_modules
# 1) MathJax 4 (Apache-2.0) + New Computer Modern SVG font (OFL) → public/vendor
mkdir -p public/vendor
rm -rf public/vendor/mathjax public/vendor/mathjax-newcm-font && mkdir -p public/vendor/mathjax-newcm-font
cp -a "$NM/mathjax" public/vendor/mathjax && rm -f public/vendor/mathjax/*.cjs public/vendor/mathjax/node-main* public/vendor/mathjax/*.md
cp -a "$NM/@mathjax/mathjax-newcm-font/svg" public/vendor/mathjax-newcm-font/svg
cp "$NM/@mathjax/mathjax-newcm-font/svg.js" public/vendor/mathjax-newcm-font/ 2>/dev/null || true
# 2) themes/github: Open Sans (OFL, @fontsource) under the file names Typora-style themes reference
mkdir -p themes/github
F=$NM/@fontsource/open-sans/files
cp "$F/open-sans-latin-400-normal.woff2" themes/github/open-sans-v17-latin-ext_latin-regular.woff2
cp "$F/open-sans-latin-400-italic.woff2" themes/github/open-sans-v17-latin-ext_latin-italic.woff2
cp "$F/open-sans-latin-600-normal.woff2" themes/github/open-sans-v17-latin-ext_latin-600.woff2
cp "$F/open-sans-latin-600-italic.woff2" themes/github/open-sans-v17-latin-ext_latin-600italic.woff2
cp "$F/open-sans-latin-700-normal.woff2" themes/github/open-sans-v17-latin-ext_latin-700.woff2
cp "$F/open-sans-latin-700-italic.woff2" themes/github/open-sans-v17-latin-ext_latin-700italic.woff2
cp "$NM/@fontsource/open-sans/LICENSE" themes/github/OFL-LICENSE.txt 2>/dev/null || true
cat > themes/github/open-sans.css <<'CSS'
@font-face { font-family: "Open Sans"; font-style: normal; font-weight: 400; font-display: swap; src: url("open-sans-v17-latin-ext_latin-regular.woff2") format("woff2"); }
@font-face { font-family: "Open Sans"; font-style: italic; font-weight: 400; font-display: swap; src: url("open-sans-v17-latin-ext_latin-italic.woff2") format("woff2"); }
@font-face { font-family: "Open Sans"; font-style: normal; font-weight: 600; font-display: swap; src: url("open-sans-v17-latin-ext_latin-600.woff2") format("woff2"); }
@font-face { font-family: "Open Sans"; font-style: normal; font-weight: 700; font-display: swap; src: url("open-sans-v17-latin-ext_latin-700.woff2") format("woff2"); }
@font-face { font-family: "Open Sans"; font-style: italic; font-weight: 700; font-display: swap; src: url("open-sans-v17-latin-ext_latin-700italic.woff2") format("woff2"); }
CSS
# 3) bundle built-in themes for Tauri
mkdir -p src-tauri/resources/themes
rm -rf src-tauri/resources/themes && mkdir -p src-tauri/resources && cp -a themes src-tauri/resources/themes
# 4) dev-only test fixtures: gallery themes copied unmodified (NOT committed / NOT shipped)
G=${GALLERY:-/workspace/typora-re/gallery}
if [ -d "$G" ]; then
  mkdir -p dev-data/themes dev-data/workspace
  cp -a themes/. dev-data/themes/
  for t in DrakeTyporaTheme/drake typora-theme-lapis/lapis typora-vue-theme/vue typora-purple-theme/purple Mdmdt/mdmdt; do
    d=$(dirname "$t"); n=$(basename "$t")
    for css in "$G/$d"/$n*.css; do cp "$css" dev-data/themes/; done
    if [ -d "$G/$d/$n" ]; then mkdir -p "dev-data/themes/$n"; cp -a "$G/$d/$n/." "dev-data/themes/$n/"; fi
  done
fi
echo "assets ready"
