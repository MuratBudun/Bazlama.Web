using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Bazlama.Engine.Metadata;

/*
 * An app's metadata: what the designers (Faz 4) will produce and what an app package
 * carries. Keys are lower-case identifiers (a–z, 0–9, _) and become table and column names.
 */

public sealed class AppDefinition
{
    public required string Key { get; init; }
    public required string Name { get; init; }
    /// <summary>Semantic version, e.g. "1.0.0".</summary>
    public required string Version { get; init; }
    public string? Description { get; init; }
    public string? Icon { get; init; }
    public IReadOnlyList<EntityDefinition> Entities { get; init; } = [];
    /// <summary>Record forms. An entity may have several, or none (then all its fields in one section).</summary>
    public IReadOnlyList<FormDefinition> Forms { get; init; } = [];
    /// <summary>Record lists. An entity may have several, or none (then its first six fields, newest first).</summary>
    public IReadOnlyList<ListDefinition> Lists { get; init; } = [];
    /// <summary>The app's menu: groups and items that open a list or a new record's form. Empty: one item per master entity.</summary>
    public IReadOnlyList<MenuItem> Menu { get; init; } = [];

    /// <summary>A preview of this app's draft (not stored in JSON): its key is <see cref="PreviewKey"/>.</summary>
    [JsonIgnore]
    public string? PreviewOf { get; init; }

    /// <summary>The key a preview of an app runs under (tables app_&lt;key&gt;_pv_…). App keys may not end like it.</summary>
    public static string PreviewKey(string appKey) => $"{appKey}{PreviewSuffix}";
    public const string PreviewSuffix = "_pv";

    /// <summary>This definition as the preview of its app: same content, the preview key.</summary>
    public AppDefinition AsPreview() => new()
    {
        Key = PreviewKey(Key),
        Name = Name,
        Version = Version,
        Description = Description,
        Icon = Icon,
        Entities = Entities,
        Forms = Forms,
        Lists = Lists,
        Menu = Menu,
        PreviewOf = Key,
    };

    /// <summary>The same preview without entities: comparing to it drops every table.</summary>
    public AppDefinition AsPreviewWithout() => new() { Key = Key, Name = Name, Version = Version, PreviewOf = PreviewOf };

    public EntityDefinition? Entity(string key) => Entities.FirstOrDefault(e => e.Key == key);
    public FormDefinition? Form(string key) => Forms.FirstOrDefault(f => f.Key == key);
    public ListDefinition? List(string key) => Lists.FirstOrDefault(l => l.Key == key);

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public static AppDefinition Parse(string json) =>
        JsonSerializer.Deserialize<AppDefinition>(Upgrade(json), Json) ?? throw new JsonException("Boş tanım.");

    /// <summary>
    /// Older definitions kept one form and one list inside each entity (<c>entities[].form</c>,
    /// <c>entities[].list</c>). They become app forms and lists keyed like their entity, so
    /// installed versions, packages and drafts still read. Anything else (including invalid JSON)
    /// is returned unchanged.
    /// </summary>
    public static string Upgrade(string json)
    {
        JsonNode? root;
        try
        {
            root = JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            return json;
        }
        if (root is not JsonObject app || app["entities"] is not JsonArray entities) return json;
        var moved = false;
        foreach (var entity in entities.OfType<JsonObject>())
        {
            var key = entity["key"] is JsonValue k && k.TryGetValue<string>(out var text) ? text : null;
            var name = entity["name"] is JsonValue n && n.TryGetValue<string>(out var t) ? t : key;
            if (entity.TryGetPropertyValue("form", out var form))
            {
                entity.Remove("form");
                moved = true;
                if (form is JsonObject old && key is not null)
                    AddOnce(app, "forms", key, new JsonObject
                    {
                        ["key"] = key,
                        ["name"] = name,
                        ["entity"] = key,
                        ["sections"] = old["sections"]?.DeepClone() ?? new JsonArray(),
                    });
            }
            if (entity.TryGetPropertyValue("list", out var list))
            {
                entity.Remove("list");
                moved = true;
                if (list is JsonObject old && key is not null)
                {
                    var plural = entity["pluralName"] is JsonValue p && p.TryGetValue<string>(out var pl) ? pl : name;
                    var upgraded = new JsonObject { ["key"] = key, ["name"] = plural, ["entity"] = key, ["columns"] = old["columns"]?.DeepClone() ?? new JsonArray() };
                    foreach (var prop in new[] { "sortField", "sortDescending" })
                        if (old[prop] is { } v) upgraded[prop] = v.DeepClone();
                    AddOnce(app, "lists", key, upgraded);
                }
            }
        }
        return moved ? app.ToJsonString() : json;
    }

    /// <summary>Adds an item to an app-level array unless one with its key is already there.</summary>
    static void AddOnce(JsonObject app, string array, string key, JsonObject item)
    {
        if (app[array] is not JsonArray items) app[array] = items = [];
        if (items.OfType<JsonObject>().Any(x => x["key"] is JsonValue v && v.TryGetValue<string>(out var k) && k == key)) return;
        items.Add(item);
    }

    public string ToJson() => JsonSerializer.Serialize(this, Json);
}

/// <summary>Where a record belongs; the engine stores and filters by it.</summary>
public enum EntityScope
{
    /// <summary>Shared by the whole installation.</summary>
    Global,
    Company,
    Location,
    Plant,
}

public sealed class EntityDefinition
{
    public required string Key { get; init; }
    /// <summary>Singular title: "Sipariş".</summary>
    public required string Name { get; init; }
    /// <summary>Plural title: "Siparişler" (menus, lists).</summary>
    public string? PluralName { get; init; }
    public string? Icon { get; init; }
    public EntityScope Scope { get; init; } = EntityScope.Global;
    /// <summary>Records belong to a period (the active one) and closed periods are read-only.</summary>
    public bool PeriodBound { get; init; }
    /// <summary>A detail entity: its records belong to a record of this entity (master–detail).</summary>
    public string? Parent { get; init; }
    /// <summary>The field that names a record (references show it). Default: the first text field.</summary>
    public string? TitleField { get; init; }
    public IReadOnlyList<FieldDefinition> Fields { get; init; } = [];

    public FieldDefinition? Field(string key) => Fields.FirstOrDefault(f => f.Key == key);

    [JsonIgnore]
    public string DisplayPlural => PluralName ?? Name;
}

public enum FieldType
{
    Text,
    LongText,
    Integer,
    Decimal,
    Date,
    DateTime,
    Boolean,
    /// <summary>One of <see cref="FieldDefinition.Choices"/> (the value is stored).</summary>
    Choice,
    /// <summary>A record of another entity of the app (<see cref="FieldDefinition.Reference"/>).</summary>
    Reference,
}

public sealed class FieldDefinition
{
    public required string Key { get; init; }
    public required string Label { get; init; }
    public FieldType Type { get; init; } = FieldType.Text;
    public bool Required { get; init; }
    public string? Hint { get; init; }
    /// <summary>Text: maximum length (default 200; long text has none).</summary>
    public int? MaxLength { get; init; }
    /// <summary>Decimal: total digits (default 18) and digits after the point (default 2).</summary>
    public int? Precision { get; init; }
    public int? Scale { get; init; }
    public IReadOnlyList<ChoiceOption>? Choices { get; init; }
    /// <summary>Reference: the key of the target entity.</summary>
    public string? Reference { get; init; }

    public const int DefaultMaxLength = 200;
    public const int DefaultPrecision = 18;
    public const int DefaultScale = 2;
}

public sealed class ChoiceOption
{
    public required string Value { get; init; }
    public required string Label { get; init; }
}

/// <summary>A record list of an entity: columns (field keys), the default order and the form its records open in.</summary>
public sealed class ListDefinition
{
    public required string Key { get; init; }
    public required string Name { get; init; }
    public required string Entity { get; init; }
    public IReadOnlyList<string> Columns { get; init; } = [];
    /// <summary>A field key, or created_at / updated_at. Default: newest first.</summary>
    public string? SortField { get; init; }
    public bool SortDescending { get; init; }
    /// <summary>The form a record opens in (one of the entity's forms). Default: the entity's first form.</summary>
    public string? Form { get; init; }
}

/// <summary>
/// A menu entry: a group (<see cref="Items"/>) or an item that opens a list (<see cref="List"/>)
/// or a new record in a form (<see cref="Form"/>).
/// </summary>
public sealed class MenuItem
{
    public required string Label { get; init; }
    public string? Icon { get; init; }
    public string? List { get; init; }
    public string? Form { get; init; }
    public IReadOnlyList<MenuItem>? Items { get; init; }
}

/// <summary>A record form of an entity: sections of fields. Details (child entities) are listed below them.</summary>
public sealed class FormDefinition
{
    public required string Key { get; init; }
    public required string Name { get; init; }
    /// <summary>The entity whose records it edits.</summary>
    public required string Entity { get; init; }
    public IReadOnlyList<FormSection> Sections { get; init; } = [];
}

public sealed class FormSection
{
    public string? Title { get; init; }
    public IReadOnlyList<string> Fields { get; init; } = [];
    public int Columns { get; init; } = 2;
}
