using System.Text.RegularExpressions;

namespace Bazlama.Engine.Metadata;

/// <summary>Checks an app definition before anything is built from it. Messages are for the developer (Turkish).</summary>
public static partial class MetadataValidator
{
    [GeneratedRegex("^[a-z][a-z0-9_]{0,29}$")]
    private static partial Regex Identifier();

    [GeneratedRegex(@"^\d+\.\d+\.\d+$")]
    private static partial Regex SemVer();

    /// <summary>Column names the engine adds to every table.</summary>
    public static readonly IReadOnlySet<string> Reserved = new HashSet<string>
    {
        "id", "company_id", "location_id", "plant_id", "period_id", "parent_id",
        "created_at", "created_by", "updated_at", "updated_by", "is_deleted", "row_version",
    };

    public static IReadOnlyList<string> Validate(AppDefinition app)
    {
        var e = new List<string>();
        // Table names are app_<app>_<entity>: PostgreSQL allows 63 characters.
        if (!Identifier().IsMatch(app.Key ?? "") || app.Key!.Length > 20) e.Add($"App anahtarı geçersiz: '{app.Key}' (küçük harf, rakam ve _; harfle başlar; en fazla 20 karakter).");
        else if (app.PreviewOf is null && app.Key.EndsWith(AppDefinition.PreviewSuffix, StringComparison.Ordinal)) e.Add($"App anahtarı '{AppDefinition.PreviewSuffix}' ile bitemez (önizleme için ayrılmış).");
        if (string.IsNullOrWhiteSpace(app.Name)) e.Add("App adı gerekli.");
        if (!SemVer().IsMatch(app.Version ?? "")) e.Add($"Versiyon geçersiz: '{app.Version}' (örn. 1.0.0).");
        if (app.Entities.Count == 0) e.Add("En az bir entity tanımlanmalı.");

        foreach (var dup in app.Entities.GroupBy(x => x.Key).Where(g => g.Count() > 1))
            e.Add($"Entity anahtarı birden fazla kez kullanılmış: '{dup.Key}'.");

        foreach (var entity in app.Entities)
        {
            var at = $"Entity '{entity.Key}'";
            if (!Identifier().IsMatch(entity.Key ?? "")) e.Add($"{at}: anahtar geçersiz.");
            if (string.IsNullOrWhiteSpace(entity.Name)) e.Add($"{at}: ad gerekli.");
            if (entity.Fields.Count == 0) e.Add($"{at}: en az bir alan tanımlanmalı.");

            if (entity.Parent is { } parent)
            {
                var p = app.Entity(parent);
                if (p is null) e.Add($"{at}: üst entity bulunamadı: '{parent}'.");
                else if (Ancestors(app, entity).Contains(entity.Key!)) e.Add($"{at}: üst entity zinciri kendine dönüyor.");
                else if (entity.Scope != EntityScope.Global && entity.Scope != Root(app, entity).Scope)
                    e.Add($"{at}: detay entity'nin kapsamı üst entity'den gelir; 'scope' yazmayın ya da üsttekiyle aynı yazın.");
            }

            foreach (var dup in entity.Fields.GroupBy(f => f.Key).Where(g => g.Count() > 1))
                e.Add($"{at}: alan anahtarı birden fazla kez kullanılmış: '{dup.Key}'.");

            foreach (var f in entity.Fields)
            {
                var fat = $"{at}, alan '{f.Key}'";
                if (!Identifier().IsMatch(f.Key ?? "")) e.Add($"{fat}: anahtar geçersiz.");
                else if (Reserved.Contains(f.Key!)) e.Add($"{fat}: bu ad sistem kolonu için ayrılmış.");
                if (string.IsNullOrWhiteSpace(f.Label)) e.Add($"{fat}: etiket gerekli.");
                switch (f.Type)
                {
                    case FieldType.Text when f.MaxLength is < 1 or > 4000:
                        e.Add($"{fat}: uzunluk 1 ile 4000 arasında olmalı."); break;
                    case FieldType.Decimal when f.Precision is < 1 or > 28 || f.Scale is < 0 || (f.Scale ?? FieldDefinition.DefaultScale) > (f.Precision ?? FieldDefinition.DefaultPrecision):
                        e.Add($"{fat}: ondalık hassasiyeti geçersiz (precision 1–28, scale ≤ precision)."); break;
                    case FieldType.Choice when f.Choices is null or { Count: 0 }:
                        e.Add($"{fat}: seçim alanının seçenekleri olmalı."); break;
                    case FieldType.Choice when f.Choices!.GroupBy(c => c.Value).Any(g => g.Count() > 1):
                        e.Add($"{fat}: seçenek değerleri tekrar ediyor."); break;
                    case FieldType.Choice when f.Choices!.Any(c => c.Value is null or { Length: 0 or > 50 }):
                        e.Add($"{fat}: seçenek değeri 1–50 karakter olmalı."); break;
                    case FieldType.Reference when f.Reference is null:
                        e.Add($"{fat}: referans alanı hangi entity'yi gösterdiğini belirtmeli ('reference')."); break;
                    case FieldType.Reference when app.Entity(f.Reference!) is null:
                        e.Add($"{fat}: referans verilen entity bulunamadı: '{f.Reference}'."); break;
                    case FieldType.Reference when app.Entity(f.Reference!)!.Parent is not null:
                        e.Add($"{fat}: detay entity'ye referans verilemez ('{f.Reference}')."); break;
                }
            }

            if (entity.TitleField is { } title && entity.Field(title) is null) e.Add($"{at}: başlık alanı bulunamadı: '{title}'.");
        }

        foreach (var dup in app.Forms.GroupBy(x => x.Key).Where(g => g.Count() > 1))
            e.Add($"Form anahtarı birden fazla kez kullanılmış: '{dup.Key}'.");
        foreach (var form in app.Forms)
        {
            var at = $"Form '{form.Key}'";
            if (!Identifier().IsMatch(form.Key ?? "")) e.Add($"{at}: anahtar geçersiz.");
            if (string.IsNullOrWhiteSpace(form.Name)) e.Add($"{at}: ad gerekli.");
            var entity = app.Entity(form.Entity ?? "");
            if (entity is null)
            {
                e.Add($"{at}: entity bulunamadı: '{form.Entity}'.");
                continue;
            }
            if (form.Sections.Count == 0 || form.Sections.All(s => s.Fields.Count == 0)) e.Add($"{at}: en az bir alan içermeli.");
            foreach (var s in form.Sections)
            {
                if (s.Columns is < 1 or > 3) e.Add($"{at}: bölüm sütun sayısı 1 ile 3 arasında olmalı.");
                foreach (var f in s.Fields)
                    if (entity.Field(f) is null) e.Add($"{at}: formdaki alan bulunamadı: '{f}'.");
            }
            foreach (var dup in form.Sections.SelectMany(s => s.Fields).GroupBy(f => f).Where(g => g.Count() > 1))
                e.Add($"{at}: alan formda birden fazla kez var: '{dup.Key}'.");
        }

        foreach (var dup in app.Lists.GroupBy(x => x.Key).Where(g => g.Count() > 1))
            e.Add($"Liste anahtarı birden fazla kez kullanılmış: '{dup.Key}'.");
        foreach (var list in app.Lists)
        {
            var at = $"Liste '{list.Key}'";
            if (!Identifier().IsMatch(list.Key ?? "")) e.Add($"{at}: anahtar geçersiz.");
            if (string.IsNullOrWhiteSpace(list.Name)) e.Add($"{at}: ad gerekli.");
            var entity = app.Entity(list.Entity ?? "");
            if (entity is null)
            {
                e.Add($"{at}: entity bulunamadı: '{list.Entity}'.");
                continue;
            }
            if (list.Columns.Count == 0) e.Add($"{at}: en az bir sütun içermeli.");
            foreach (var c in list.Columns)
                if (entity.Field(c) is null) e.Add($"{at}: listedeki alan bulunamadı: '{c}'.");
            foreach (var dup in list.Columns.GroupBy(c => c).Where(g => g.Count() > 1))
                e.Add($"{at}: sütun birden fazla kez var: '{dup.Key}'.");
            if (list.SortField is { } sort && entity.Field(sort) is null && sort is not ("created_at" or "updated_at"))
                e.Add($"{at}: sıralama alanı bulunamadı: '{sort}'.");
            if (list.Form is { } form && app.Form(form) is not { } f) e.Add($"{at}: form bulunamadı: '{form}'.");
            else if (list.Form is not null && app.Form(list.Form)!.Entity != list.Entity) e.Add($"{at}: form başka bir entity'nin: '{list.Form}'.");
        }

        ValidateMenu(app, app.Menu, 1, e);
        return e;
    }

    /// <summary>Menu depth: groups may hold groups, three levels at most.</summary>
    public const int MenuDepth = 3;

    static void ValidateMenu(AppDefinition app, IReadOnlyList<MenuItem> items, int depth, List<string> e)
    {
        foreach (var item in items)
        {
            var at = $"Menü '{item.Label}'";
            if (string.IsNullOrWhiteSpace(item.Label)) e.Add("Menü: öğe adı gerekli.");
            var targets = (item.Items is not null ? 1 : 0) + (item.List is not null ? 1 : 0) + (item.Form is not null ? 1 : 0);
            if (targets != 1) e.Add($"{at}: bir grup (alt öğeler), bir liste ya da bir form olmalı.");
            if (item.Items is { } children)
            {
                if (depth >= MenuDepth) e.Add($"{at}: menü en fazla {MenuDepth} seviye olabilir.");
                else ValidateMenu(app, children, depth + 1, e);
            }
            if (item.List is { } listKey)
            {
                if (app.List(listKey) is not { } list) e.Add($"{at}: liste bulunamadı: '{listKey}'.");
                else if (app.Entity(list.Entity)?.Parent is not null) e.Add($"{at}: detay entity'nin listesi menüde açılamaz ('{listKey}').");
            }
            if (item.Form is { } formKey)
            {
                if (app.Form(formKey) is not { } form) e.Add($"{at}: form bulunamadı: '{formKey}'.");
                else if (app.Entity(form.Entity)?.Parent is not null) e.Add($"{at}: detay entity'nin formu menüde açılamaz ('{formKey}').");
            }
        }
    }

    static List<string> Ancestors(AppDefinition app, EntityDefinition entity)
    {
        var seen = new List<string>();
        for (var p = entity.Parent; p is not null && app.Entity(p) is { } next && seen.Count <= app.Entities.Count; p = next.Parent)
            seen.Add(p);
        return seen;
    }

    /// <summary>The top of a master–detail chain (itself when it has no parent).</summary>
    public static EntityDefinition Root(AppDefinition app, EntityDefinition entity)
    {
        var current = entity;
        for (var i = 0; current.Parent is { } p && app.Entity(p) is { } parent && i < app.Entities.Count; i++) current = parent;
        return current;
    }
}

/// <summary>Defaults filled in: what the engine and the UI actually use.</summary>
public static class MetadataExtensions
{
    /// <summary>Details inherit the scope and period binding of their master.</summary>
    public static EntityScope EffectiveScope(this AppDefinition app, EntityDefinition entity) => MetadataValidator.Root(app, entity).Scope;

    public static bool EffectivePeriodBound(this AppDefinition app, EntityDefinition entity) => MetadataValidator.Root(app, entity).PeriodBound;

    public static string? EffectiveTitleField(this EntityDefinition entity) =>
        entity.TitleField ?? entity.Fields.FirstOrDefault(f => f.Type == FieldType.Text)?.Key ?? entity.Fields.FirstOrDefault()?.Key;

    /// <summary>The entity's first list (the detail grids and default sorting use it), if it has one.</summary>
    public static ListDefinition? DefaultList(this AppDefinition app, EntityDefinition entity) =>
        app.Lists.FirstOrDefault(l => l.Entity == entity.Key);


    public static IEnumerable<EntityDefinition> Children(this AppDefinition app, EntityDefinition entity) =>
        app.Entities.Where(e => e.Parent == entity.Key);

    public static string TableName(this AppDefinition app, EntityDefinition entity) => $"app_{app.Key}_{entity.Key}";
}
