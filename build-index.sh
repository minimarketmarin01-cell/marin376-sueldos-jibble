#!/bin/sh
# Regenera index.html (documento completo para GitHub Pages, con <head>,
# manifest y service worker) a partir de app.html (fragmento que usa el
# Artifact tool, sin doctype/html/head/body propios). Correr despues de
# cada cambio a app.html.
set -e
cd "$(dirname "$0")"

{
  cat <<'HEAD'
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="manifest" href="manifest.json">
<meta name="theme-color" content="#0F6B4C">
<link rel="apple-touch-icon" href="icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="mobile-web-app-capable" content="yes">
</head>
<body>
HEAD
  cat app.html
  cat <<'TAIL'
</body>
</html>
TAIL
} > index.html

echo "index.html regenerado a partir de app.html"
