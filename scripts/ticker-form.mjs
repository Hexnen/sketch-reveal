/* Formularz paska wiadomości w edytorze presetu: wygląd / kanał / tytuł / akcent, lista wiadomości i odtwarzanie (tryb, styl,
   tempo, limit czasu, rozmiar). Pola listy nie mają atrybutu name — czyta je readTickerForm() wprost z DOM (kolejność wierszy =
   kolejność na pasku), reszta idzie przez FormDataExtended pod prefiksem "ticker.".

   Lista wiadomości to „scenariusz wydania”, nie tabela pól: wąska kolumna etykiet (jak rubryka w scenariuszu serwisu) i tekst
   pisany jak proza — bez ramek pól, z zawijaniem, z podświetleniem bieżącego wiersza. Klawiatura działa jak w edytorze tekstu:
   Enter dzieli wiadomość w miejscu kursora (na końcu — nowa), Backspace na początku łączy z poprzednią, Delete na końcu —
   z następną, ↑/↓ na brzegu przechodzą między wiadomościami, Alt+↑/↓ przestawia, „ETYKIETA | tekst” przenosi etykietę do
   rubryki, wklejenie wielu linii = wiele wiadomości, Ctrl+Enter = „Zastosuj” (na antenie: zmiana u wszystkich). Kolejność
   można też zmienić przeciągając uchwyt z lewej. */
import { TICKER_LIMITS, TICKER_LOOKS, sanitizeTicker, tickerItemId } from "./fx/ticker.mjs";

const L = (k, d) => (d ? game.i18n.format(`SKETCHREVEAL.${k}`, d) : game.i18n.localize(`SKETCHREVEAL.${k}`));
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

const group = (label, inner, hint = "", extra = "") =>
  `<div class="form-group"${extra}><label>${esc(label)}</label><div class="form-fields">${inner}</div>${hint ? `<p class="hint">${esc(hint)}</p>` : ""}</div>`;
const select = (name, v, opts) =>
  `<select name="${name}">${opts.map(([val, lab]) => `<option value="${esc(val)}"${String(val) === String(v) ? " selected" : ""}>${esc(lab)}</option>`).join("")}</select>`;

const GRIP_SVG = `<svg viewBox="0 0 10 16" aria-hidden="true" focusable="false"><circle cx="3" cy="3" r="1.3"/><circle cx="7" cy="3" r="1.3"/><circle cx="3" cy="8" r="1.3"/><circle cx="7" cy="8" r="1.3"/><circle cx="3" cy="13" r="1.3"/><circle cx="7" cy="13" r="1.3"/></svg>`;
const X_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
/** Od ilu znaków do limitu pokazywać licznik pozostałych. */
const WARN_LEFT = 40;

function itemRow(it = { id: tickerItemId(), label: "", text: "" }, isNew = false) {
  return `<li class="sr-item${isNew ? " sr-item-new" : ""}" data-id="${esc(it.id)}">
    <span class="sr-item-grip" data-sr="grip" data-tooltip="SKETCHREVEAL.Items.Drag" aria-hidden="true">${GRIP_SVG}</span>
    <input type="text" class="sr-item-label" maxlength="${TICKER_LIMITS.label}" value="${esc(it.label)}" placeholder="${esc(L("Items.LabelPh"))}" aria-label="${esc(L("Items.Label"))}" spellcheck="false" autocomplete="off">
    <textarea class="sr-item-text" rows="1" maxlength="${TICKER_LIMITS.text}" placeholder="${esc(L("Items.TextPh"))}" aria-label="${esc(L("Items.Text"))}">${esc(it.text)}</textarea>
    <span class="sr-item-left" aria-hidden="true"></span>
    <button type="button" class="sr-item-remove" data-sr="item-remove" tabindex="-1" data-tooltip="SKETCHREVEAL.Items.Remove" aria-label="${esc(L("Items.Remove"))}">${X_SVG}</button>
  </li>`;
}

/** HTML sekcji paska. `onAir` — preset jest teraz na antenie (zapis zmienia pasek u wszystkich na żywo). */
export function tickerFormHtml(raw, { onAir = false } = {}) {
  const t = sanitizeTicker(raw);
  // pusty preset: od razu jeden wiersz do pisania (nie trzeba szukać przycisku)
  const rows = (t.items.length ? t.items : [undefined]).map((it) => itemRow(it)).join("");
  const n = (v) => `<range-picker name="ticker.${v[0]}" value="${t[v[0]]}" min="${v[1]}" max="${v[2]}" step="${v[3]}"></range-picker>`;
  return `
  <fieldset class="sr-ticker"><legend>${esc(L("Section.Broadcast"))}</legend>
    ${group(L("Field.Look"), select("ticker.look", t.look, TICKER_LOOKS.map((k) => [k, L(`Look.${k}`)])), L("Hint.Look"))}
    ${group(L("Field.Channel"), `<input type="text" name="ticker.channel" maxlength="${TICKER_LIMITS.channel}" value="${esc(t.channel)}" placeholder="${esc(L("Field.ChannelPh"))}">`, L("Hint.Channel"))}
    ${group(L("Field.Headline"), `<input type="text" name="ticker.headline" maxlength="${TICKER_LIMITS.headline}" value="${esc(t.headline)}" placeholder="${esc(L("Field.HeadlinePh"))}">`, L("Hint.Headline"))}
    ${group(L("Field.Accent"), `<input type="color" name="ticker.accent" value="${esc(t.accent)}">`)}
    ${group(L("Field.Live"), `<input type="checkbox" name="ticker.live"${t.live ? " checked" : ""}>`, L("Hint.Live"))}
  </fieldset>
  <fieldset class="sr-ticker sr-rundown-set" style="--sr-accent: ${esc(t.accent)}"><legend>${esc(L("Section.Items"))} <span class="sr-items-count" data-sr="item-count">(${t.items.length})</span></legend>
    ${onAir ? `<p class="notes sr-on-air-note"><i class="fa-solid fa-tower-broadcast"></i> ${esc(L("Ticker.OnAirNote"))}</p>` : ""}
    <ol class="sr-items sr-rundown" data-sr="items" aria-label="${esc(L("Section.Items"))}">${rows}</ol>
    <div class="sr-items-add">
      <button type="button" class="sr-item-add" data-sr="item-add"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${esc(L("Items.Add"))}</button>
      <p class="hint sr-items-keys">${esc(L("Items.Hint"))}</p>
    </div>
  </fieldset>
  <fieldset class="sr-ticker"><legend>${esc(L("Section.Playback"))}</legend>
    ${group(L("Field.Mode"), select("ticker.mode", t.mode, [["loop", L("Mode.loop")], ["once", L("Mode.once")]]), L("Hint.Mode"))}
    ${group(L("Field.Limit"), n(["limitMin", 0, TICKER_LIMITS.limitMin, 5]), L("Hint.Limit"), ' data-showif="ticker.mode" data-showif-is="loop"')}
    ${group(L("Field.Style"), select("ticker.style", t.style, [["flip", L("Style.flip")], ["crawl", L("Style.crawl")]]), L("Hint.Style"))}
    ${group(L("Field.Speed"), n(["speed", 0.5, 2, 0.1]), L("Hint.Speed"))}
    ${group(L("Field.Size"), select("ticker.size", t.size, [["s", L("Size.s")], ["m", L("Size.m")], ["l", L("Size.l")]]))}
  </fieldset>`;
}

/** Pozycje z DOM (puste wiersze pomijane przez sanitizeTicker). */
function readItems(root) {
  return [...root.querySelectorAll(".sr-item")].map((li) => ({
    id: li.dataset.id, label: li.querySelector(".sr-item-label")?.value ?? "", text: li.querySelector(".sr-item-text")?.value ?? "",
  }));
}

/** Formularz → konfiguracja paska (`fields` = obiekt "ticker" z FormDataExtended). */
export function readTickerForm(root, fields = {}) {
  return sanitizeTicker({ ...fields, items: readItems(root) });
}

/** Wiersz „ETYKIETA | tekst” (albo z tabulatorem — wklejka z arkusza) albo sam tekst. */
const parseLine = (l) => {
  const m = /^([^|\t]{1,40})[|\t](.*)$/.exec(l);
  return m ? { label: m[1].trim().slice(0, TICKER_LIMITS.label), text: m[2].trim() } : { label: "", text: l.trim() };
};
/** Tekst wiadomości jest jednolinijkowy: nowe linie i powtórzone spacje → jedna spacja. */
const flat = (s) => s.replace(/\s*[\r\n]+\s*/g, " ");
/** „ETYKIETA | …” (albo z tabulatorem) na POCZĄTKU tekstu: etykieta (przycięta, niepusta, w limicie) i indeks za separatorem. */
const slugOf = (v) => {
  const i = v.search(/[|\t]/);
  if (i <= 0) return null;
  const label = v.slice(0, i).trim();
  return label && label.length <= TICKER_LIMITS.label ? { label, bar: i } : null;
};

/**
 * Zachowanie listy (wołać po każdym renderze). `root` — formularz edytora (albo dowolny kontener z listą: harness).
 * Zwraca funkcję sprzątającą (zdejmuje nasłuchy z dokumentu przy przeciąganiu).
 */
export function bindTickerItems(root) {
  // nasłuch okna i obserwator z poprzedniego renderu zdejmujemy zawsze — także gdy listy już nie ma (rodzaj zmieniony
  // z paska na inny), inaczej trzymałyby odpięty formularz do końca sesji
  root._srItemsAbort?.abort(); root._srItemsAbort = null;
  const list = root.querySelector('[data-sr="items"]');
  if (!list) return () => {};
  const set = list.closest(".sr-rundown-set");
  const addBtn = root.querySelector('[data-sr="item-add"]');
  const count = root.querySelector('[data-sr="item-count"]');
  const rows = () => [...list.children];
  const textOf = (li) => li.querySelector(".sr-item-text");
  const labelOf = (li) => li.querySelector(".sr-item-label");

  /** Pole tekstu rośnie z treścią (zawija się jak akapit, zamiast uciekać w bok jednolinijkowego pola). */
  // niewidoczne pole (okno w trakcie otwierania, ukryta sekcja) ma scrollHeight 0 — nie zapisuj 0 px; dopasuj po pokazaniu
  const grow = (ta) => { if (!ta?.getClientRects().length) return; ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight}px`; };
  const caretTo = (el, pos) => { el.focus(); const p = pos === "end" ? el.value.length : pos; try { el.setSelectionRange(p, p); } catch { /* */ } };

  const refresh = () => {
    const all = rows();
    let filled = 0, longest = 0;
    for (const li of all) {
      const ta = textOf(li), lab = labelOf(li);
      if (ta.value.trim()) filled++;
      longest = Math.max(longest, lab.value.length);
      const left = TICKER_LIMITS.text - ta.value.length;
      const badge = li.querySelector(".sr-item-left");
      badge.textContent = left <= WARN_LEFT ? String(left) : "";
      li.classList.toggle("sr-item-near", left <= WARN_LEFT);
    }
    // kolumna etykiet ma szerokość najdłuższej etykiety (w granicach), żeby teksty zaczynały się w jednej linii
    set?.style.setProperty("--sr-slug", `${Math.min(TICKER_LIMITS.label, Math.max(6, longest + 1))}ch`);
    if (count) count.textContent = `(${filled})`;
    if (addBtn) addBtn.disabled = all.length >= TICKER_LIMITS.items;
  };

  const insert = (after, it, focus = "text") => {
    if (list.children.length >= TICKER_LIMITS.items) { ui.notifications?.warn(L("Items.Max", { n: TICKER_LIMITS.items })); return null; }
    const tpl = document.createElement("template");
    tpl.innerHTML = itemRow(it ? { id: tickerItemId(), label: "", text: "", ...it } : undefined, true).trim();
    const li = tpl.content.firstElementChild;
    if (after) after.after(li); else list.append(li);
    grow(textOf(li));
    if (focus === "text") caretTo(textOf(li), 0);
    else if (focus === "label") caretTo(labelOf(li), "end");
    refresh();
    return li;
  };

  const remove = (li, focusPrev = true) => {
    const prev = li.previousElementSibling, next = li.nextElementSibling;
    li.remove();
    if (!list.children.length) insert(null, null, null); // zawsze zostaje jeden wiersz do pisania
    const to = (focusPrev ? prev ?? next : next ?? prev) ?? list.firstElementChild;
    if (to) caretTo(textOf(to), focusPrev && prev ? "end" : 0);
    refresh();
  };

  const move = (li, dir, keep) => {
    if (dir < 0 && li.previousElementSibling) li.previousElementSibling.before(li);
    else if (dir > 0 && li.nextElementSibling) li.nextElementSibling.after(li);
    else return;
    li.classList.remove("sr-item-moved"); void li.offsetWidth; li.classList.add("sr-item-moved");
    keep?.focus();
    refresh();
  };

  addBtn?.addEventListener("click", () => {
    // pusty ostatni wiersz: nie dokładaj kolejnego, tylko przejdź do niego
    const last = list.lastElementChild;
    if (last && !textOf(last).value.trim() && !labelOf(last).value.trim()) return caretTo(textOf(last), 0);
    insert(list.lastElementChild, null);
  });

  list.addEventListener("click", (ev) => {
    const btn = ev.target.closest('[data-sr="item-remove"]');
    const li = btn?.closest(".sr-item");
    if (li) remove(li);
    // klik w pusty obszar wiersza (poza polami) → do tekstu
    const row = ev.target.closest(".sr-item");
    if (row && !btn && ev.target === row) caretTo(textOf(row), "end");
  });

  /* wartości pól tekstu znane obsłudze „ETYKIETA | tekst” (zmiany ze skryptu też tu trafiają przez sync) */
  const seen = new WeakMap(); // pole tekstu → wartość po ostatnim przetworzeniu
  const prevOf = (ta) => (seen.has(ta) ? seen.get(ta) : ta.defaultValue);
  const sync = (ta) => seen.set(ta, ta.value);
  const setCaret = (ta, p) => { if (document.activeElement === ta) try { ta.setSelectionRange(p, p); } catch { /* */ } };

  list.addEventListener("keydown", (ev) => {
    const el = ev.target, li = el.closest?.(".sr-item");
    if (!li || !(el.matches("input, textarea"))) return;
    if (ev.isComposing || ev.keyCode === 229) return; // Enter / strzałki w trakcie składania IME należą do IME
    const isText = el.classList.contains("sr-item-text");
    const lab = labelOf(li), ta = textOf(li);
    const at0 = el.selectionStart === 0 && el.selectionEnd === 0;
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
    const prev = li.previousElementSibling, next = li.nextElementSibling;

    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { // Ctrl+Enter: zastosuj (zapis bez zamykania; na antenie — od razu u wszystkich)
      ev.preventDefault();
      root.querySelector('[data-action="applyLive"]')?.click();
      return;
    }
    if (ev.altKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) { // Alt+↑/↓: przestaw wiadomość
      ev.preventDefault();
      return move(li, ev.key === "ArrowUp" ? -1 : 1, el);
    }
    if (ev.key === "Enter") {
      ev.preventDefault(); // Enter nie wysyła (i nie zamyka) formularza
      if (!isText) return caretTo(ta, "end");
      // podział w miejscu kursora: to, co za kursorem, idzie do nowej wiadomości (na końcu — pusta nowa)
      const before = ta.value.slice(0, ta.selectionStart).trimEnd(), after = ta.value.slice(ta.selectionEnd).trimStart();
      if (!before && !after && !lab.value.trim()) return; // pusty wiersz: nie mnóż pustych
      ta.value = before; sync(ta); grow(ta);
      li._srSlug = null;
      insert(li, { text: after }, "text");
      return;
    }
    if (ev.key === "Backspace" && at0) {
      if (!isText) { // pusta etykieta i pusty tekst → usuń wiersz
        if (!lab.value && !ta.value && list.children.length > 1) { ev.preventDefault(); remove(li); }
        return;
      }
      ev.preventDefault();
      const undo = li._srSlug;
      if (undo?.fresh && !ta.value.trim()) { // tuż po „ETYKIETA |”: Backspace kasuje kreskę i cofa zamianę
        li._srSlug = null;
        lab.value = undo.label;
        ta.value = undo.typed.slice(0, undo.bar) + undo.typed.slice(undo.bar + 1);
        sync(ta); grow(ta);
        caretTo(ta, "end");
        refresh();
        return;
      }
      if (lab.value) return caretTo(lab, "end"); // najpierw cofamy się do rubryki z etykietą
      if (!ta.value && list.children.length > 1) return remove(li);
      if (prev) { // połącz z poprzednią
        const pt = textOf(prev), join = pt.value.length + (pt.value && ta.value ? 1 : 0);
        pt.value = (pt.value && ta.value ? `${pt.value} ${ta.value}` : pt.value + ta.value).slice(0, TICKER_LIMITS.text);
        sync(pt); grow(pt);
        li.remove();
        caretTo(pt, Math.min(join, pt.value.length));
        refresh();
      }
      return;
    }
    if (ev.key === "Delete" && isText && atEnd && next) { // połącz z następną
      ev.preventDefault();
      const nt = textOf(next), nl = labelOf(next), at = ta.value.length;
      if (!lab.value && nl.value) lab.value = nl.value;
      ta.value = (ta.value && nt.value ? `${ta.value} ${nt.value}` : ta.value + nt.value).slice(0, TICKER_LIMITS.text);
      sync(ta); grow(ta);
      next.remove();
      caretTo(ta, at);
      refresh();
      return;
    }
    // ↑/↓ na brzegu tekstu: do sąsiedniej wiadomości (jak między akapitami); w etykietach — po kolumnie etykiet
    if (ev.key === "ArrowUp" && prev && (at0 || !isText)) {
      ev.preventDefault();
      return isText ? caretTo(textOf(prev), "end") : caretTo(labelOf(prev), "end");
    }
    if (ev.key === "ArrowDown" && next && (atEnd || !isText)) {
      ev.preventDefault();
      return isText ? caretTo(textOf(next), 0) : caretTo(labelOf(next), "end");
    }
  });

  /* ---- „ETYKIETA | tekst” wpisane wprost w tekst (klawisz po klawiszu, jednym wstawieniem, autouzupełnieniem, upuszczeniem,
     po zatwierdzeniu IME). Rozpoznajemy PRZEJŚCIE: poprzednia wartość nie zaczynała się od „ETYKIETA |”, nowa tak — wtedy
     etykieta trafia do rubryki (zastępuje dotychczasową: to jawne polecenie użytkownika), a reszta zostaje tekstem.
     Nic wpisanego nie ginie: kursor zostaje w tym samym miejscu treści (nie skacze na początek), a Backspace tuż po
     zamianie cofa ją. Tekst zastany z kreską (np. „Wynik 2 | 1” wczytany z presetu) nie jest ruszany przy zwykłej edycji. */
  const process = (ta) => {
    const li = ta.closest(".sr-item"), lab = labelOf(li);
    if (!li || !lab) return;
    let caret = ta.selectionEnd ?? ta.value.length;
    if (/[\r\n]/.test(ta.value)) { // wklejone / upuszczone nowe linie → spacje (kursor w tym samym miejscu treści)
      caret = flat(ta.value.slice(0, caret)).length;
      ta.value = flat(ta.value);
      setCaret(ta, caret);
    }
    const s = slugOf(ta.value);
    if (s && !slugOf(prevOf(ta))) {
      const v = ta.value, rest = v.slice(s.bar + 1), text = rest.trimStart();
      const cut = v.length - text.length; // etykieta + kreska + odstęp
      li._srSlug = { label: lab.value, typed: v, bar: s.bar, fresh: !text.trim() }; // do cofnięcia Backspace’em tuż po zamianie
      lab.value = s.label;
      ta.value = text;
      setCaret(ta, Math.max(0, caret - cut));
      li.classList.remove("sr-item-slugged"); void li.offsetWidth; li.classList.add("sr-item-slugged");
    } else if (li._srSlug?.fresh) {
      // zaraz po „ETYKIETA |”: spacje pisane przed treścią nie zostają w tekście (wiadomość zaczyna się od treści)
      const text = ta.value.trimStart(), cut = ta.value.length - text.length;
      if (cut) { ta.value = text; setCaret(ta, Math.max(0, caret - cut)); }
      if (text) li._srSlug = null;
    } else if (li._srSlug && ta.value !== prevOf(ta)) li._srSlug = null;
    sync(ta);
    grow(ta);
    refresh();
  };

  // nasłuch w fazie przechwytywania: łapie też zdarzenia „input” bez bąbelkowania (wysyłane skryptami, rozszerzeniami)
  list.addEventListener("input", (ev) => {
    const ta = ev.target.closest?.(".sr-item-text");
    if (!ta) return refresh();
    if (ev.isComposing) { grow(ta); return; } // IME w trakcie składania — przetwarzamy po zatwierdzeniu
    process(ta);
  }, { capture: true });
  list.addEventListener("compositionend", (ev) => { const ta = ev.target.closest?.(".sr-item-text"); if (ta) process(ta); }, { capture: true });
  // wartość ustawiona skryptem + „change” (bez „input”)
  list.addEventListener("change", (ev) => { const ta = ev.target.closest?.(".sr-item-text"); if (ta && ta.value !== prevOf(ta)) process(ta); }, { capture: true });
  list.addEventListener("focusout", (ev) => { const li = ev.target.closest?.(".sr-item"); if (li && !li.contains(ev.relatedTarget)) li._srSlug = null; });

  list.addEventListener("paste", (ev) => {
    const el = ev.target.closest?.("input, textarea"), li = el?.closest(".sr-item");
    const txt = ev.clipboardData?.getData("text/plain") ?? "";
    if (!li || !/\r?\n/.test(txt.trim())) return; // jedna linia: zwykłe wklejenie
    ev.preventDefault();
    const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(parseLine).filter((x) => x.text);
    if (!lines.length) return;
    let at = li;
    const lab = labelOf(li), ta = textOf(li);
    // bieżący pusty wiersz przyjmuje pierwszą linię
    if (!lab.value.trim() && !ta.value.trim()) { const f = lines.shift(); lab.value = f.label; ta.value = f.text; sync(ta); grow(ta); }
    for (const it of lines) { const n = insert(at, it, null); if (!n) break; at = n; }
    caretTo(textOf(at), "end");
    refresh();
  });

  /* ---- przeciąganie uchwytem (wskaźnik; przerwanie gestu zawsze sprząta) */
  let drag = null;
  const endDrag = () => {
    if (!drag) return;
    const { li, grip, id } = drag;
    drag = null;
    li.classList.remove("sr-dragging");
    li.style.transform = "";
    list.classList.remove("sr-list-dragging");
    try { if (grip.hasPointerCapture(id)) grip.releasePointerCapture(id); } catch { /* */ }
    refresh();
  };
  list.addEventListener("pointerdown", (ev) => {
    const grip = ev.target.closest('[data-sr="grip"]');
    if (!grip || ev.button !== 0 || drag) return;
    ev.preventDefault();
    const li = grip.closest(".sr-item");
    drag = { li, grip, id: ev.pointerId, y0: ev.clientY, top0: li.getBoundingClientRect().top, ty: 0 };
    grip.setPointerCapture(ev.pointerId);
    li.classList.add("sr-dragging");
    list.classList.add("sr-list-dragging");
  });
  const dragTo = (y) => {
    const { li } = drag;
    // przestaw, gdy środek przeciąganego wiersza minie środek sąsiada
    const r = li.getBoundingClientRect();
    const mid = drag.top0 + (y - drag.y0) + r.height / 2;
    // pętla: szybki ruch (albo pojedynczy skok wskaźnika) może minąć kilka wierszy naraz.
    // Przenosimy SĄSIADA, nie przeciągany wiersz: wyjęcie elementu z dokumentu zdejmuje przechwycenie wskaźnika i urywa gest.
    for (let p = li.previousElementSibling; p; p = li.previousElementSibling) { const b = p.getBoundingClientRect(); if (mid < b.top + b.height / 2) li.after(p); else break; }
    for (let n = li.nextElementSibling; n; n = li.nextElementSibling) { const b = n.getBoundingClientRect(); if (mid > b.top + b.height / 2) li.before(n); else break; }
    const layoutTop = li.getBoundingClientRect().top - drag.ty; // miejsce w układzie (bez bieżącego przesunięcia)
    drag.ty = drag.top0 + (y - drag.y0) - layoutTop;
    li.style.transform = `translateY(${drag.ty}px)`;
  };
  list.addEventListener("pointermove", (ev) => { if (drag && ev.pointerId === drag.id) dragTo(ev.clientY); });
  // puszczenie liczy się jak ostatni ruch (wskaźnik mógł przeskoczyć bez zdarzenia „move” w miejscu upuszczenia)
  list.addEventListener("pointerup", (ev) => { if (drag && ev.pointerId === drag.id) dragTo(ev.clientY); endDrag(); });
  list.addEventListener("pointercancel", endDrag);
  list.addEventListener("lostpointercapture", endDrag);
  // okno przeglądarki traci fokus w trakcie przeciągania → sprzątnij (nasłuch z poprzedniego renderu zdjęty na początku)
  const ctl = root._srItemsAbort = new AbortController();
  window.addEventListener("blur", endDrag, { signal: ctl.signal });

  // akcent z pola koloru barwi etykiety w scenariuszu (jak na pasku)
  const accent = root.querySelector('[name="ticker.accent"]');
  accent?.addEventListener("input", () => set?.style.setProperty("--sr-accent", accent.value));

  for (const li of rows()) grow(textOf(li));
  // pole tekstu jest jeszcze niewidoczne (okno w trakcie otwierania) — dopasuj wysokości po pierwszej klatce
  requestAnimationFrame(() => { for (const li of rows()) grow(textOf(li)); });
  let seenW = 0;
  const ro = new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (!w || w === seenW) return; // pokazanie albo zmiana szerokości okna (zawijanie) — nie wzrost wysokości po grow
    seenW = w;
    for (const li of rows()) grow(textOf(li));
  });
  ro.observe(list);
  ctl.signal.addEventListener("abort", () => ro.disconnect());
  refresh();
  return () => ctl.abort();
}
