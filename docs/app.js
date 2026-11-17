// TransferRadar – laadt docs/data/news.json en bouwt de pagina op.
(() => {
  "use strict";

  const PAGE_SIZE = 12;                        // kaarten per keer in het grid
  const RECENT_COUNT = 8;                      // "Meest recent" in de zijbalk
  const TICKER_COUNT = 10;                     // koppen in de ticker
  const NEW_MS = 60 * 60 * 1000;               // "NIEUW": afgelopen uur
  const BREAKING_MS = 3 * 60 * 60 * 1000;      // hero heet "BREAKING" als hij < 3 uur oud is
  const HERO_LOOKAHEAD = 4;                    // hero: nieuwste bericht met foto uit de eerste 4

  const $ = id => document.getElementById(id);
  const els = {
    clock: $("clock"), ticker: $("ticker"), track: $("ticker-track"),
    hero: $("hero"), grid: $("grid"), more: $("more-slot"), updated: $("updated"),
    clubs: $("clubs"), search: $("search"), recent: $("recent"),
    win: $("window"), winStatus: $("window-status"), winName: $("window-name"),
    winText: $("window-text"), winNote: $("window-note"), winProgress: $("window-progress"),
    countdown: $("countdown"),
  };
  const state = { data: null, club: "", query: "", shown: PAGE_SIZE, clubMap: {} };

  // ---------- Datum en tijd (Nederlandse notatie) ----------
  const fmt = o => new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", ...o });
  const longDay = fmt({ weekday: "long", day: "numeric", month: "long" });
  const shortDay = fmt({ weekday: "short", day: "numeric", month: "short" });
  const fullDate = fmt({ weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const hm = fmt({ hour: "2-digit", minute: "2-digit" });
  const full = fmt({ dateStyle: "full", timeStyle: "short" });

  function ago(date) {
    const min = Math.floor((Date.now() - date) / 60000);
    if (min < 1) return "zojuist";
    if (min < 60) return `${min} min geleden`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} uur geleden`;
    const d = Math.floor(h / 24);
    return d === 1 ? "gisteren" : `${d} dagen geleden`;
  }

  // ---------- Kleuren ----------
  function luminance(hex) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || "");
    if (!m) return 0;
    const [r, g, b] = m.slice(1).map(x => {
      const c = parseInt(x, 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const inkFor = hex => luminance(hex) > 0.45 ? "#0f1216" : "#fff";

  // ---------- Veilig HTML-elementen maken (tekst wordt altijd ge-escaped) ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "style") for (const [p, val] of Object.entries(v)) node.style.setProperty(p, val);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c != null && c !== false) node.append(c);
    return node;
  }
  function svg(viewBox, inner, cls) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", viewBox);
    s.setAttribute("aria-hidden", "true");
    if (cls) s.setAttribute("class", cls);
    s.innerHTML = inner;          // vaste, eigen SVG-code (geen data van buiten)
    return s;
  }
  const ARROW = '<path d="M5 12h14M13 6l6 6-6 6"/>';
  const SILHOUETTE = '<circle cx="50" cy="35" r="17"/><path d="M12 100c0-24 17-38 38-38s38 14 38 38z"/>';

  const safeUrl = url => /^https?:\/\//i.test(url || "") ? url : "#";
  const clubsOf = item => item.clubs.map(s => state.clubMap[s]).filter(Boolean);
  const photoOf = item => (item.player && item.player.photo && /^https:\/\//.test(item.player.photo.src)) ? item.player.photo : null;

  // ---------- Foto of silhouet ----------
  function placeholder(clubs) {
    const c1 = clubs[0] ? clubs[0].color : "#3a404b";
    const light = luminance(c1) > 0.45;
    return el("div", {
      class: "ph", "aria-hidden": "true",
      style: {
        "--c1": c1, "--c2": clubs[1] ? clubs[1].color : "transparent",
        "--sil": light ? "rgba(0,0,0,.16)" : "rgba(255,255,255,.24)",
        "--ph-ink": inkFor(c1),
      },
    }, svg("0 0 100 100", SILHOUETTE), el("span", { class: "ph-badge" }, clubs[0] ? clubs[0].name : "Eredivisie"));
  }

  function media(item, eager, noPhoto, large) {
    const box = el("div", { class: "media" }, placeholder(clubsOf(item)));
    const photo = !noPhoto && photoOf(item);
    if (photo) {
      const img = el("img", {
        src: large ? photo.src : (photo.src_small || photo.src), class: "loading", loading: eager ? "eager" : "lazy", decoding: "async",
        alt: item.player.name ? `Foto van ${item.player.name}` : "",
      });
      img.addEventListener("load", () => img.classList.remove("loading"));
      img.addEventListener("error", () => {                  // kapot -> silhouet blijft,
        img.remove();                                        // en de credit hoort er dan niet bij
        const c = box.parentElement && box.parentElement.querySelector(".credit");
        if (c) c.remove();
      });
      box.append(img);
    }
    return box;
  }

  // Verplichte naamsvermelding bij Wikimedia-foto's
  function credit(item, tag = "p", noPhoto = false) {
    const p = !noPhoto && photoOf(item);
    if (!p) return null;
    const link = (text, href) => href
      ? el("a", { href: safeUrl(href), target: "_blank", rel: "noopener" }, text)
      : text;
    return el(tag, { class: "credit", title: `Foto: ${p.artist} · ${p.license} · Wikimedia Commons` },
      "Foto: ", link(p.artist, p.page), " · ", link(p.license, p.license_url || p.page), " · Wikimedia Commons");
  }

  const clubLabel = c => el("span", { class: "club-label", style: { "--club": c.color } }, c.name);
  const timeAgo = item => el("time", {
    datetime: item.published, "data-ago": "", title: full.format(new Date(item.published)),
  }, ago(new Date(item.published)));
  const titleLink = item => el("a", {
    class: "stretch", href: safeUrl(item.link), target: "_blank", rel: "noopener noreferrer",
  }, item.title);
  const age = item => Date.now() - new Date(item.published).getTime();

  // ---------- Header: klok ----------
  function tickClock() {
    const now = new Date();
    const time = hm.format(now);
    if (els.clock.dataset.t === time) return;
    els.clock.dataset.t = time;
    els.clock.setAttribute("datetime", now.toISOString());
    els.clock.replaceChildren(
      el("span", { class: "day-part" },
        el("span", { class: "long" }, longDay.format(now)),
        el("span", { class: "short" }, shortDay.format(now).replace(/\./g, "")),
        el("span", { class: "sep" }, "·")),
      el("span", { class: "hm" }, time));
  }

  // ---------- Ticker ----------
  function renderTicker() {
    const items = state.data.items.slice(0, TICKER_COUNT);
    els.ticker.hidden = !items.length;
    const build = hidden => items.map(item => {
      const c = clubsOf(item)[0];
      return el("a", {
        class: "tick", href: safeUrl(item.link), target: "_blank", rel: "noopener noreferrer",
        tabindex: hidden ? "-1" : null, "aria-hidden": hidden ? "true" : null,
      }, el("time", { datetime: item.published }, hm.format(new Date(item.published))),
        c ? el("span", { class: "tick-club" }, c.name) : null,
        el("span", { class: "tick-title" }, item.title));
    });
    els.track.replaceChildren(...build(false), ...build(true));   // dubbel = naadloos rondlopen
    requestAnimationFrame(() => els.track.style.setProperty("--dur", `${Math.max(30, els.track.scrollWidth / 2 / 70)}s`));
  }

  // ---------- Hero ----------
  function renderHero(item) {
    if (!item) { els.hero.replaceChildren(); return; }
    const clubs = clubsOf(item);
    const fresh = age(item) < BREAKING_MS;
    els.hero.replaceChildren(el("article", { class: "hero reveal" },
      el("figure", { class: "hero-fig" }, media(item, true, false, true), credit(item, "figcaption")),
      el("div", { class: "hero-text" },
        el("div", { class: "kicker" },
          el("span", { class: fresh ? "flag" : "flag dark" }, fresh ? "Breaking" : "Uitgelicht"),
          ...clubs.map(clubLabel)),
        el("h1", {}, titleLink(item)),
        el("div", { class: "meta" },
          el("b", {}, item.source), el("span", { class: "dot" }, "•"), timeAgo(item),
          el("span", { class: "read-more" }, `Lees bij ${item.source}`, svg("0 0 24 24", ARROW))))));
  }

  // ---------- Grid ----------
  // Dezelfde spelersfoto niet twee keer direct na elkaar: de tweede kaart krijgt het silhouet
  let lastPhoto = null;
  function renderCard(item, i) {
    const clubs = clubsOf(item);
    const src = photoOf(item) && photoOf(item).src;
    const repeat = !!src && src === lastPhoto;
    lastPhoto = repeat ? null : src;
    return el("li", { class: "card reveal", style: { "--i": String(i) } },
      media(item, false, repeat),
      credit(item, "p", repeat),
      el("div", { class: "card-body" },
        el("div", { class: "kicker" },
          ...clubs.map(clubLabel),
          age(item) < NEW_MS ? el("span", { class: "flag new" }, "Nieuw") : null,
          timeAgo(item)),
        el("h3", {}, titleLink(item)),
        el("div", { class: "src" }, el("b", {}, item.source), svg("0 0 24 24", ARROW))));
  }

  function renderChips(counts, total) {
    const scroll = els.clubs.scrollLeft;
    const all = el("button", { class: "chip all", type: "button", "aria-pressed": String(!state.club) },
      "Alle clubs", el("span", { class: "n" }, String(total)));
    all.addEventListener("click", () => setClub(""));
    const chips = [...state.data.clubs]
      .sort((a, b) => (counts[b.slug] || 0) - (counts[a.slug] || 0) || a.name.localeCompare(b.name, "nl"))
      .map(club => {
        const n = counts[club.slug] || 0, active = state.club === club.slug;
        const b = el("button", {
          class: "chip", type: "button", "aria-pressed": String(active),
          style: { "--club": club.color, "--chip-ink": inkFor(club.color) },
        }, el("i", { "aria-hidden": "true" }), club.name, el("span", { class: "n" }, String(n)));
        b.disabled = !n && !active;
        b.addEventListener("click", () => setClub(active ? "" : club.slug));
        return b;
      });
    els.clubs.replaceChildren(all, ...chips);
    els.clubs.scrollLeft = scroll;
  }

  function emptyState(q) {
    const box = el("li", { class: "empty" },
      el("strong", {}, "Geen transfernieuws gevonden"),
      q ? "Probeer een andere zoekterm." : "Er is (nog) geen nieuws voor deze selectie.");
    if (q || state.club) {
      const reset = el("button", { type: "button" }, "Toon al het nieuws");
      reset.addEventListener("click", () => { els.search.value = ""; state.query = ""; setClub(""); });
      box.append(el("br"), reset);
    }
    return box;
  }

  function render() {
    const q = state.query.trim().toLowerCase();
    const matches = i => !q || i.title.toLowerCase().includes(q) || i.source.toLowerCase().includes(q) ||
      (i.player && i.player.name.toLowerCase().includes(q));
    const bySearch = state.data.items.filter(matches);
    const counts = {};
    for (const i of bySearch) for (const s of i.clubs) counts[s] = (counts[s] || 0) + 1;
    renderChips(counts, bySearch.length);

    const items = bySearch.filter(i => !state.club || i.clubs.includes(state.club));
    // Hero: het nieuwste bericht met een spelersfoto (uit de eerste paar), anders het nieuwste
    const hero = items.slice(0, HERO_LOOKAHEAD).find(photoOf) || items[0];
    renderHero(hero);

    const rest = items.filter(i => i !== hero);
    lastPhoto = photoOf(hero || {}) ? photoOf(hero).src : null;
    els.grid.replaceChildren();
    els.more.replaceChildren();
    if (!items.length) { els.grid.append(emptyState(q)); return; }
    rest.slice(0, state.shown).forEach((item, i) => els.grid.append(renderCard(item, i)));
    if (rest.length > state.shown) {
      const more = el("button", { class: "more", type: "button" }, `Meer laden (${rest.length - state.shown})`);
      more.addEventListener("click", () => {
        state.shown += PAGE_SIZE;
        rest.slice(state.shown - PAGE_SIZE, state.shown).forEach((item, i) => els.grid.append(renderCard(item, i)));
        if (rest.length <= state.shown) more.remove();
        else more.textContent = `Meer laden (${rest.length - state.shown})`;
      });
      els.more.append(more);
    }
  }

  // ---------- Meest recent ----------
  function renderRecent() {
    els.recent.replaceChildren(...state.data.items.slice(0, RECENT_COUNT).map(item => {
      const c = clubsOf(item)[0];
      return el("li", {},
        el("time", { datetime: item.published, title: full.format(new Date(item.published)) }, hm.format(new Date(item.published))),
        el("div", {},
          c ? clubLabel(c) : null,
          el("a", { href: safeUrl(item.link), target: "_blank", rel: "noopener noreferrer" }, item.title)));
    }));
  }

  // ---------- Transferwindow ----------
  function duration(ms) {
    const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24, m = Math.floor(ms / 60000) % 60;
    if (d > 0) return `${d} ${d === 1 ? "dag" : "dagen"}, ${h} uur`;
    if (h > 0) return `${h} uur, ${m} ${m === 1 ? "minuut" : "minuten"}`;
    return `${m} ${m === 1 ? "minuut" : "minuten"}`;
  }
  const at = date => `${fullDate.format(date)} om ${hm.format(date)}`;

  function windowState(now) {
    const list = (state.data.windows || [])
      .map(w => ({ ...w, o: w.opens ? new Date(w.opens) : null, c: w.closes ? new Date(w.closes) : null }))
      .filter(w => w.c)
      .sort((a, b) => a.c - b.c);
    const open = list.find(w => (!w.o || w.o <= now) && now < w.c && w.o);
    if (open) return { kind: "open", w: open, target: open.c, start: open.o };
    const next = list.find(w => w.o && w.o > now);
    const prev = [...list].reverse().find(w => w.c <= now);
    if (next) return { kind: "closed", w: next, target: next.o, start: prev ? prev.c : null };
    return { kind: "unknown", prev };
  }

  function setDigits(ms) {
    const parts = {
      d: Math.floor(ms / 86400000), h: Math.floor(ms / 3600000) % 24,
      m: Math.floor(ms / 60000) % 60, s: Math.floor(ms / 1000) % 60,
    };
    for (const [unit, v] of Object.entries(parts)) {
      const b = els.countdown.querySelector(`[data-unit="${unit}"]`);
      const text = unit === "d" ? String(v) : String(v).padStart(2, "0");
      if (b.textContent !== text) b.textContent = text;
    }
  }

  function tickWindow() {
    if (!state.data) return;
    const now = new Date();
    const s = windowState(now);
    const win = els.win;
    win.classList.toggle("is-open", s.kind === "open");
    win.classList.toggle("is-unknown", s.kind === "unknown");

    if (s.kind === "unknown") {
      win.classList.remove("is-deadline");
      els.winStatus.textContent = "Dicht";
      els.winName.textContent = "Volgende window";
      els.winText.replaceChildren("De data van het volgende transferwindow zijn nog niet bekend.");
      els.winProgress.style.width = "0%";
      els.winNote.textContent = s.prev ? `Laatste window (${s.prev.name}) sloot op ${at(s.prev.c)}.` : "";
      return;
    }

    const left = Math.max(0, s.target - now);
    const deadline = s.kind === "open" && left < 86400000;
    win.classList.toggle("is-deadline", deadline);
    els.winStatus.textContent = deadline ? "Deadline day" : s.kind === "open" ? "Open" : "Dicht";
    els.winName.textContent = s.w.name;
    setDigits(left);

    const sentence = s.kind === "open"
      ? [deadline ? "Nog " : "Sluit over ", el("strong", {}, duration(left)), deadline ? " om transfers af te ronden." : `, op ${at(s.target)}.`]
      : ["Opent over ", el("strong", {}, duration(left)), `, op ${at(s.target)}.`];
    const key = sentence.map(x => typeof x === "string" ? x : x.textContent).join("");
    if (els.winText.dataset.key !== key) { els.winText.dataset.key = key; els.winText.replaceChildren(...sentence); }

    const pct = s.start ? Math.min(100, Math.max(0, (now - s.start) / (s.target - s.start) * 100)) : 0;
    els.winProgress.style.width = `${pct.toFixed(1)}%`;
    els.winNote.textContent = s.w.note || "";
  }

  // ---------- Overige updates ----------
  function renderUpdated() {
    if (!state.data) return;
    const d = new Date(state.data.updated);
    els.updated.textContent = `Bijgewerkt ${ago(d)}`;
    els.updated.title = full.format(d);
  }
  function refreshAgo() {
    for (const t of document.querySelectorAll("time[data-ago]")) t.textContent = ago(new Date(t.getAttribute("datetime")));
    renderUpdated();
  }

  // ---------- Filter via de URL (#ajax), zodat je een link kunt delen ----------
  function readHash() {
    const slug = decodeURIComponent(location.hash.slice(1));
    state.club = state.clubMap[slug] ? slug : "";
  }
  function setClub(slug) {
    history.replaceState(null, "", slug ? `#${slug}` : location.pathname + location.search);
    state.club = slug;
    state.shown = PAGE_SIZE;
    render();
  }

  // ---------- Data ophalen ----------
  async function load() {
    try {
      const res = await fetch(`data/news.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      state.data = await res.json();
      state.data.items.sort((a, b) => b.published.localeCompare(a.published));
      state.clubMap = Object.fromEntries(state.data.clubs.map(c => [c.slug, c]));
      readHash();
      renderUpdated();
      renderTicker();
      renderRecent();
      render();
      tickWindow();
    } catch (err) {
      console.error(err);
      if (!state.data) {
        els.hero.replaceChildren();
        els.grid.replaceChildren(el("li", { class: "empty" },
          el("strong", {}, "Nieuws kon niet worden geladen"), "Probeer het over een paar minuten opnieuw."));
      }
    }
  }

  // De filterbalk/zijbalk houden rekening met de hoogte van header + ticker
  const header = document.querySelector(".masthead");
  const setHeadH = () => document.documentElement.style.setProperty("--head-h", `${header.offsetHeight}px`);
  if ("ResizeObserver" in window) new ResizeObserver(setHeadH).observe(header);
  setHeadH();

  let typing;
  els.search.addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(() => { state.query = els.search.value; state.shown = PAGE_SIZE; render(); }, 180);
  });
  window.addEventListener("hashchange", () => { if (state.data) { readHash(); render(); } });

  tickClock();
  setInterval(() => { tickClock(); tickWindow(); }, 1000);
  setInterval(refreshAgo, 30 * 1000);
  load();
  setInterval(load, 10 * 60 * 1000);   // elke 10 minuten stilletjes verversen
})();
