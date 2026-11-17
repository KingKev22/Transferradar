# Transferradar – Eredivisie transfernieuws

Een website die **elk uur automatisch** het laatste transfernieuws van alle Eredivisie-clubs verzamelt
uit Nederlandse voetbalmedia. Per bericht tonen we alleen titel, bron, tijd, de foto die de
nieuwssite zelf in haar RSS-feed meestuurt, en een link naar het originele artikel.
Zonder foto in de feed toont de site een placeholder in de clubkleuren.

## Hoe werkt het?

```
 elk uur                                                       bezoeker
┌──────────────┐   ┌────────────────────┐   ┌──────────────┐   ┌──────────┐
│GitHub Actions│──>│ fetch_news.py      │──>│ news.json    │──>│ website  │
│ (de wekker)  │   │ feeds ophalen +    │   │ (de data)    │   │ (docs/)  │
└──────────────┘   │ filteren           │   └──────────────┘   └──────────┘
                   └────────────────────┘
```

| Bestand | Wat het is |
|---|---|
| `config.json` | Lijst met RSS-feeds, clubs en transferwoorden. **Hier pas je dingen aan.** |
| `scripts/fetch_news.py` | De bot: haalt feeds op en filtert op club + transferwoord |
| `docs/` | De website (HTML, CSS, JavaScript) |
| `docs/data/news.json` | Het verzamelde nieuws (wordt door de bot gemaakt) |
| `.github/workflows/update.yml` | Zegt tegen GitHub: "draai de bot elk uur en zet de site online" |

## Online zetten (eenmalig, ±15 minuten)

1. **Maak een GitHub-account** op <https://github.com> (gratis).
2. **Maak een nieuwe repository**: rechtsboven **+ → New repository**.
   Naam bijvoorbeeld `transferradar`, zet hem op **Public**, en klik **Create repository**.
3. **Upload de bestanden**: klik op de link *"uploading an existing file"*, en sleep de **inhoud**
   van de map `mijn-site` erin (dus `config.json`, `README.md`, en de mappen `docs`, `scripts`, `.github`).
   Klik **Commit changes**.
   > Tip: de map `.github` is in Windows soms verborgen. Zet in de Verkenner *Beeld → Verborgen items* aan.
   > Lukt het slepen niet, installeer dan **GitHub Desktop** (<https://desktop.github.com>); dat is het makkelijkst.
4. **Zet GitHub Pages aan**: ga in je repository naar **Settings → Pages**.
   Kies bij *Source* voor **GitHub Actions**.
5. **Start de bot de eerste keer**: ga naar het tabblad **Actions**, klik links op
   **Transfernieuws bijwerken** en daarna op **Run workflow**.
   Na ±1 minuut staat er een groen vinkje ✅.
6. **Bekijk je site** op `https://<jouw-gebruikersnaam>.github.io/transferradar/`

Vanaf nu draait de bot vanzelf elk uur. Je hoeft niets meer te doen.

## Dingen aanpassen

Alles staat in **`config.json`**. Je kunt het direct op GitHub bewerken (potloodje ✏️).

- **Nieuwe feed toevoegen**: voeg een regel toe aan `feeds`, bijv.
  `{ "name": "Naam", "url": "https://..." }`
- **Nieuw seizoen** (promotie/degradatie): pas de lijst `clubs` aan.
  - `aliases`: namen waarop gezocht wordt (hoofdlettergevoelig, hele woorden).
  - `exclude`: namen die je juist **niet** wilt meetellen (bijv. *Sparta Praag*).
- **Filter te streng of te ruim?** Pas `transfer_keywords` aan. Woorden van 4 letters of korter
  (zoals `bod`) moeten als heel woord voorkomen; langere woorden mogen een vervolg hebben
  (`transfer` vindt ook *transfergerucht*).

## Goed om te weten

- **Gratis**: GitHub Actions is gratis en onbeperkt voor publieke repositories.
- **Tijd**: GitHub draait geplande taken soms een paar minuten later dan gepland. Dat is normaal.
- **Pauze na 60 dagen**: GitHub zet geplande taken uit als er 60 dagen niets in de repository gebeurt.
  Krijg je daar een e-mail over, klik dan in **Actions** op **Enable workflow**.
- **Een feed werkt niet meer?** Dan staat er in het log van de Action
  `! Naam: overgeslagen`. De andere feeds blijven gewoon werken.
- **Auteursrecht**: we tonen alleen koppen met een link, nooit hele artikelen.
