// TransferRadar – laadt docs/data/news.json en toont de berichten.
(() => {
  "use strict";

  const PAGE_SIZE = 30;
  const NEW_MS = 60 * 60 * 1000;          // "NIEUW"-label: afgelopen uur
  const BREAKING_MS = 3 * 60 * 60 * 1000; // grote kaart heet "BREAKING" als hij < 3 uur oud is
  const SIDE_COUNT = 4;                   // aantal berichten in "Net binnen"
  const TICKER_COUNT = 10;                // aantal koppen in de ticker

  // Afkortingen voor de ronde clubbadges
  const SHORT = {
    ajax: "AJA", psv: "PSV", feyenoord: "FEY", az: "AZ", twente: "TWE", utrecht: "UTR",
    nec: "NEC", heerenveen: "HEE", groningen: "GRO", sparta: "SPA", fortuna: "FOR",
    gae: "GAE", pec: "PEC", excelsior: "EXC", telstar: "TEL", willem2: "WII",
    ado: "ADO", cambuur: "CAM",
  };

  const $ = id => document.getElementById(id);
  const els = {
    clock: $("clock"), ticker: $("ticker"), track: $("ticker-track"), updated: $("updated"),
    clubs: $("clubs"), feed: $("feed"), search: $("search"), stats: $("stats"),
  };
  const state = { data: null, club: "", query: "", shown: PAGE_SIZE, total: 0, clubMap: {} };

  // ---------- Datum en tijd in het Nederlands ----------
  const fmt = opts => new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", ...opts });
  const longDayFmt = fmt({ weekday: "long", day: "numeric", month: "long" });
  const shortDayFmt = fmt({ weekday: "short", day: "numeric", month: "short" });
  const hmFmt = fmt({ hour: "2-digit", minute: "2-digit" });
  const fullFmt = fmt({ dateStyle: "full", timeStyle: "short" });
  const dayKeyFmt = fmt({ year: "numeric", month: "2-digit", day: "2-digit" });

  function ago(date) {
    const min = Math.floor((Date.now() - date) / 60000);
    if (min < 1) return "zojuist";
    if (min < 60) return `${min} min geleden`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} uur geleden`;
    const d = Math.floor(h / 24);
    return d === 1 ? "1 dag geleden" : `${d} dagen geleden`;
  }

  function dayLabel(date) {
    const key = d => dayKeyFmt.format(d);
    if (key(date) === key(new Date())) return "Vandaag";
    if (key(date) === key(new Date(Date.now() - 86400000))) return "Gisteren";
    return longDayFmt.format(date);
  }

  // ---------- Kleuren: donkere of lichte tekst op een clubkleur? ----------
  function inkFor(hex) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || "");
    if (!m) return "#fff";
    const [r, g, b] = m.slice(1).map(x => {
      const c = parseInt(x, 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? "#0b0e16" : "#fff";
  }

  const shortName = club => SHORT[club.slug] ||
    club.name.replace(/^(fc|sc|sv|afc)\s+/i, "").slice(0, 3).toUpperCase();
  const sourceInitials = name =>
    name.replace(/^de\s+/i, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
  const safeUrl = url => /^https?:\/\//i.test(url || "") ? url : "#";

  // ---------- Kleine helper om veilig HTML-elementen te maken ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "style") for (const [p, val] of Object.entries(v)) node.style.setProperty(p, val);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c != null) node.append(c); // tekst wordt veilig ge-escaped
    return node;
  }

  function svg(viewBox, inner) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", viewBox);
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = inner; // vaste, eigen SVG-code (geen data uit feeds)
    return s;
  }

  const clubsOf = item => item.clubs.map(s => state.clubMap[s]).filter(Boolean);

  const badge = club => el("span", {
    class: "badge", style: { "--club": club.color, "--badge-ink": inkFor(club.color) },
  }, shortName(club));

  // ---------- Foto (uit de feed) of placeholder in clubkleuren ----------
  function placeholder(clubs) {
    const c1 = clubs[0] ? clubs[0].color : "#ff5a1f";
    const c2 = clubs[1] ? clubs[1].color : "#07090f";
    return el("div", { class: "ph", style: { "--c1": c1, "--c2": c2, "--ph-ink": inkFor(c1) }, "aria-hidden": "true" },
      clubs[0] ? badge(clubs[0]) : null,
      el("span", { class: "ph-name" }, clubs.map(c => c.name).join(" · ") || "Eredivisie"));
  }

  function media(item, eager) {
    const clubs = clubsOf(item);
    // De placeholder ligt altijd onderop; een foto vervaagt eroverheen zodra hij geladen is.
    const box = el("div", { class: "media" }, placeholder(clubs));
    if (/^https:\/\//i.test(item.image || "")) {
      const img = el("img", {
        src: item.image, alt: "", class: "loading",
        loading: eager ? "eager" : "lazy", decoding: "async", referrerpolicy: "no-referrer",
      });
      img.addEventListener("load", () => img.classList.remove("loading"));
      img.addEventListener("error", () => img.remove()); // kapotte foto -> placeholder blijft zichtbaar
      box.append(img);
    }
    return box;
  }

  const timeEl = item => el("time", {
    class: "ago", datetime: item.published, "data-ago": "", title: fullFmt.format(new Date(item.published)),
  }, ago(new Date(item.published)));

  const foot = (item, extra) => el("div", { class: "foot" },
    el("span", { class: "src-logo", "aria-hidden": "true" }, sourceInitials(item.source)),
    el("span", { class: "src" }, item.source),
    el("span", { class: "dot-sep" }, "·"),
    timeEl(item),
    extra);

  const titleLink = item => el("a", {
    class: "stretch", href: safeUrl(item.link), target: "_blank", rel: "noopener noreferrer",
  }, item.title);

  const isNew = item => Date.now() - new Date(item.published).getTime() < NEW_MS;

  // ---------- Live klok in de header ----------
  function tickClock() {
    const now = new Date();
    const hm = hmFmt.format(now);
    if (els.clock.dataset.hm === hm) return; // alleen bijwerken als de minuut verandert
    els.clock.dataset.hm = hm;
    els.clock.setAttribute("datetime", now.toISOString());
    els.clock.replaceChildren(
      el("span", { class: "day-part" },
        el("span", { class: "long" }, longDayFmt.format(now)),
        el("span", { class: "short" }, shortDayFmt.format(now).replace(/\./g, "")),
        " ", el("span", { class: "sep" }, "·"), " "),
      el("span", { class: "hm" }, hm));
  }

  // ---------- Nieuwsticker ----------
  function renderTicker() {
    const items = state.data.items.slice(0, TICKER_COUNT);
    els.ticker.hidden = !items.length;
    if (!items.length) return;

    const build = hidden => items.map(item => {
      const club = clubsOf(item)[0];
      return el("a", {
        class: "tick", href: safeUrl(item.link), target: "_blank", rel: "noopener noreferrer",
        tabindex: hidden ? "-1" : null, "aria-hidden": hidden ? "true" : null,
      },
        el("time", { datetime: item.published }, hmFmt.format(new Date(item.published))),
        club ? el("span", { class: "tick-club" }, club.name) : null,
        el("span", { class: "tick-title" }, item.title));
    });
    // Twee keer dezelfde rij achter elkaar -> naadloos rondlopen
    els.track.replaceChildren(...build(false), ...build(true));
    requestAnimationFrame(() => {
      const px = els.track.scrollWidth / 2;
      els.track.style.setProperty("--dur", `${Math.max(30, px / 70)}s`); // ±70 pixels per seconde
    });
  }

  // ---------- Filter via de URL (#ajax), zodat je een link kunt delen ----------
  function readHash() {
    const slug = decodeURIComponent(location.hash.slice(1));
    state.club = state.data && state.clubMap[slug] ? slug : "";
  }

  function setClub(slug) {
    history.replaceState(null, "", slug ? `#${slug}` : location.pathname + location.search);
    state.club = slug;
    state.shown = PAGE_SIZE;
    render(true);
  }

  // ---------- Tekenen ----------
  function renderStats() {
    const now = Date.now(), todayKey = dayKeyFmt.format(new Date());
    let hour = 0, day = 0;
    const active = new Set();
    for (const i of state.data.items) {
      const d = new Date(i.published);
      if (now - d < NEW_MS) hour++;
      if (dayKeyFmt.format(d) === todayKey) { day++; i.clubs.forEach(c => active.add(c)); }
    }
    const set = (k, v) => { els.stats.querySelector(`[data-stat="${k}"]`).textContent = v; };
    set("hour", hour); set("today", day); set("clubs", active.size);
  }

  function renderUpdated() {
    if (!state.data) return;
    const d = new Date(state.data.updated);
    els.updated.textContent = `Laatste update ${ago(d)} · elk uur nieuw nieuws`;
    els.updated.title = fullFmt.format(d);
  }

  function renderClubs(counts) {
    const scroll = els.clubs.scrollLeft;
    els.clubs.replaceChildren();

    const all = el("button", { class: "chip all", type: "button", "aria-pressed": String(!state.club) },
      "Alle clubs", el("span", { class: "count" }, String(state.total)));
    all.addEventListener("click", () => setClub(""));
    els.clubs.append(all);

    const clubs = [...state.data.clubs].sort((a, b) =>
      (counts[b.slug] || 0) - (counts[a.slug] || 0) || a.name.localeCompare(b.name, "nl"));
    for (const club of clubs) {
      const n = counts[club.slug] || 0;
      const active = state.club === club.slug;
      const btn = el("button", {
        class: "chip", type: "button", "aria-pressed": String(active),
        style: { "--club": club.color, "--chip-ink": inkFor(club.color) },
      }, badge(club), club.name, el("span", { class: "count" }, String(n)));
      if (!n && !active) btn.disabled = true;
      btn.addEventListener("click", () => setClub(active ? "" : club.slug));
      els.clubs.append(btn);
    }
    els.clubs.scrollLeft = scroll;
  }

  function renderLead(item) {
    const clubs = clubsOf(item);
    const fresh = Date.now() - new Date(item.published).getTime() < BREAKING_MS;
    return el("article", { class: "lead", style: { "--club": clubs[0] ? clubs[0].color : "var(--accent)", "--i": "0" } },
      media(item, true),
      el("div", { class: "lead-top" },
        el("span", { class: fresh ? "flag" : "flag calm" }, fresh ? "BREAKING" : "TOPVERHAAL")),
      el("div", { class: "lead-body" },
        el("div", { class: "clubs-row" }, ...clubs.map(c => el("span", { class: "club-tag" }, badge(c), c.name))),
        el("h2", {}, titleLink(item)),
        foot(item)));
  }

  function renderSide(items) {
    const box = el("aside", { class: "side", "aria-label": "Net binnen" }, el("h2", { class: "side-title" }, "Net binnen"));
    items.forEach((item, i) => box.append(
      el("article", { class: "row", style: { "--i": String(i + 1) } },
        media(item, true),
        el("div", {},
          el("h3", {}, titleLink(item)),
          el("div", { class: "foot" },
            el("span", { class: "src" }, item.source),
            el("span", { class: "dot-sep" }, "·"),
            timeEl(item),
            isNew(item) ? el("span", { class: "new" }, "NIEUW") : null)))));
    return box;
  }

  function renderCard(item, index) {
    const clubs = clubsOf(item);
    return el("li", { class: "card", style: { "--club": clubs[0] ? clubs[0].color : "var(--accent)", "--i": String(index) } },
      media(item, false),
      isNew(item) ? el("span", { class: "new" }, "NIEUW") : null,
      el("div", { class: "card-body" },
        el("div", { class: "card-tags" }, ...clubs.map(c => el("span", { class: "club-tag" }, badge(c), c.name))),
        el("h2", {}, titleLink(item)),
        foot(item, el("span", { class: "go", "aria-hidden": "true" }, svg("0 0 24 24", '<path d="M5 12h14M13 6l6 6-6 6"/>')))));
  }

  function emptyState(q) {
    const box = el("div", { class: "empty" },
      el("span", { class: "icon", "aria-hidden": "true" }, "📡"),
      el("strong", {}, "Geen transfernieuws gevonden"),
      el("span", {}, q ? "Probeer een andere zoekterm." : "Er is (nog) geen nieuws voor deze selectie. Kom later terug!"));
    if (q || state.club) {
      const reset = el("button", { type: "button" }, "Toon al het nieuws");
      reset.addEventListener("click", () => { els.search.value = ""; state.query = ""; setClub(""); });
      box.append(reset);
    }
    return box;
  }

  function render(animate) {
    const q = state.query.trim().toLowerCase();
    const bySearch = state.data.items.filter(i =>
      !q || i.title.toLowerCase().includes(q) || i.source.toLowerCase().includes(q));

    const counts = {};
    for (const i of bySearch) for (const s of i.clubs) counts[s] = (counts[s] || 0) + 1;
    state.total = bySearch.length;
    renderClubs(counts);

    const items = bySearch.filter(i => !state.club || i.clubs.includes(state.club));
    els.feed.classList.toggle("animate", !!animate);
    els.feed.replaceChildren();
    if (!items.length) { els.feed.append(emptyState(q)); return; }

    // Breaking: grote kaart + "Net binnen"
    const [lead, ...rest] = items;
    const side = rest.slice(0, SIDE_COUNT);
    const breaking = el("section", { class: "breaking", "aria-label": "Laatste nieuws" }, renderLead(lead));
    if (side.length) breaking.append(renderSide(side));
    els.feed.append(breaking);

    // Daarna de rest, per dag gegroepeerd
    const others = rest.slice(SIDE_COUNT);
    const perDay = {};
    for (const i of others) { const l = dayLabel(new Date(i.published)); perDay[l] = (perDay[l] || 0) + 1; }

    let currentDay = "", grid = null, n = SIDE_COUNT + 1;
    for (const item of others.slice(0, state.shown)) {
      const label = dayLabel(new Date(item.published));
      if (label !== currentDay) {
        currentDay = label;
        grid = el("ul", { class: "grid" });
        const count = perDay[label];
        els.feed.append(
          el("h3", { class: "day", style: { "--i": String(n++) } }, label,
            el("span", { class: "n" }, `${count} ${count === 1 ? "bericht" : "berichten"}`)),
          grid);
      }
      grid.append(renderCard(item, n++));
    }

    if (others.length > state.shown) {
      const more = el("button", { class: "more", type: "button" }, `Meer laden (${others.length - state.shown})`);
      more.addEventListener("click", () => { state.shown += PAGE_SIZE; render(false); });
      els.feed.append(more);
    }
  }

  // "12 min geleden" elke 30 seconden bijwerken, zonder alles opnieuw te tekenen
  function refreshAgo() {
    for (const t of document.querySelectorAll("time[data-ago]")) {
      t.textContent = ago(new Date(t.getAttribute("datetime")));
    }
    renderUpdated();
  }

  // ---------- Data ophalen ----------
  async function load(firstTime) {
    try {
      // ?t=... voorkomt dat de browser een oude versie uit de cache toont
      const res = await fetch(`data/news.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      state.data = await res.json();
      state.data.items.sort((a, b) => b.published.localeCompare(a.published));
      state.clubMap = Object.fromEntries(state.data.clubs.map(c => [c.slug, c]));
      readHash();
      renderUpdated();
      renderStats();
      renderTicker();
      render(firstTime);
    } catch (err) {
      console.error(err);
      if (!state.data) {
        els.updated.textContent = "Nieuws kon niet worden geladen.";
        els.feed.replaceChildren(el("div", { class: "empty" },
          el("span", { class: "icon", "aria-hidden": "true" }, "📡"),
          el("strong", {}, "Nieuws kon niet worden geladen"),
          el("span", {}, "Probeer het over een paar minuten opnieuw.")));
      }
    }
  }

  // De zoek/filterbalk plakt precies onder de header (+ ticker)
  const header = document.querySelector(".topbar");
  const setHeadHeight = () => document.documentElement.style.setProperty("--head-h", `${header.offsetHeight}px`);
  if ("ResizeObserver" in window) new ResizeObserver(setHeadHeight).observe(header);
  setHeadHeight();

  let timer;
  els.search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.query = els.search.value; state.shown = PAGE_SIZE; render(true); }, 180);
  });
  window.addEventListener("hashchange", () => { if (state.data) { readHash(); render(true); } });

  tickClock();
  setInterval(tickClock, 1000);
  setInterval(refreshAgo, 30 * 1000);
  load(true);
  setInterval(() => load(false), 10 * 60 * 1000); // elke 10 minuten stilletjes verversen
})();
