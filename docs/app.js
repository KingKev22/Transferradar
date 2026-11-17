// Transferradar – laadt docs/data/news.json en toont de berichten.
(() => {
  "use strict";

  const PAGE_SIZE = 40;
  const els = {
    status: document.getElementById("status"),
    clubs: document.getElementById("clubs"),
    feed: document.getElementById("feed"),
    search: document.getElementById("search"),
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

  function dayLabel(date) {
    const start = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((start(new Date()) - start(date)) / 86400000);
    if (diff === 0) return "Vandaag";
    if (diff === 1) return "Gisteren";
    return dayFmt.format(date);
  }

  // ---------- Kleine helper om veilig HTML-elementen te maken ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "style") Object.assign(node.style, v);
      else node.setAttribute(k, v);
    }
    for (const c of children) node.append(c); // tekst wordt automatisch veilig ge-escaped
    return node;
  }

  const safeUrl = url => /^https?:\/\//i.test(url) ? url : "#";

  // ---------- Filter via de URL (#ajax), zodat je een link kunt delen ----------
  function readHash() {
    const slug = decodeURIComponent(location.hash.slice(1));
    state.club = state.data && state.data.clubs.some(c => c.slug === slug) ? slug : "";
  }

  function setClub(slug) {
    history.replaceState(null, "", slug ? `#${slug}` : location.pathname + location.search);
    state.club = slug;
    state.shown = PAGE_SIZE;
    render();
  }

  // ---------- Tekenen ----------
  function renderClubs(counts) {
    els.clubs.replaceChildren();
    const all = el("button", { class: "chip", type: "button", "aria-pressed": String(!state.club) },
      "Alle clubs", el("span", { class: "count" }, String(state.data.items.length)));
    all.addEventListener("click", () => setClub(""));
    els.clubs.append(all);

    const clubs = [...state.data.clubs].sort((a, b) =>
      (counts[b.slug] || 0) - (counts[a.slug] || 0) || a.name.localeCompare(b.name, "nl"));

    for (const club of clubs) {
      const n = counts[club.slug] || 0;
      const btn = el("button", { class: "chip", type: "button", "aria-pressed": String(state.club === club.slug) },
        el("span", { class: "club-dot", style: { background: club.color } }),
        club.name,
        el("span", { class: "count" }, String(n)));
      if (!n && state.club !== club.slug) btn.disabled = true;
      btn.addEventListener("click", () => setClub(state.club === club.slug ? "" : club.slug));
      els.clubs.append(btn);
    }
  }

  function renderCard(item, clubMap) {
    const date = new Date(item.published);
    const tags = el("div", { class: "tags" });
    for (const slug of item.clubs) {
      const c = clubMap[slug];
      if (c) tags.append(el("span", { class: "tag" },
        el("span", { class: "club-dot", style: { background: c.color } }), c.name));
    }
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>';

    return el("li", { class: "card" },
      tags,
      el("h2", {}, el("a", { href: safeUrl(item.link), target: "_blank", rel: "noopener noreferrer" }, item.title)),
      el("div", { class: "meta" },
        el("span", { class: "source" }, item.source),
        el("span", {}, "·"),
        el("time", { datetime: item.published, title: fullFmt.format(date) }, relative(date)),
        icon));
  }

  function render() {
    const { data } = state;
    const q = state.query.trim().toLowerCase();
    const bySearch = data.items.filter(i => !q || i.title.toLowerCase().includes(q) || i.source.toLowerCase().includes(q));

    const counts = {};
    for (const i of bySearch) for (const s of i.clubs) counts[s] = (counts[s] || 0) + 1;
    renderClubs(counts);

    const items = bySearch.filter(i => !state.club || i.clubs.includes(state.club));
    const clubMap = Object.fromEntries(data.clubs.map(c => [c.slug, c]));

    els.feed.replaceChildren();
    if (!items.length) {
      els.feed.append(el("div", { class: "empty" },
        el("strong", {}, "Geen transfernieuws gevonden"),
        q ? "Probeer een andere zoekterm." : "Er is (nog) geen nieuws voor deze selectie. Kom later terug!"));
      return;
    }

    let currentDay = "", list = null;
    for (const item of items.slice(0, state.shown)) {
      const label = dayLabel(new Date(item.published));
      if (label !== currentDay) {
        currentDay = label;
        list = el("ul", { class: "list" });
        els.feed.append(el("h3", { class: "day" }, label), list);
      }
      list.append(renderCard(item, clubMap));
    }

    if (items.length > state.shown) {
      const more = el("button", { class: "more", type: "button" }, `Meer laden (${items.length - state.shown})`);
      more.addEventListener("click", () => { state.shown += PAGE_SIZE; render(); });
      els.feed.append(more);
    }
  }

  function renderStatus() {
    const updated = new Date(state.data.updated);
    els.status.replaceChildren(el("span", { class: "dot" }), `Bijgewerkt ${relative(updated)}`);
    els.status.title = fullFmt.format(updated);
  }

  // ---------- Data ophalen ----------
  async function load() {
    try {
      // ?t=... voorkomt dat de browser een oude versie uit de cache toont
      const res = await fetch(`data/news.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      state.data = await res.json();
      state.data.items.sort((a, b) => b.published.localeCompare(a.published));
      readHash();
      renderStatus();
      render();
    } catch (err) {
      console.error(err);
      if (!state.data) {
        els.status.textContent = "Offline";
        els.feed.replaceChildren(el("div", { class: "empty" },
          el("strong", {}, "Nieuws kon niet worden geladen"), "Probeer het over een paar minuten opnieuw."));
      }
    }
  }

  let timer;
  els.search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.query = els.search.value; state.shown = PAGE_SIZE; render(); }, 150);
  });
  window.addEventListener("hashchange", () => { if (state.data) { readHash(); render(); } });

  load();
  setInterval(load, 10 * 60 * 1000); // elke 10 minuten stilletjes verversen
})();
