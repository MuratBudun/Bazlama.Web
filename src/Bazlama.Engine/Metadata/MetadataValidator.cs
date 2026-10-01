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
            foreach (var c in entity.List?.Columns ?? [])
                if (entity.Field(c) is null) e.Add($"{at}: listedeki alan bulunamadı: '{c}'.");
            if (entity.List?.SortField is { } sort && entity.Field(sort) is null && sort is not ("created_at" or "updated_at"))
                e.Add($"{at}: sıralama alanı bulunamadı: '{sort}'.");
            foreach (var s in entity.Form?.Sections ?? [])
                foreach (var f in s.Fields)
                    if (entity.Field(f) is null) e.Add($"{at}: formdaki alan bulunamadı: '{f}'.");
        }
        return e;
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

    public static IReadOnlyList<string> EffectiveListColumns(this EntityDefinition entity) =>
        entity.List?.Columns is { Count: > 0 } c ? c : [.. entity.Fields.Where(f => f.Type != FieldType.LongText).Take(6).Select(f => f.Key)];

    public static IReadOnlyList<FormSection> EffectiveFormSections(this EntityDefinition entity) =>
        entity.Form?.Sections is { Count: > 0 } s ? s : [new FormSection { Fields = [.. entity.Fields.Select(f => f.Key)] }];

    public static IEnumerable<EntityDefinition> Children(this AppDefinition app, EntityDefinition entity) =>
        app.Entities.Where(e => e.Parent == entity.Key);

    public static string TableName(this AppDefinition app, EntityDefinition entity) => $"app_{app.Key}_{entity.Key}";
}
