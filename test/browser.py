#!/usr/bin/env python3
"""Drive the local site in headless Chrome and assert the real flows work."""
import json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
from cdp import Chrome

BASE = os.environ.get("BASE", "http://localhost:8788")
fails = []

def check(name, ok, detail=""):
    print(("pass  " if ok else "FAIL  ") + name + (("   " + str(detail)[:180]) if detail else ""))
    if not ok:
        fails.append(name)

with Chrome(headless=True) as c:
    c.goto(BASE, wait_text="Keepalive")
    time.sleep(3)
    txt = (c.text() or "")
    low = txt.lower()
    check("hero renders", "ran out of months" in low, txt[:80])
    check("stats filled from meta.json", "579,178" in txt, [l for l in txt.split("\n") if "579" in l][:2])
    check("finding tables rendered", "decile 10" in low and "under 5 cents" in low)
    check("gift results auto-ran", "days of runway" in low)

    n = c.js("document.querySelectorAll('#giftresults .card').length")
    check("gift cards present", n and n >= 10, f"{n} cards")

    # pre-rendered narration: four languages, all real files, no key needed
    clips = c.js("[...document.querySelectorAll('.lang')].map(b=>b.dataset.clip)")
    check("four narration languages offered", clips == ["tour.en", "tour.hi", "tour.ta", "tour.es"], clips)
    probe = c.js("""(async () => {
      const out = [];
      for (const n of ['tour.en','tour.hi','tour.ta','tour.es','finding.en','gift.en']) {
        const r = await fetch('/audio/' + n + '.mp3', {method:'HEAD'});
        out.push([n, r.status, r.headers.get('content-type')]);
      }
      return out; })()""", await_promise=True)
    check("every pre-rendered clip serves as audio",
          bool(probe) and all(p[1] == 200 and 'audio' in (p[2] or '') for p in probe), probe)
    c.js('[...document.querySelectorAll(".lang")].find(b => b.dataset.clip === "tour.ta").click()')
    time.sleep(1)
    src = c.js("document.querySelector('#tourplayer').getAttribute('src')")
    check("language switch changes the clip", src and src.endswith("tour.ta.mp3"), src)

    # search
    c.js("""(() => { const i = document.querySelector('#q');
        i.value = 'chicago food depository';
        i.dispatchEvent(new Event('input')); })()""")
    time.sleep(4)
    sug = c.js("[...document.querySelectorAll('#suggest button')].map(b=>b.innerText).slice(0,3)")
    check("search returns suggestions", bool(sug) and len(sug) > 0, sug)
    check("search result names a real org", any("depository" in s.lower() for s in (sug or [])), sug)

    # open an org page
    c.js("document.querySelector('#suggest button[data-ein]').click()")
    time.sleep(3)
    otxt = (c.text() or "").lower()
    check("org page opens", "months of runway" in otxt)
    check("org page shows EIN", "ein " in otxt)
    check("org page shows peer survival", "still filing" in otxt)
    check("chart drawn", bool(c.js("document.querySelectorAll('#orgview svg.chart path').length >= 3")))

    # the Gemini brief
    for _ in range(40):
        if not (c.js("document.querySelector('#brief')?.classList.contains('loading')")):
            break
        time.sleep(1.5)
    brief = c.js("document.querySelector('#brief')?.innerText || ''")
    check("brief written by Gemini", len(brief) > 220 and "Reading the filings" not in brief, brief[:120])
    check("brief carries the cannot-know line", "cannot tell you" in brief.lower(), brief[-140:])
    check("brief has no em dash", "—" not in brief)

    # the Solana receipt
    c.js("document.querySelector('#attest')?.click()")
    ok = False
    for _ in range(45):
        out = c.js("document.querySelector('#attestout')?.innerText || ''")
        if "solana.fm" in out or "sha256" in out or "not published" in out:
            ok = True
            break
        time.sleep(1.5)
    out = c.js("document.querySelector('#attestout')?.innerText || ''")
    check("receipt published to devnet", "sha256" in out and "not published" not in out, out[:200])
    href = c.js("document.querySelector('#attestout a')?.href || ''")
    check("receipt links an explorer", "solana.fm" in href, href)

    # ElevenLabs on the live brief
    c.js("document.querySelector('#speak')?.click()")
    aud = ""
    for _ in range(50):
        aud = c.js("document.querySelector('#audio')?.innerText || ''")
        if c.js("Boolean(document.querySelector('#audio audio'))") or "No audio" in aud:
            break
        time.sleep(1.5)
    has = c.js("Boolean(document.querySelector('#audio audio'))")
    check("brief is spoken by ElevenLabs", bool(has), aud[:160])
    check("audio credits ElevenLabs on the page", "ElevenLabs" in (c.text() or ""))
    c.shot(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "shots", "org.png"))

print()
print(f"{len(fails)} failed" if fails else "all browser checks passed")
sys.exit(1 if fails else 0)
