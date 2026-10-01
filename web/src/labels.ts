import type { DataGridLabels, PaginationLabels, PasswordLabels } from "@bazlama/headless"

// Turkish texts for the components (their defaults are English).

export const PASSWORD_TR: Partial<PasswordLabels> = {
  show: "Parolayı göster",
  hide: "Parolayı gizle",
  capsLock: "Caps Lock açık",
  strength: ["Çok zayıf", "Zayıf", "Orta", "İyi", "Güçlü"],
}

export const GRID_TR: Partial<DataGridLabels> = {
  selectAll: "Tüm satırları seç",
  selectRow: "Satırı seç",
  columnMenu: (h) => `Sütun menüsü: ${h}`,
  resize: (h) => `${h} genişliği`,
  sortAsc: "Artan sırala",
  sortDesc: "Azalan sırala",
  clearSort: "Sıralamayı kaldır",
  pin: "Sabitle",
  pinStart: "Başa sabitle",
  pinEnd: "Sona sabitle",
  unpin: "Sabit değil",
  moveLeft: "Sola taşı",
  moveRight: "Sağa taşı",
  autosize: "İçeriğe sığdır",
  hide: "Sütunu gizle",
  columns: "Sütunlar",
  reset: "Varsayılana dön",
  empty: "Kayıt yok",
}

export const PAGINATION_TR: Partial<PaginationLabels> = {
  nav: "Sayfalama",
  first: "İlk sayfa",
  previous: "Önceki sayfa",
  next: "Sonraki sayfa",
  last: "Son sayfa",
  page: (n) => `Sayfa ${n}`,
  pageInput: "Sayfa",
  of: (n) => `/ ${n}`,
  pageSize: "Sayfa başına",
  info: (a, b, t) => `${a}–${b} / ${t}`,
  empty: "Kayıt yok",
}
