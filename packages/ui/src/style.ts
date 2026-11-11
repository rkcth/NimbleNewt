/** The web chat style (card U07): phone first, one column, touch targets of at least 44 pixels, 16 pixel text in inputs (no zoom on focus), safe-area insets, light and dark. */
export const APP_CSS = `:root{--bg:#f6f7f9;--fg:#14181d;--muted:#5b6672;--panel:#fff;--line:#d9dee4;--accent:#1b6ef3;--accent-fg:#fff;--me:#dbe8ff;--bot:#fff;--ok:#18794e;--warn:#b25e09;--bad:#b3261e;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#101418;--fg:#e8ecf1;--muted:#97a3b0;--panel:#181e25;--line:#2b343e;--accent:#5b9bff;--accent-fg:#06101f;--me:#1d3557;--bot:#1b222a;--ok:#4fc38a;--warn:#e5a04b;--bad:#ff8a80}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
body{padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
h1,h2{margin:.4em 0}
.gate{max-width:28rem;margin:0 auto;padding:1.5rem 1rem}
.gate form{display:flex;flex-direction:column;gap:.5rem}
label{font-size:.875rem;color:var(--muted)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
input,select,textarea{font:inherit;font-size:16px;color:var(--fg);background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:.65rem .75rem;min-height:44px;width:100%}
.app{display:flex;flex-direction:column;height:100vh;height:100dvh;max-width:48rem;margin:0 auto}
.bar{display:flex;align-items:center;gap:.5rem;padding:.5rem .75rem;border-bottom:1px solid var(--line)}
.bar .meta{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{font-size:.75rem;padding:.2rem .6rem;border-radius:999px;border:1px solid currentColor}
.pill.ok{color:var(--ok)}.pill.warn{color:var(--warn)}
.tabs{display:flex;gap:.25rem;overflow-x:auto;padding:.25rem .5rem;border-bottom:1px solid var(--line);-webkit-overflow-scrolling:touch}
.tab{flex:0 0 auto;min-height:44px;padding:0 .9rem;border:0;border-radius:10px;background:transparent;color:var(--muted);font:inherit}
.tab[aria-selected=true]{background:var(--panel);color:var(--fg);box-shadow:inset 0 -2px 0 var(--accent)}
.chat{display:flex;flex-direction:column;flex:1;min-height:0}
.log,.view{flex:1;min-height:0;overflow-y:auto;padding:.75rem;display:flex;flex-direction:column;gap:.5rem;overscroll-behavior:contain}
.view{display:block}
.view[hidden],.chat[hidden],#gate[hidden],#app[hidden]{display:none}
.msg{max-width:85%;padding:.55rem .8rem;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--line)}
.msg.me{align-self:flex-end;background:var(--me)}
.msg.bot{align-self:flex-start;background:var(--bot)}
.meta{font-size:.8rem;color:var(--muted);overflow-wrap:anywhere}
.error{color:var(--bad);min-height:1.4em}
.chips{display:flex;gap:.4rem;overflow-x:auto;padding:.25rem .75rem}
.chip{flex:0 0 auto;min-height:44px;padding:0 .9rem;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--fg);font:inherit}
.composer{display:flex;gap:.5rem;align-items:flex-end;padding:.5rem .75rem;border-top:1px solid var(--line);background:var(--bg)}
.composer textarea{flex:1;resize:none;max-height:160px}
.btn{min-height:44px;min-width:44px;padding:0 1rem;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--fg);font:inherit;margin:.25rem .25rem .25rem 0}
.btn.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.btn.danger{color:var(--bad)}
.card{border:1px solid var(--line);background:var(--panel);border-radius:12px;padding:.6rem .8rem;margin:.4rem 0}
.card-title{font-weight:600;margin-bottom:.25rem}
.card-line{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.9rem}
.row{display:flex;gap:.5rem;flex-wrap:wrap}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
@media (prefers-reduced-motion:no-preference){.log{scroll-behavior:smooth}}
@media (min-width:700px){.msg{max-width:70%}}
`;
