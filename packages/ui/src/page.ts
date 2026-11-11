/** The web chat page (card U07), served at /. No inline script or style: the controller's content security policy allows only its own files. */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>NimbleNewt</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main id="gate" class="gate" hidden>
  <h1>NimbleNewt</h1>
  <p class="meta">Sign in with your owner credential, or with a pairing code made in a browser that is already signed in.</p>
  <form id="login" autocomplete="off">
    <label for="mode">Sign in with</label>
    <select id="mode"><option value="token">Owner credential</option><option value="code">Pairing code</option></select>
    <label for="secret">Credential or code</label>
    <input id="secret" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="text" required>
    <button class="btn primary" type="submit">Sign in</button>
    <p id="gate-error" class="error" role="alert"></p>
  </form>
</main>
<div id="app" class="app" hidden>
  <header class="bar">
    <strong>NimbleNewt</strong>
    <span id="who" class="meta"></span>
    <span id="net" class="pill ok" role="status" aria-live="polite">Connected</span>
  </header>
  <nav id="tabs" class="tabs" role="tablist" aria-label="Sections"></nav>
  <section id="chat" class="chat">
    <div id="log" class="log" role="log" aria-live="polite"></div>
    <div id="chips" class="chips"></div>
    <form id="composer" class="composer">
      <label for="text" class="sr">Message</label>
      <textarea id="text" rows="1" maxlength="4000" placeholder="Say what you want done" enterkeyhint="send"></textarea>
      <button class="btn primary" type="submit">Send</button>
    </form>
  </section>
  <section id="view" class="view" hidden></section>
</div>
<noscript><p class="gate">The web chat needs JavaScript.</p></noscript>
<script src="/app.js"></script>
</body>
</html>
`;

export const MANIFEST = JSON.stringify({ name: "NimbleNewt", short_name: "NimbleNewt", start_url: "/", display: "standalone", background_color: "#101418", theme_color: "#101418" });
