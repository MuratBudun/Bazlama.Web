using System.Text.Json;
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

    public EntityDefinition? Entity(string key) => Entities.FirstOrDefault(e => e.Key == key);

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public static AppDefinition Parse(string json) =>
        JsonSerializer.Deserialize<AppDefinition>(json, Json) ?? throw new JsonException("Boş tanım.");

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
    public ListDefinition? List { get; init; }
    public FormDefinition? Form { get; init; }

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

/// <summary>The list screen: columns (field keys) and the default order.</summary>
public sealed class ListDefinition
{
    public IReadOnlyList<string> Columns { get; init; } = [];
    public string? SortField { get; init; }
    public bool SortDescending { get; init; }
}

/// <summary>The form screen: sections of fields. Details (child entities) are listed below them.</summary>
public sealed class FormDefinition
{
    public IReadOnlyList<FormSection> Sections { get; init; } = [];
}

public sealed class FormSection
{
    public string? Title { get; init; }
    public IReadOnlyList<string> Fields { get; init; } = [];
    public int Columns { get; init; } = 2;
}
