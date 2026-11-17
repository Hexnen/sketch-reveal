/* Okno kluczy API — tylko GM. Klucz OpenRouter (wykrywanie świateł AI) to ustawienie klienta zarejestrowane z `config: false`:
   w v14 okno „Konfiguruj ustawienia” chowa przed graczami tylko ustawienia ŚWIATA (`restricted` nic nie robi dla ustawień
   klienta), więc `config: true` pokazywało pole klucza każdemu graczowi. Edycja odbywa się tutaj: menu ustawień zarejestrowane
   z `restricted: true` (niewidoczne bez SETTINGS_MODIFY), pole typu password z przełącznikiem pokaż/ukryj i sprawdzenie GM
   przed każdym renderem. Zapis bez zmian (`sketch-reveal.openrouterKey` w localStorage tej przeglądarki), więc wpisane
   wcześniej klucze dalej działają. Wzór: moinens-ai-gen/scripts/keys-app.mjs. */
import { MODULE_ID } from "./config.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** ustawienia klienta edytowane w tym oknie (kolejność = kolejność w oknie) */
export const KEY_SETTINGS = Object.freeze(["openrouterKey"]);
const APP_ID = `${MODULE_ID}-keys`;

const has = (key) => game.settings.settings.has(`${MODULE_ID}.${key}`);
const get = (key) => { try { return game.settings.get(MODULE_ID, key); } catch { return undefined; } };

export class SketchRevealKeysApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: APP_ID,
    tag: "form",
    classes: ["sr-keys"],
    window: { title: "SKETCHREVEAL.Keys.Title", icon: "fa-solid fa-key", contentClasses: ["standard-form"] },
    position: { width: 520, height: "auto" },
    form: { handler: SketchRevealKeysApp.#onSubmit, closeOnSubmit: true },
    actions: { reveal: SketchRevealKeysApp.#onReveal },
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/keys.hbs` },
  };

  /** Otwórz (albo przenieś na wierzch) okno. Tylko GM; dla innych zwraca null. */
  static open() {
    if (!game.user?.isGM) return null;
    const app = foundry.applications.instances.get(APP_ID) ?? new SketchRevealKeysApp();
    app.render({ force: true });
    return app;
  }

  /** gracz nigdy go nie wyrenderuje, bez względu na to, co je otworzyło (menu jest restricted; to drugi zamek) */
  _canRender(options) {
    if (!game.user?.isGM) return false;
    return super._canRender?.(options);
  }

  async _prepareContext(options) {
    const ctx = await super._prepareContext(options);
    const show = game.i18n.localize("SKETCHREVEAL.Keys.Show");
    const keys = KEY_SETTINGS.filter(has).map((key) => {
      const cfg = game.settings.settings.get(`${MODULE_ID}.${key}`);
      return {
        name: key,
        id: `${this.id}-${key.replace(/\W/g, "-")}`,
        label: game.i18n.localize(cfg?.name ?? key),
        hint: cfg?.hint ? game.i18n.localize(cfg.hint) : "",
        value: String(get(key) ?? ""),
      };
    });
    return Object.assign(ctx, { keys, show });
  }

  /** przycisk z okiem: pokaż / ukryj jeden klucz */
  static #onReveal(event, target) {
    const input = this.element.querySelector(`input[name="${CSS.escape(target.dataset.target ?? "")}"]`);
    if (!input) return;
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    target.setAttribute("aria-pressed", String(reveal));
    target.classList.toggle("fa-eye", !reveal);
    target.classList.toggle("fa-eye-slash", reveal);
  }

  static async #onSubmit(event, form, formData) {
    if (!game.user?.isGM) return;
    const data = formData.object;
    for (const key of KEY_SETTINGS) {
      if (!has(key) || !(key in data)) continue;
      const v = String(data[key] ?? "").trim();
      if (v !== String(get(key) ?? "")) await game.settings.set(MODULE_ID, key, v);
    }
    ui.notifications.info(game.i18n.localize("SKETCHREVEAL.Keys.Saved"));
  }
}

/** Menu ustawień (init): wpis tylko dla GM w „Konfiguruj ustawienia” → ten moduł. */
export function registerKeysMenu() {
  game.settings.registerMenu(MODULE_ID, "keys", {
    name: "SKETCHREVEAL.Keys.MenuName",
    label: "SKETCHREVEAL.Keys.MenuLabel",
    hint: "SKETCHREVEAL.Keys.MenuHint",
    icon: "fa-solid fa-key",
    type: SketchRevealKeysApp,
    restricted: true,
  });
}

export const openKeys = () => SketchRevealKeysApp.open();
