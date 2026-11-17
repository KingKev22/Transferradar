"""
Eredivisie Transferbot
======================
Wat doet dit script?
  1. Leest config.json (de lijst met RSS-feeds en clubs).
  2. Haalt elke RSS-feed op.
  3. Houdt alleen berichten over die (a) een Eredivisie-club noemen
     en (b) over een transfer lijken te gaan.
  4. Bewaart per bericht ALLEEN: titel, bron, tijd, link en de foto-URL
     die de feed zelf meestuurt (de foto zelf wordt niet gekopieerd).
  5. Schrijft alles naar docs/data/news.json; de website leest dat bestand.

Je kunt dit script lokaal draaien met:  python scripts/fetch_news.py
"""

import hashlib
import html
import json
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from xml.etree import ElementTree as ET
from zoneinfo import ZoneInfo

AMSTERDAM = ZoneInfo("Europe/Amsterdam")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "config.json"
OUTPUT_FILE = ROOT / "docs" / "data" / "news.json"
USER_AGENT = "Mozilla/5.0 (compatible; EredivisieTransferBot/1.0)"


# ---------------------------------------------------------------- hulpjes

def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def download(url):
    """Haal een feed op. Geeft de ruwe bytes terug."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def clean_text(text):
    """Verwijder HTML-tags, entiteiten (&amp;) en dubbele spaties."""
    text = html.unescape(text or "")
    text = re.sub(r"<[^>]+>", "", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_date(value):
    """Zet een datum uit de feed om naar UTC. Werkt voor RSS en Atom."""
    value = (value or "").strip()
    if not value:
        return None
    try:
        dt = parsedate_to_datetime(value)          # RSS: "Tue, 17 Nov 2026 20:25:48 +0100"
    except (TypeError, ValueError):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))  # Atom: 2026-11-17T19:25:48Z
        except ValueError:
            return None
    # ESPN.nl zet "EST" (Amerikaanse tijd) achter wat eigenlijk Nederlandse tijd is.
    # Geen enkele Nederlandse feed gebruikt echt EST, dus lezen we dat als NL-tijd.
    if value.endswith((" EST", " EDT")):
        dt = parsedate_to_datetime(value[:-4] + " +0000").replace(tzinfo=AMSTERDAM)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def local_name(tag):
    """'{http://www.w3.org/2005/Atom}entry' -> 'entry'"""
    return tag.rsplit("}", 1)[-1].lower()


def child_text(elem, *names):
    for child in elem:
        if local_name(child.tag) in names and (child.text or "").strip():
            return child.text
    return ""


def item_link(elem):
    # RSS: <link>https://...</link>   Atom: <link href="https://..." rel="alternate"/>
    for child in elem:
        if local_name(child.tag) == "link":
            href = child.get("href")
            if href and child.get("rel", "alternate") == "alternate":
                return href.strip()
            if (child.text or "").strip():
                return child.text.strip()
    guid = child_text(elem, "guid", "id").strip()
    return guid if guid.startswith("http") else ""


IMAGE_EXT = re.compile(r"\.(jpe?g|png|webp|gif|avif)(\?|$)", re.IGNORECASE)


def item_image(elem):
    """Zoek de foto die de feed zelf meestuurt. Volgorde:
    media:content / media:thumbnail -> enclosure -> <img> in de tekst.
    We zoeken GEEN foto's elders op internet."""
    for child in elem.iter():
        name = local_name(child.tag)
        url = (child.get("url") or "").strip()
        if not url.startswith("https://"):
            continue  # alleen https, anders blokkeert de browser de foto
        kind = (child.get("type") or child.get("medium") or "").lower()
        if name in ("content", "thumbnail") and (not kind or "image" in kind):
            return url
        if name == "enclosure" and ("image" in kind or IMAGE_EXT.search(url)):
            return url
    for field in ("encoded", "description", "summary"):
        found = re.search(r"""<img[^>]+src=["'](https://[^"']+)""", child_text(elem, field))
        if found:
            return html.unescape(found.group(1))
    return ""


def parse_feed(raw):
    """Geef een lijst van (titel, link, datum, foto) uit een RSS- of Atom-feed."""
    root = ET.fromstring(raw)
    result = []
    for elem in root.iter():
        if local_name(elem.tag) not in ("item", "entry"):
            continue
        title = clean_text(child_text(elem, "title"))
        link = item_link(elem)
        date = parse_date(child_text(elem, "pubdate", "published", "updated", "date"))
        if title and link.startswith(("https://", "http://")):
            result.append((title, link, date, item_image(elem)))
    return result


# ---------------------------------------------------------------- filters

def build_club_matchers(clubs):
    """Maak per club een zoekpatroon. Hoofdletters tellen mee, zodat 'AZ' niet
    matcht op 'az' in een gewoon woord, en alleen hele woorden tellen."""
    matchers = []
    for club in clubs:
        names = sorted(club["aliases"], key=len, reverse=True)
        # "(?<![\w-])" zorgt dat "Oud-PSV'er" of "ex-PSV'er" NIET meetelt:
        # dat gaat over een oud-speler, niet over de club zelf.
        pattern = re.compile(r"(?<![\w-])(?:" + "|".join(map(re.escape, names)) + r")(?![\w])")
        matchers.append((club, pattern))
    return matchers


def build_keyword_matcher(keywords):
    """Transferwoorden, zonder hoofdlettergevoeligheid. Korte woorden (zoals 'bod')
    moeten een heel woord zijn; langere mogen een vervolg hebben
    ('transfer' matcht dus ook 'transfergerucht')."""
    parts = []
    for kw in keywords:
        kw_re = r"\s+".join(re.escape(word) for word in kw.lower().split())
        parts.append(kw_re + (r"(?![\w])" if len(kw) <= 4 else ""))
    return re.compile(r"(?<![\w])(?:" + "|".join(parts) + ")", re.IGNORECASE)


def find_clubs(title, matchers):
    found = []
    for club, pattern in matchers:
        text = title
        for bad in club.get("exclude", []):
            text = text.replace(bad, " ")
        if pattern.search(text):
            found.append(club["slug"])
    return found


def make_id(link):
    return hashlib.sha1(link.encode("utf-8")).hexdigest()[:12]


# ---------------------------------------------------------------- hoofdprogramma

def main():
    config = load_json(CONFIG_FILE, None)
    if config is None:
        sys.exit("config.json niet gevonden of ongeldig")

    club_matchers = build_club_matchers(config["clubs"])
    keyword_re = build_keyword_matcher(config["transfer_keywords"])
    now = datetime.now(timezone.utc)

    old = load_json(OUTPUT_FILE, {"items": []})
    items = {item["id"]: item for item in old.get("items", [])}
    old_ids = set(items)

    for feed in config["feeds"]:
        try:
            entries = parse_feed(download(feed["url"]))
        except Exception as exc:  # één kapotte feed mag de rest niet stoppen
            print(f"  ! {feed['name']}: overgeslagen ({exc})")
            continue

        kept = 0
        for title, link, date, image in entries:
            clubs = find_clubs(title, club_matchers)
            if not clubs or not keyword_re.search(title):
                continue
            item_id = make_id(link)
            if item_id in items:
                continue
            items[item_id] = {
                "id": item_id,
                "title": title,
                "source": feed["name"],
                "link": link,
                # Datums in de toekomst (foute feed) of zonder datum -> 'nu'
                "published": min(date or now, now).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "clubs": clubs,
                "image": image,   # leeg = geen foto -> website toont placeholder
            }
            kept += 1
        print(f"  - {feed['name']}: {len(entries)} berichten, {kept} nieuwe transferberichten")

    # Zelfde titel bij dezelfde bron (bv. link met andere tracking-code)? Eén houden.
    seen, unique = set(), []
    for item in sorted(items.values(), key=lambda i: i["published"], reverse=True):
        key = (item["source"], item["title"].lower())
        if key not in seen:
            seen.add(key)
            unique.append(item)

    # Oude berichten opruimen
    cutoff = (now - timedelta(days=config.get("keep_days", 30))).strftime("%Y-%m-%dT%H:%M:%SZ")
    unique = [i for i in unique if i["published"] >= cutoff][: config.get("max_items", 600)]

    # Alleen opslaan als er echt iets veranderd is (scheelt onnodige commits)
    if {i["id"] for i in unique} == old_ids and old.get("clubs"):
        print("Geen wijzigingen.")
        return

    output = {
        "updated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "clubs": [{"slug": c["slug"], "name": c["name"], "color": c["color"]} for c in config["clubs"]],
        "items": unique,
    }
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Opgeslagen: {len(unique)} berichten in {OUTPUT_FILE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
