// Shared password gate for every page on the Seagull Lab site.
//
// This is NOT real security -- GitHub Pages is static hosting with no
// server, so this can only ever be a client-side speed bump: it hides the
// page behind a password prompt in the browser, but anyone who really
// wants in can view source to find the hash, or hit a photo's/asset's
// direct URL and skip the site entirely. It's meant to keep casual/
// uninvited visitors out, not withstand a determined attempt.
//
// The password is compared as a SHA-256 hash rather than kept in plain
// text so it's at least not immediately copy-pasteable from view-source.
//
// How it's wired up: each page's <head> carries a small inline snippet
// (not in this file, since it must run synchronously before first paint)
// that adds the "sgl-authed" class to <html> if localStorage already has
// the unlock flag, paired with a CSS rule that hides <body> until that
// class is present. This file is included near the end of <body> -- if
// the page isn't already authed, it builds the password overlay; if it
// is, it does nothing and the page just renders normally.
(function () {
  var STORAGE_KEY = 'sgl_auth_v1';
  var PASSWORD_HASH = '372a40a5ed8f4c57e833a3743088d13adc2ba27809044ff365fbe03f2220813f';

  function isAuthed() {
    return document.documentElement.classList.contains('sgl-authed');
  }

  function reveal() {
    document.documentElement.classList.add('sgl-authed');
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch (e) { /* private mode etc -- fine, just won't persist */ }
    var overlay = document.getElementById('sglGate');
    if (overlay) overlay.remove();
  }

  function hashHex(text) {
    var data = new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', data).then(function (digest) {
      return Array.from(new Uint8Array(digest)).map(function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    });
  }

  function buildOverlay() {
    var overlay = document.createElement('div');
    overlay.id = 'sglGate';
    overlay.innerHTML =
      '<style>' +
      '#sglGate{visibility:visible;position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
      'background:radial-gradient(circle at 72% 20%,rgba(35,79,95,.35),transparent 28rem),linear-gradient(180deg,#081522,#06101b);' +
      'font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:20px}' +
      '#sglGate *{box-sizing:border-box}' +
      '#sglGate .sgl-card{width:100%;max-width:340px;padding:28px 26px;border:1px solid rgba(132,151,174,.18);border-radius:16px;background:rgba(10,23,37,.92);backdrop-filter:blur(6px)}' +
      '#sglGate .sgl-kicker{color:#47e7db;font-size:.66rem;font-weight:800;letter-spacing:.16em;text-transform:uppercase;margin:0 0 6px}' +
      '#sglGate h1{margin:0 0 18px;color:#edf5fb;font-size:1.15rem;font-weight:800}' +
      '#sglGate input{width:100%;min-height:44px;padding:0 14px;border:1px solid rgba(132,151,174,.18);border-radius:9px;background:rgba(255,255,255,.03);color:#edf5fb;font-size:.92rem;outline:none}' +
      '#sglGate input:focus{border-color:rgba(71,231,219,.5)}' +
      '#sglGate button{width:100%;min-height:44px;margin-top:12px;border:1px solid #47e7db;border-radius:9px;background:#47e7db;color:#06101b;font-size:.86rem;font-weight:800;cursor:pointer}' +
      '#sglGate button:hover{filter:brightness(1.06)}' +
      '#sglGate .sgl-error{display:none;margin-top:10px;color:#ff6b6b;font-size:.8rem;font-weight:600}' +
      '#sglGate .sgl-error.is-shown{display:block}' +
      '</style>' +
      '<form class="sgl-card" id="sglGateForm">' +
        '<div class="sgl-kicker">Seagull Lab</div>' +
        '<h1>Enter password</h1>' +
        '<input id="sglGateInput" type="password" autocomplete="current-password" placeholder="Password" />' +
        '<button type="submit">Continue</button>' +
        '<div class="sgl-error" id="sglGateError">Wrong password — try again.</div>' +
      '</form>';

    document.body.appendChild(overlay);

    var form = overlay.querySelector('#sglGateForm');
    var input = overlay.querySelector('#sglGateInput');
    var error = overlay.querySelector('#sglGateError');
    input.focus();

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      hashHex(input.value).then(function (hash) {
        if (hash === PASSWORD_HASH) {
          reveal();
        } else {
          error.classList.add('is-shown');
          input.value = '';
          input.focus();
        }
      });
    });
  }

  function init() {
    if (isAuthed()) return;
    buildOverlay();
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
