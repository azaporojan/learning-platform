#!/usr/bin/env python3
"""Turn a deck HTML (same markup as for build_deck.mjs) into ONE self-contained HTML file that
renders in any browser and prints to a 16:9 PDF. For environments without Node/Chromium
(e.g. Claude in the browser): no dependencies, Python 3 only.

    python3 standalone_deck.py deck.html [out.html]

The output inlines the course theme and loads fonts (Google Fonts), icons (Lucide) and diagrams
(Mermaid) from pinned CDN versions, so the viewer needs internet. To get the PDF: open the file in
Chrome or Edge → Print → Destination "Save as PDF", Margins "None", "Background graphics" on.
The on-screen banner with these steps is not printed.
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
THEME = (HERE.parent / "assets" / "deck-theme.css").read_text(encoding="utf-8")

HEAD = """
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
%s
/* standalone extras */
@media screen {
  body { display: flex; flex-direction: column; align-items: center; gap: 24px; padding: 24px 0 48px; }
  .print-help { position: sticky; top: 0; z-index: 10; background: #1f2933; color: #fff; font: 15px/1.4 Inter, sans-serif;
    padding: 10px 18px; border-radius: 10px; box-shadow: 0 4px 16px #0004; }
  .print-help b { color: #fbbf24; }
}
@media print { .print-help { display: none !important; } }
</style>
<script src="https://cdn.jsdelivr.net/npm/lucide@0.460.0/dist/umd/lucide.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<script>
// Configure Mermaid now, before the load event: otherwise its own startOnLoad pass renders first with defaults.
try {
    mermaid.initialize({ startOnLoad: false, theme: 'base', securityLevel: 'loose',
      flowchart: { htmlLabels: true, curve: 'basis', padding: 14 },
      themeVariables: { fontFamily: 'Inter, sans-serif', fontSize: '18px', primaryColor: '#e6f2f0',
        primaryBorderColor: '#0f766e', primaryTextColor: '#1f2933', lineColor: '#52606d',
        secondaryColor: '#ffffff', tertiaryColor: '#fafaf7', clusterBkg: '#ffffff', clusterBorder: '#d9dee3',
        noteBkgColor: '#fdf3e2', noteBorderColor: '#d97706', actorBkg: '#e6f2f0', actorBorder: '#0f766e' } });
} catch (e) { console.error('mermaid', e); }
window.addEventListener('load', async () => {
  try { lucide.createIcons({ attrs: { class: 'lucide' } }); } catch (e) { console.error('icons', e); }
  try { await mermaid.run(); } catch (e) { console.error('mermaid', e && (e.message || e.str) || e); }
  const slides = [...document.querySelectorAll('section.slide')];
  const footer = document.body.dataset.footer || '';
  slides.forEach((s, i) => {
    if (s.hasAttribute('data-no-footer')) return;
    const f = document.createElement('div'); f.className = 'footer';
    f.innerHTML = '<span></span><span>' + (i + 1) + ' / ' + slides.length + '</span>';
    f.firstChild.textContent = footer; s.appendChild(f);
  });
});
</script>
"""

BANNER = ('<div class="print-help">To save as PDF: <b>Ctrl/Cmd + P</b> → Save as PDF · Margins: <b>None</b> · '
          '<b>Background graphics</b> on</div>')


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    src = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_name(src.stem + ".standalone.html")
    html = src.read_text(encoding="utf-8")
    # <i data-icon="bug"></i> (build_deck syntax) → <i data-lucide="bug"></i> (Lucide's browser script)
    html = re.sub(r'<i(\s+)data-icon="', r'<i\1data-lucide="', html)
    head = HEAD % THEME
    html = html.replace("</head>", head + "\n</head>", 1) if "</head>" in html else head + html
    html = re.sub(r"(<body[^>]*>)", r"\1\n" + BANNER, html, count=1)
    # The banner must not count as a page: print CSS already hides everything that is not a slide.
    out.write_text(html, encoding="utf-8")
    count = len(re.findall(r'<section[^>]*class="[^"]*\bslide\b', html))
    print(f"Standalone deck: {out}  ({count} slides)")


if __name__ == "__main__":
    main()
