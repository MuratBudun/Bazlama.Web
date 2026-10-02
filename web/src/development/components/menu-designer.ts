import { computed, define, flush, html, prop, signal, untrack } from "@bazlama/core"
import { collectIds, icon, type TreeItem } from "@bazlama/headless"
import { defaultColumns, plural, type AppDef, type MenuItemDef } from "../../runtime/api"
import type { DraftStore } from "../draft"

/*
 * <bazlama-menu-designer .store=${draft}> — the app's menu in Runtime: groups and items that
 * open a list or a new record's form. The tree on the left is the menu as users will see it;
 * the panel on the right edits the selected entry.
 *
 * Entries have no keys: they are addressed by their path ("1.0" = the first item of the
 * second entry). A move changes the path, so the selection follows it.
 */

/** Groups may hold groups; Runtime (MetadataValidator.MenuDepth) allows three levels. */
const MAX_DEPTH = 3

type Path = number[]
const pathOf = (id: string): Path => (id === "" ? [] : id.split(".").map(Number))
const idOf = (p: Path) => p.join(".")

function at(menu: MenuItemDef[], p: Path): MenuItemDef | undefined {
  let list = menu
  let item: MenuItemDef | undefined
  for (const i of p) {
    item = list[i]
    if (!item) return undefined
    list = item.items ?? []
  }
  return item
}
/** The array holding the entry at `p`. */
function siblings(menu: MenuItemDef[], p: Path): MenuItemDef[] {
  return p.length === 1 ? menu : (at(menu, p.slice(0, -1))!.items ??= [])
}
const depthOf = (m: MenuItemDef): number => (m.items ? 1 + Math.max(0, ...m.items.map(depthOf)) : 1)

export const MenuDesigner = define("bazlama-menu-designer", {
  props: {
    store: prop.object<DraftStore | null>(null),
  },
  setup(props, { host }) {
    const store = props.store.peek()
    if (!store) return null
    const menu = () => store.def()?.menu ?? []
    const def = () => store.def()!

    const selected = signal("")
    const shown = signal(0)
    const select = (id: string) => {
      if (id === selected.peek()) return
      selected.set(id)
      shown.update((n) => n + 1)
    }
    const current = () => (selected() ? at(menu(), pathOf(selected())) : undefined)

    const edit = (fn: (menu: MenuItemDef[], a: AppDef) => void) =>
      store.update((a) => {
        a.menu ??= []
        fn(a.menu, a)
      })
    const editCurrent = (fn: (m: MenuItemDef) => void) => {
      const p = pathOf(selected.peek())
      edit((m) => fn(at(m, p)!))
    }

    /** Lists and forms a menu entry may open: those of master entities (details need their master). */
    const masters = () => new Set(def().entities.filter((e) => !e.parent).map((e) => e.key))
    const lists = () => (def().lists ?? []).filter((l) => masters().has(l.entity))
    const forms = () => (def().forms ?? []).filter((f) => masters().has(f.entity))
    const entityName = (key: string) => def().entities.find((e) => e.key === key)?.name ?? key
    const targetText = (m: MenuItemDef) => {
      if (m.items) return `${m.items.length} öğe`
      if (m.list) {
        const l = def().lists?.find((x) => x.key === m.list)
        return l ? `Liste: ${l.name}` : `Liste bulunamadı: ${m.list}`
      }
      if (m.form) {
        const f = def().forms?.find((x) => x.key === m.form)
        return f ? `Yeni kayıt: ${f.name}` : `Form bulunamadı: ${m.form}`
      }
      return "Hedef seçilmedi"
    }

    // ── Operations ─────────────────────────────────────────────────────
    /** Adds after the selection (or into the selected group); selects the new entry. */
    const add = (item: MenuItemDef) => {
      const p = pathOf(selected.peek())
      const sel = p.length ? at(menu(), p) : undefined
      let target: Path
      edit((m) => {
        if (sel?.items && p.length < MAX_DEPTH) {
          const items = (at(m, p)!.items ??= [])
          items.push(item)
          target = [...p, items.length - 1]
        } else if (p.length) {
          siblings(m, p).splice(p[p.length - 1] + 1, 0, item)
          target = [...p.slice(0, -1), p[p.length - 1] + 1]
        } else {
          m.push(item)
          target = [m.length - 1]
        }
      })
      select(idOf(target!))
      flush()
      const label = host.querySelector<HTMLInputElement>("[data-focus=label] input")
      label?.focus()
      label?.select()
    }
    const addItem = () => {
      const l = lists()[0]
      add(l ? { label: l.name, list: l.key } : { label: "Yeni öğe" })
    }
    const addGroup = () => add({ label: "Yeni grup", items: [] })
    const move = (by: number) => {
      const p = pathOf(selected.peek())
      const i = p[p.length - 1]
      const list = siblings(menu(), p)
      if (i + by < 0 || i + by >= list.length) return
      edit((m) => {
        const s = siblings(m, p)
        ;[s[i], s[i + by]] = [s[i + by], s[i]]
      })
      selected.set(idOf([...p.slice(0, -1), i + by]))
    }
    /** Into the group just above (as its last entry). */
    const indent = () => {
      const p = pathOf(selected.peek())
      const i = p[p.length - 1]
      const above = siblings(menu(), p)[i - 1]
      const item = at(menu(), p)
      if (!above?.items || !item || p.length + depthOf(item) > MAX_DEPTH) return
      edit((m) => {
        const s = siblings(m, p)
        const [moved] = s.splice(i, 1)
        s[i - 1].items!.push(moved)
      })
      selected.set(idOf([...p.slice(0, -1), i - 1, above.items.length]))
    }
    /** Out of its group, right after it. */
    const outdent = () => {
      const p = pathOf(selected.peek())
      if (p.length < 2) return
      edit((m) => {
        const [moved] = siblings(m, p).splice(p[p.length - 1], 1)
        siblings(m, p.slice(0, -1)).splice(p[p.length - 2] + 1, 0, moved)
      })
      selected.set(idOf([...p.slice(0, -2), p[p.length - 2] + 1]))
    }
    const remove = () => {
      const p = pathOf(selected.peek())
      if (!p.length) return
      edit((m) => void siblings(m, p).splice(p[p.length - 1], 1))
      const left = siblings(menu(), p).length
      const i = p[p.length - 1]
      select(left ? idOf([...p.slice(0, -1), Math.min(i, left - 1)]) : idOf(p.slice(0, -1)))
    }
    /** The menu Runtime shows without one: an item per master entity, opening its first list (made when missing). */
    const fromDefault = () => {
      edit((m, a) => {
        a.lists ??= []
        for (const e of a.entities.filter((x) => !x.parent)) {
          let l = a.lists.find((x) => x.entity === e.key)
          if (!l) {
            let key = e.key
            for (let i = 2; a.lists.some((x) => x.key === key); i++) key = `${e.key}_${i}`
            l = { key, name: plural(e), entity: e.key, columns: defaultColumns(e) }
            a.lists.push(l)
          }
          m.push({ label: plural(e), icon: e.icon, list: l.key })
        }
      })
      select("0")
    }

    // ── Tree ───────────────────────────────────────────────────────────
    const tree = computed<TreeItem[]>(() => {
      const items = (list: MenuItemDef[], prefix: Path): TreeItem[] =>
        list.map((m, i) => {
          const p = [...prefix, i]
          return {
            id: idOf(p),
            label: m.label || "(adsız)",
            icon: m.icon || (m.items ? "folder" : m.form ? "plus" : "list"),
            children: m.items ? items(m.items, p) : undefined,
          }
        })
      return items(menu(), [])
    })
    const expanded = computed(() => collectIds(tree()))
    const path = () => pathOf(selected())
    const can = {
      up: () => path().length > 0 && path()[path().length - 1] > 0,
      down: () => path().length > 0 && path()[path().length - 1] < siblings(menu(), path()).length - 1,
      indent: () => {
        const p = path()
        if (!p.length) return false
        const above = siblings(menu(), p)[p[p.length - 1] - 1]
        const item = current()
        return !!above?.items && !!item && p.length + depthOf(item) <= MAX_DEPTH
      },
      outdent: () => path().length > 1,
    }

    // ── Properties ─────────────────────────────────────────────────────
    const properties = () => {
      const m = current()
      if (!m) return html`<div class="ee-props"><p class="muted">Düzenlemek için menüden bir öğe seçin.</p></div>`
      const kind = m.items ? "group" : m.form ? "form" : "list"
      const target = signal<"list" | "form">(kind === "form" ? "form" : "list")
      return html`<div class="ee-props">
        <h3>${kind === "group" ? "Grup" : "Menü öğesi"}</h3>
        <bz-input label="Etiket" required data-focus="label" .value=${m.label}
          @input=${(ev: Event) => editCurrent((x) => (x.label = (ev.currentTarget as HTMLInputElement).value))}></bz-input>
        <bz-input label="İkon" hint="Örn. cart, users, box (boş: türüne göre)" .value=${m.icon ?? ""}
          @input=${(ev: Event) => editCurrent((x) => (x.icon = (ev.currentTarget as HTMLInputElement).value.trim() || undefined))}></bz-input>
        ${kind === "group"
          ? html`<p class="muted small">Grubun öğeleri gezginde altında durur. Öğe eklemek için grubu seçip "Öğe ekle"ye basın.</p>`
          : html`
            <bz-radio-group label="Açtığı" .value=${target} @change=${(ev: CustomEvent<{ value: string }>) => {
              const next = ev.detail.value as "list" | "form"
              target.set(next)
              editCurrent((x) => {
                if (next === "form") ((x.list = undefined), (x.form = forms()[0]?.key))
                else ((x.form = undefined), (x.list = lists()[0]?.key))
              })
            }}>
              <bz-radio value="list">Liste</bz-radio>
              <bz-radio value="form">Yeni kayıt formu</bz-radio>
            </bz-radio-group>
            ${() =>
              target() === "form"
                ? html`<bz-combobox label="Form" .value=${current()?.form ?? ""} @change=${(ev: CustomEvent<{ value: string }>) => editCurrent((x) => (x.form = ev.detail.value || undefined))}>
                    ${forms().map((f) => html`<bz-option value=${f.key}>${f.name} (${entityName(f.entity)})</bz-option>`)}
                  </bz-combobox>`
                : html`<bz-combobox label="Liste" .value=${current()?.list ?? ""} @change=${(ev: CustomEvent<{ value: string }>) => editCurrent((x) => (x.list = ev.detail.value || undefined))}>
                    ${lists().map((l) => html`<bz-option value=${l.key}>${l.name} (${entityName(l.entity)})</bz-option>`)}
                  </bz-combobox>`}
            ${() => (lists().length || forms().length ? null : html`<bz-alert>Henüz liste ya da form yok: gezginden ekleyin.</bz-alert>`)}`}
        <p class="muted small">${() => (current() ? targetText(current()!) : "")}</p>
      </div>`
    }

    const errors = () => store.errors().filter((e) => e.startsWith("Menü"))
    const body = () => html`
      <div class="ee-head">
        ${icon("menu", { size: 20 })}<h1>Menü</h1><span class="muted small">Runtime'da uygulamanın menüsü</span>
      </div>
      ${() =>
        errors().length
          ? html`<bz-alert variant="warning" heading=${`Yayınlamadan önce düzeltilmeli (${errors().length})`}><ul class="errors">${errors().map((e) => html`<li>${e}</li>`)}</ul></bz-alert>`
          : null}
      <bz-split class="ee-split" primary="end" size="380" min="280" persist="bazlama-menu-props" label="Özellikler panelini boyutlandır">
        <section class="ee-fields" aria-label="Menü">
          <bz-toolbar label="Menü">
            <bz-button size="sm" @click=${addItem}>${icon("plus")} Öğe ekle</bz-button>
            <bz-button size="sm" @click=${addGroup}>${icon("folder")} Grup ekle</bz-button>
            <bz-toolbar-separator></bz-toolbar-separator>
            <bz-button size="sm" variant="ghost" aria-label="Yukarı taşı" data-tooltip="Yukarı" ?disabled=${() => !can.up()} @click=${() => move(-1)}>${icon("chevron-up")}</bz-button>
            <bz-button size="sm" variant="ghost" aria-label="Aşağı taşı" data-tooltip="Aşağı" ?disabled=${() => !can.down()} @click=${() => move(1)}>${icon("chevron-down")}</bz-button>
            <bz-button size="sm" variant="ghost" aria-label="Üstteki gruba al" data-tooltip="Üstteki gruba al" ?disabled=${() => !can.indent()} @click=${indent}>${icon("chevron-right")}</bz-button>
            <bz-button size="sm" variant="ghost" aria-label="Gruptan çıkar" data-tooltip="Gruptan çıkar" ?disabled=${() => !can.outdent()} @click=${outdent}>${icon("chevron-left")}</bz-button>
            <bz-button size="sm" variant="ghost" aria-label="Kaldır" data-tooltip="Kaldır" ?disabled=${() => !selected()} @click=${remove}>${icon("trash")}</bz-button>
          </bz-toolbar>
          ${() =>
            menu().length
              ? null
              : html`<div class="ee-props">
                  <bz-alert>Menü tanımlı değil: Runtime her ana entity için ilk listesini açan bir öğe gösterir.</bz-alert>
                  <div><bz-button @click=${fromDefault}>${icon("menu")} Varsayılandan başla</bz-button></div>
                </div>`}
          <bz-tree label="Menü" selection="single" class="md-tree" .items=${tree} .value=${selected} .expanded=${expanded}
            @select=${(e: CustomEvent<{ id: string }>) => select(e.detail.id)}></bz-tree>
        </section>
        <section class="ee-inspector" aria-label="Özellikler">
          ${() => {
            shown()
            return untrack(properties)
          }}
        </section>
      </bz-split>`

    // Built once while the draft is loaded: typing must not rebuild the tab.
    const loaded = computed(() => store.def() !== null)
    return html`${() => (loaded() ? untrack(body) : null)}`
  },
})
