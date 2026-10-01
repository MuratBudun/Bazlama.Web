using System.Security.Cryptography;
using System.Text;
using Bazlama.Engine.Metadata;

namespace Bazlama.Engine.Schema;

public enum ColumnType { Guid, String, Text, Long, Int, Decimal, Date, DateTime, Bool }

public sealed record ColumnSchema(string Name, ColumnType Type, bool Nullable, int? Length = null, int? Precision = null, int? Scale = null);

/// <summary>Column → referenced table (its primary key, "Id" for kernel tables, "id" for app tables).</summary>
public sealed record ForeignKeySchema(string Column, string RefTable, string RefColumn);

public sealed record IndexSchema(string Name, IReadOnlyList<string> Columns);

public sealed record TableSchema(string Name, IReadOnlyList<ColumnSchema> Columns, IReadOnlyList<ForeignKeySchema> ForeignKeys, IReadOnlyList<IndexSchema> Indexes)
{
    public ColumnSchema? Column(string name) => Columns.FirstOrDefault(c => c.Name == name);
    public ForeignKeySchema? ForeignKey(string column) => ForeignKeys.FirstOrDefault(f => f.Column == column);
}

/// <summary>The tables of an app, derived from its metadata.</summary>
public static class SchemaBuilder
{
    public static IReadOnlyList<TableSchema> Build(AppDefinition app) => [.. app.Entities.Select(e => Build(app, e))];

    public static TableSchema Build(AppDefinition app, EntityDefinition entity)
    {
        var table = app.TableName(entity);
        var cols = new List<ColumnSchema> { new("id", ColumnType.Guid, false) };
        var fks = new List<ForeignKeySchema>();
        var indexes = new List<IndexSchema>();

        var scope = app.EffectiveScope(entity);
        if (scope >= EntityScope.Company)
        {
            cols.Add(new("company_id", ColumnType.Guid, false));
            fks.Add(new("company_id", "sys_companies", "Id"));
        }
        if (scope >= EntityScope.Location)
        {
            cols.Add(new("location_id", ColumnType.Guid, false));
            fks.Add(new("location_id", "sys_locations", "Id"));
        }
        if (scope >= EntityScope.Plant)
        {
            cols.Add(new("plant_id", ColumnType.Guid, false));
            fks.Add(new("plant_id", "sys_plants", "Id"));
        }
        if (app.EffectivePeriodBound(entity))
        {
            cols.Add(new("period_id", ColumnType.Guid, false));
            fks.Add(new("period_id", "sys_periods", "Id"));
        }
        var scopeCols = cols.Skip(1).Select(c => c.Name).ToList();
        if (scopeCols.Count > 0) indexes.Add(Index(table, scopeCols));

        if (entity.Parent is { } parent)
        {
            cols.Add(new("parent_id", ColumnType.Guid, false));
            fks.Add(new("parent_id", app.TableName(app.Entity(parent)!), "id"));
            indexes.Add(Index(table, ["parent_id"]));
        }

        foreach (var f in entity.Fields)
        {
            cols.Add(Column(f));
            if (f.Type == FieldType.Reference)
            {
                fks.Add(new(f.Key, app.TableName(app.Entity(f.Reference!)!), "id"));
                indexes.Add(Index(table, [f.Key]));
            }
        }

        cols.Add(new("created_at", ColumnType.DateTime, false));
        cols.Add(new("created_by", ColumnType.Guid, true));
        cols.Add(new("updated_at", ColumnType.DateTime, true));
        cols.Add(new("updated_by", ColumnType.Guid, true));
        cols.Add(new("is_deleted", ColumnType.Bool, false));
        cols.Add(new("row_version", ColumnType.Int, false));
        return new TableSchema(table, cols, fks, indexes);
    }

    /// <summary>App fields are nullable in the database: "required" is checked by the engine, so a required field can be added to a table that has rows.</summary>
    public static ColumnSchema Column(FieldDefinition f) => f.Type switch
    {
        FieldType.Text => new(f.Key, ColumnType.String, true, f.MaxLength ?? FieldDefinition.DefaultMaxLength),
        FieldType.LongText => new(f.Key, ColumnType.Text, true),
        FieldType.Integer => new(f.Key, ColumnType.Long, true),
        FieldType.Decimal => new(f.Key, ColumnType.Decimal, true, null, f.Precision ?? FieldDefinition.DefaultPrecision, f.Scale ?? FieldDefinition.DefaultScale),
        FieldType.Date => new(f.Key, ColumnType.Date, true),
        FieldType.DateTime => new(f.Key, ColumnType.DateTime, true),
        FieldType.Boolean => new(f.Key, ColumnType.Bool, true),
        FieldType.Choice => new(f.Key, ColumnType.String, true, 50),
        FieldType.Reference => new(f.Key, ColumnType.Guid, true),
        _ => throw new ArgumentOutOfRangeException(nameof(f), f.Type, null),
    };

    public static IndexSchema Index(string table, IReadOnlyList<string> columns) => new(Name("ix", table, columns), columns);

    public static string ForeignKeyName(string table, string column) => Name("fk", table, [column]);

    /// <summary>Object names stay under 60 characters (PostgreSQL truncates at 63).</summary>
    static string Name(string prefix, string table, IReadOnlyList<string> columns)
    {
        var name = $"{prefix}_{table}_{string.Join("_", columns)}";
        if (name.Length <= 60) return name;
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(name)))[..8].ToLowerInvariant();
        return $"{name[..51]}_{hash}";
    }
}
