"""The small pages the email links open: a title, one line, and a button or a link back to the site."""

from __future__ import annotations

from html import escape

from .texts import HTML_LANG, lang_or_default, site_url, text

STYLE = """
:root{--bg:#f6f6f4;--card:#fff;--fg:#1a1a1a;--muted:#5f5f5f;--line:#e2e2de;--btn:#2563eb;--btn-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#111;--card:#1b1b1b;--fg:#f2f2f2;--muted:#a3a3a3;--line:#2c2c2c;--btn:#3b82f6}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--fg);
font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Hiragino Sans","Noto Sans",sans-serif}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px 28px;text-align:center}
.brand{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 16px}
h1{font-size:22px;line-height:1.3;margin:0 0 8px}
p{margin:0;color:var(--muted)}
form{margin-top:24px}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:12px 22px;background:var(--btn);color:var(--btn-fg);cursor:pointer}
button:focus-visible,a:focus-visible{outline:2px solid var(--btn);outline-offset:3px}
a{color:inherit}
.back{display:inline-block;margin-top:24px;font-size:14px;color:var(--muted)}
"""


def page(lang: str, title_key: str, line_key: str, button: tuple[str, str, str] | None = None) -> str:
    """button: (form action, hidden token, label key)."""
    lang = lang_or_default(lang)
    title = escape(text(lang, title_key))
    form = ""
    if button:
        action, token, label = button
        form = (f'<form method="post" action="{escape(action)}"><input type="hidden" name="t" value="{escape(token)}">'
                f'<button type="submit">{escape(text(lang, label))}</button></form>')
    return (f'<!doctype html><html lang="{HTML_LANG[lang]}"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">'
            f'<title>{title} · Four Games</title><style>{STYLE}</style></head><body><main>'
            f'<p class="brand">Four Games</p><h1>{title}</h1><p>{escape(text(lang, line_key))}</p>{form}'
            f'<a class="back" href="{site_url(lang)}">{escape(text(lang, "back"))}</a></main></body></html>')
