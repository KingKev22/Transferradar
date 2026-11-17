"""
Spelersherkenning + vrije spelersfoto's
=======================================
1. Zoek mogelijke namen in een kop ("PSV doet bod op Kevin De Bruyne").
2. Controleer via Wikidata of het echt een voetballer of voetbaltrainer is.
3. Haal zijn foto (eigenschap P18) op van Wikimedia Commons, alleen met een
   vrije licentie, inclusief maker en licentie (verplicht bij Wikimedia).
4. Onthoud alles in data/players.json, zodat elke naam maar één keer wordt
   opgezocht. Zo blijven we vriendelijk voor de servers van Wikipedia.
"""

import json
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

WIKIDATA_API = "https://www.wikidata.org/w/api.php"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"

HUMAN = "Q5"
FOOTBALL_JOBS = {"Q937857", "Q628099"}      # voetballer, voetbaltrainer
CLUB_PROPS = ("P54", "P6087")               # speelde voor / trainer van
MIN_PHOTO_WIDTH = 400                       # kleinere foto's worden wazig

# Alleen vrije licenties; niets met NC (niet-commercieel) of ND (geen bewerkingen)
FREE_LICENSE = re.compile(r"^\s*(cc[\s-]?by(-sa)?\b|cc0|public domain|pd\b|attribution)", re.IGNORECASE)
NON_FREE = re.compile(r"\b(nc|nd)\b|non-?commercial|fair use", re.IGNORECASE)

# Tussenvoegsels die in namen voorkomen: "Robin van Persie", "John van 't Schip"
PARTICLES = {"van", "de", "der", "den", "het", "'t", "ten", "ter", "te", "el", "al",
             "da", "dos", "di", "du", "le", "la", "von", "bin", "ben", "del", "della", "dello"}

# Woorden die vaak met een hoofdletter in een kop staan maar geen naam zijn
COMMON_CAPS = {"de", "het", "een", "dit", "deze", "die", "dat", "na", "bij", "met", "voor", "om", "op",
               "in", "uit", "wie", "wat", "waarom", "hoe", "zo", "ook", "nog", "geen", "nieuwe",
               "oud", "ex", "officieel", "update", "live", "video", "column", "analyse", "gerucht",
               "breaking", "exclusief", "transfernieuws", "transfers", "trainer", "speler", "spits",
               "verdediger", "middenvelder", "keeper", "doelman", "aanvaller", "directeur", "coach",
               "fans", "supporters", "club", "clubs", "jong", "vrouwen", "mannen"}


class RateLimited(Exception):
    """Wikimedia vraagt ons even te wachten (of ons budget voor deze run is op)."""


def normalize(text):
    """'Boëtius' -> 'boetius', voor eerlijk vergelijken van namen."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9 ]", "", text.lower().replace("-", " ")).strip()


def is_capitalized(word):
    return word[:1].isupper()


class PlayerFinder:
    def __init__(self, cache_path, settings, clubs, not_a_player):
        self.cache_path = cache_path
        try:
            self.cache = json.loads(cache_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            self.cache = {}

        self.budget = int(settings.get("max_requests_per_run", 60))
        self.retry_after = timedelta(days=int(settings.get("retry_after_days", 14)))
        contact = settings.get("contact") or "https://github.com"
        # Wikimedia wil dat bots zich netjes voorstellen
        self.user_agent = f"TransferRadarBot/1.0 ({contact}) python-urllib"
        self.requests = 0
        self.stopped = False

        self.club_qids = {c["slug"]: c.get("wikidata") for c in clubs}
        ignore = set(not_a_player)
        for club in clubs:
            ignore.add(club["name"])
            ignore.update(club["aliases"])
        self.ignore = {normalize(w) for w in ignore}

    # ------------------------------------------------------------ API-verzoeken

    def _get(self, url, params):
        if self.stopped or self.requests >= self.budget:
            raise RateLimited()
        if self.requests:
            time.sleep(1.0)  # max. 1 verzoek per seconde
        self.requests += 1
        query = urllib.parse.urlencode({**params, "format": "json", "maxlag": "5"})
        req = urllib.request.Request(f"{url}?{query}", headers={"User-Agent": self.user_agent})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.load(resp)
        except urllib.error.HTTPError as exc:
            if exc.code in (429, 503):
                self.stopped = True
                raise RateLimited() from exc
            raise
        if "error" in data:
            if data["error"].get("code") == "maxlag":
                self.stopped = True
                raise RateLimited()
            raise RuntimeError(data["error"].get("info", "onbekende fout"))
        return data

    # ------------------------------------------------------------ namen in een kop

    def candidates(self, title):
        """Geef mogelijke namen terug, langste (meest specifieke) eerst."""
        text = re.sub(r"(?<!\w)[‘’']t\b", " _t_ ", title)            # van 't Schip
        # Leestekens en losse aanhalingstekens onderbreken een naam; een apostrof
        # midden in een woord (N'Diaye) blijft staan.
        text = re.sub(r"[:;,.!?()\[\]\"“”«»|–—…]|(?<!\w)['‘’]|['‘’](?!\w)", " | ", text)
        words = []
        for token in text.split():
            if token == "_t_":
                words.append("'t")
                continue
            if re.search(r"['‘’]ers?$", token):   # "PSV'er" is geen naam
                words.append("|")
                continue
            parts = token.split("-")
            if len(parts) > 1 and not all(is_capitalized(p) for p in parts if p):
                # "PSV-target" -> "PSV" + breekpunt; "Jean-Paul" blijft heel
                for p in parts:
                    if p:
                        words += [p, "|"]
            else:
                words.append(token)

        found, current = [], []

        def flush():
            while current and current[-1].lower() in PARTICLES:
                current.pop()
            while current and current[0].lower() in COMMON_CAPS and len(current) > 1 \
                    and current[0].lower() not in PARTICLES:
                current.pop(0)
            if current:
                found.append(" ".join(current))
            current.clear()

        for word in words + ["|"]:
            if word == "|" or re.search(r"\d", word):
                flush()
            elif is_capitalized(word) or (current and word.lower() in PARTICLES):
                current.append(word)
            else:
                flush()

        result = []
        for name in found:
            key = normalize(name)
            if not key or key in self.ignore or key in COMMON_CAPS or len(key) < 3:
                continue
            if len(name.split()) == 1 and name.isupper():
                continue  # "DEBRUYNE" of "VAR": afkorting/nadruk, geen naam
            # Haal clubnamen uit een reeks ("Ajax Kenneth Taylor" -> "Kenneth Taylor")
            tokens = [t for t in name.split() if normalize(t) not in self.ignore]
            name = " ".join(tokens)
            if name and normalize(name) not in COMMON_CAPS and name not in result:
                result.append(name)
        result.sort(key=lambda n: -len(n.split()))
        return result[:4]

    @staticmethod
    def surname_only(name):
        """'De Bruyne' of 'Cillessen' = alleen achternaam; 'Kevin De Bruyne' niet."""
        tokens = name.split()
        return all(t.lower() in PARTICLES for t in tokens[:-1])

    # ------------------------------------------------------------ Wikidata

    def _lookup(self, name, club_qids):
        search = self._get(WIKIDATA_API, {
            "action": "wbsearchentities", "search": name, "language": "nl",
            "uselang": "nl", "type": "item", "limit": "7",
        })
        ids = [hit["id"] for hit in search.get("search", [])]
        if not ids:
            return None
        data = self._get(WIKIDATA_API, {
            "action": "wbgetentities", "ids": "|".join(ids),
            "props": "claims|labels", "languages": "nl|en",
        })

        target = normalize(name)
        surname = normalize(name.split()[-1])
        matches = []
        for qid in ids:
            entity = data.get("entities", {}).get(qid, {})
            claims = entity.get("claims", {})
            if HUMAN not in self._values(claims, "P31"):
                continue
            if not FOOTBALL_JOBS & self._values(claims, "P106"):
                continue
            labels = entity.get("labels", {})
            label = (labels.get("nl") or labels.get("en") or {}).get("value", "")
            if not label:
                continue
            norm_label = normalize(label)
            if self.surname_only(name):
                ok = norm_label.endswith(" " + surname) or norm_label == surname
            else:
                ok = norm_label == target or set(target.split()) <= set(norm_label.split())
            if ok:
                clubs = set().union(*(self._values(claims, p) for p in CLUB_PROPS))
                images = [v for v in self._values(claims, "P18", raw=True) if isinstance(v, str)]
                matches.append({"qid": qid, "name": label, "club_match": bool(clubs & club_qids),
                                "image": images[0] if images else None})

        if not matches:
            return None
        with_club = [m for m in matches if m["club_match"]]
        if with_club:
            return with_club[0]
        if not self.surname_only(name):
            return matches[0]                # volledige naam: beste zoekresultaat
        if len(matches) == 1:
            return matches[0]                # achternaam: alleen als er maar één voetballer is
        return None                          # twijfel -> liever geen (verkeerde) foto

    @staticmethod
    def _values(claims, prop, raw=False):
        out = [] if raw else set()
        for claim in claims.get(prop, []):
            value = claim.get("mainsnak", {}).get("datavalue", {}).get("value")
            if raw:
                out.append(value)
            elif isinstance(value, dict) and "id" in value:
                out.add(value["id"])
        return out

    # ------------------------------------------------------------ Commons-foto

    @staticmethod
    def _thumb(original, width, px):
        """Bouw een thumbnail-URL in een standaardmaat van Wikimedia. Originelen
        rechtstreeks laden wordt door Wikimedia afgeknepen; thumbnails niet."""
        if width <= px or not re.search(r"\.(jpe?g|png|webp)$", original, re.IGNORECASE):
            return None
        name = original.rsplit("/", 1)[1]
        return original.replace("/commons/", "/commons/thumb/", 1) + f"/{px}px-{name}"

    def _photo(self, filename):
        data = self._get(COMMONS_API, {
            "action": "query", "prop": "imageinfo", "titles": f"File:{filename}",
            "iiprop": "url|size|extmetadata", "iiurlwidth": "960",
            "iiextmetadatafilter": "Artist|LicenseShortName|LicenseUrl",
        })
        pages = data.get("query", {}).get("pages", {})
        info = next(iter(pages.values()), {}).get("imageinfo", [{}])[0]
        meta = info.get("extmetadata", {})
        license_name = meta.get("LicenseShortName", {}).get("value", "").strip()
        if not FREE_LICENSE.search(license_name) or NON_FREE.search(license_name):
            return None
        artist = re.sub(r"<[^>]+>", "", meta.get("Artist", {}).get("value", ""))
        artist = re.sub(r"\s+", " ", artist).strip() or "Onbekende maker"
        original = (info.get("url") or "").split("?")[0]
        width = int(info.get("width") or 0)
        if not original.startswith("https://") or width < MIN_PHOTO_WIDTH:
            return None  # te klein -> wazig; dan liever het silhouet
        api_thumb = (info.get("thumburl") or "").split("?")[0]
        small = self._thumb(original, width, 500) or original
        large = (api_thumb if width > 960 and "/thumb/" in api_thumb else None) or small
        return {
            "src": large,          # hero (960 px)
            "src_small": small,    # kaarten (500 px)
            "page": info.get("descriptionurl", ""),
            "artist": artist[:80],
            "license": license_name,
            "license_url": meta.get("LicenseUrl", {}).get("value", ""),
        }

    # ------------------------------------------------------------ hoofdfunctie

    def find(self, title, club_slugs):
        """Geef {'name','qid','photo'} terug, of None als er geen speler is.
        Gooit RateLimited als we moeten stoppen (dan later opnieuw proberen)."""
        club_qids = {self.club_qids.get(s) for s in club_slugs} - {None}
        fallback = None
        for name in self.candidates(title):
            key = normalize(name)
            if self.surname_only(name):
                key += "|" + ",".join(sorted(club_slugs))   # antwoord hangt af van de club
            entry = self.cache.get(key)
            fresh = entry and (entry.get("player") or
                               datetime.now(timezone.utc) - datetime.fromisoformat(entry["checked"]) < self.retry_after)
            if not fresh:
                player = self._lookup(name, club_qids)
                if player:
                    photo = self._photo(player["image"]) if player.get("image") else None
                    player = {"name": player["name"], "qid": player["qid"], "photo": photo}
                entry = {"checked": datetime.now(timezone.utc).isoformat(timespec="seconds"), "player": player}
                self.cache[key] = entry
            player = entry.get("player")
            if player and player.get("photo"):
                return player
            fallback = fallback or player
        return fallback

    def from_known(self, title):
        """Zonder internet: staat er alleen een achternaam ('coach Buijs') en
        kennen we precies één speler met die achternaam uit eerder nieuws?
        Dan is het vrijwel zeker diezelfde persoon."""
        known = {}
        for entry in self.cache.values():
            player = entry.get("player")
            if player:
                known[player["qid"]] = player
        for name in self.candidates(title):
            if not self.surname_only(name):
                continue
            surname = normalize(name.split()[-1])
            hits = [p for p in known.values()
                    if normalize(p["name"]).endswith(" " + surname)]
            if len(hits) == 1:
                return hits[0]
        return None

    def save(self):
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self.cache_path.write_text(json.dumps(self.cache, ensure_ascii=False, indent=1, sort_keys=True),
                                   encoding="utf-8")
