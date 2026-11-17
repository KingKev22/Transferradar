// TransferRadar – laadt docs/data/news.json en toont de berichten.
(() => {
  "use strict";

  const PAGE_SIZE = 30;
  const NEW_MS = 60 * 60 * 1000; // "NIEUW"-label: berichten van het afgelopen uur

  // Afkortingen voor de ronde clubbadges
  const SHORT = {
    ajax: "AJA", psv: "PSV", feyenoord: "FEY", az: "AZ", twente: "TWE", utrecht: "UTR",
    nec: "NEC", heerenveen: "HEE", groningen: "GRO", sparta: "SPA", fortuna: "FOR",
    gae: "GAE", pec: "PEC", excelsior: "EXC", telstar: "TEL", willem2: "WII",
    ado: "ADO", cambuur: "CAM",
  };

  const els = {
    status: document.getElementById("status"),
    clubs: document.getElementById("clubs"),
    feed: document.getElementById("feed"),
    search: document.getElementById("search"),
    stats: document.getElementById("stats"),
  };

  const state = { data: null, club: "", query: "", shown: PAGE_SIZE };

  // ---------- Tijd netjes in het Nederlands ----------
  const dayFmt = new Intl.DateTimeFormat("nl-NL", { weekday: "long", day: "numeric", month: "long" });
  const fullFmt = new Intl.DateTimeFormat("nl-NL", { dateStyle: "full", timeStyle: "short" });
  const timeFmt = new Intl.DateTimeFormat("nl-NL", { hour: "2-digit", minute: "2-digit" });

  function relative(date) {
    const min = Math.round((Date.now() - date) / 60000);
    if (min < 1) return "zojuist";
    if (min < 60) return `${min} min geleden`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} uur geleden`;
    return timeFmt.format(date);
  }

  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  function dayLabel(date) {
    const diff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
    if (diff === 0) return "Vandaag";
    if (diff === 1) return "Gisteren";
    return dayFmt.format(date);
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

  // ---------- Kleine helper om veilig HTML-elementen te maken ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "style") for (const [p, val] of Object.entries(v)) node.style.setProperty(p, val);
      else node.setAttribute(k, v);
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

  const safeUrl = url => /^https?:\/\//i.test(url) ? url : "#";

  const badge = club => el("span", {
    class: "badge",
    style: { "--club": club.color, "--badge-ink": inkFor(club.color) },
  }, shortName(club));

  // ---------- Filter via de URL (#ajax), zodat je een link kunt delen ----------
  function readHash() {
    const slug = decodeURIComponent(location.hash.slice(1));
    state.club = state.data && state.data.clubs.some(c => c.slug === slug) ? slug : "";
  }

  function setClub(slug) {
    history.replaceState(null, "", slug ? `#${slug}` : location.pathname + location.search);
    state.club = slug;
    state.shown = PAGE_SIZE;
    render(true);
  }

  // ---------- Tekenen ----------
  function renderStats() {
    const now = Date.now(), today = startOfDay(new Date());
    let hour = 0, day = 0;
    const active = new Set();
    for (const i of state.data.items) {
      const t = new Date(i.published).getTime();
      if (now - t < NEW_MS) hour++;
      if (t >= today) { day++; i.clubs.forEach(c => active.add(c)); }
    }
    const set = (k, v) => { els.stats.querySelector(`[data-stat="${k}"]`).textContent = v; };
    set("hour", hour); set("today", day); set("clubs", active.size);
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

  function renderCard(item, clubMap, index, isLead) {
    const date = new Date(item.published);
    const clubs = item.clubs.map(s => clubMap[s]).filter(Boolean);
    const isNew = Date.now() - date.getTime() < NEW_MS;

    const top = el("div", { class: "card-top" });
    for (const c of clubs) top.append(el("span", { class: "club-tag" }, badge(c), c.name));
    if (isNew) top.append(el("span", { class: "new" }, "NIEUW"));

    return el("li", {
      class: isLead ? "card lead" : "card",
      style: { "--club": clubs[0] ? clubs[0].color : "var(--accent)", "--i": String(index) },
    },
      top,
      isLead ? el("span", { class: "label" }, "Laatste nieuws") : null,
      el("h2", {}, el("a", { href: safeUrl(item.link), target: "_blank", rel: "noopener noreferrer" }, item.title)),
      el("div", { class: "card-foot" },
        el("span", { class: "src-logo", "aria-hidden": "true" }, sourceInitials(item.source)),
        el("span", { class: "src" }, item.source),
        el("span", { class: "sep" }, "·"),
        el("time", { datetime: item.published, title: fullFmt.format(date) }, relative(date)),
        el("span", { class: "go", "aria-hidden": "true" }, svg("0 0 24 24", '<path d="M5 12h14M13 6l6 6-6 6"/>'))));
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
    const { data } = state;
    const q = state.query.trim().toLowerCase();
    const bySearch = data.items.filter(i => !q || i.title.toLowerCase().includes(q) || i.source.toLowerCase().includes(q));

    const counts = {};
    for (const i of bySearch) for (const s of i.clubs) counts[s] = (counts[s] || 0) + 1;
    state.total = bySearch.length;
    renderClubs(counts);

    const items = bySearch.filter(i => !state.club || i.clubs.includes(state.club));
    const clubMap = Object.fromEntries(data.clubs.map(c => [c.slug, c]));

    els.feed.classList.toggle("animate", !!animate);
    els.feed.replaceChildren();
    if (!items.length) { els.feed.append(emptyState(q)); return; }

    const visible = items.slice(0, state.shown);
    const perDay = {};
    for (const i of items) { const l = dayLabel(new Date(i.published)); perDay[l] = (perDay[l] || 0) + 1; }

    let currentDay = "", grid = null, n = 0;
    visible.forEach((item, idx) => {
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
      grid.append(renderCard(item, clubMap, n++, idx === 0));
    });

    if (items.length > state.shown) {
      const more = el("button", { class: "more", type: "button" },
        `Meer laden`, el("span", { class: "count" }, `(${items.length - state.shown})`));
      more.addEventListener("click", () => { state.shown += PAGE_SIZE; render(false); });
      els.feed.append(more);
    }
  }

  function renderStatus() {
    const updated = new Date(state.data.updated);
    els.status.classList.remove("is-offline");
    els.status.replaceChildren(
      el("span", { class: "pulse" }),
      el("b", {}, "LIVE"),
      el("span", { class: "long" }, `· bijgewerkt ${relative(updated)}`));
    els.status.title = `Laatst bijgewerkt: ${fullFmt.format(updated)}`;
  }

  // ---------- Data ophalen ----------
  async function load(firstTime) {
    try {
      // ?t=... voorkomt dat de browser een oude versie uit de cache toont
      const res = await fetch(`data/news.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      state.data = await res.json();
      state.data.items.sort((a, b) => b.published.localeCompare(a.published));
      readHash();
      renderStatus();
      renderStats();
      render(firstTime);
    } catch (err) {
      console.error(err);
      if (!state.data) {
        els.status.classList.add("is-offline");
        els.status.replaceChildren(el("span", { class: "pulse" }), el("span", {}, "Offline"));
        els.feed.replaceChildren(el("div", { class: "empty" },
          el("span", { class: "icon", "aria-hidden": "true" }, "📡"),
          el("strong", {}, "Nieuws kon niet worden geladen"),
          el("span", {}, "Probeer het over een paar minuten opnieuw.")));
      }
    }
  }

  let timer;
  els.search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.query = els.search.value; state.shown = PAGE_SIZE; render(true); }, 180);
  });
  window.addEventListener("hashchange", () => { if (state.data) { readHash(); render(true); } });

  load(true);
  setInterval(() => load(false), 10 * 60 * 1000); // elke 10 minuten stilletjes verversen
})();
