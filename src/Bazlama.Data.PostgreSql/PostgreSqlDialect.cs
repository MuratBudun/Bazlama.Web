using Bazlama.Engine.Schema;
using Bazlama.Engine.Sql;

namespace Bazlama.Data.PostgreSql;

public sealed class PostgreSqlDialect : SqlDialect
{
    public override string Provider => "PostgreSql";

    public override string Quote(string identifier) => $"\"{identifier.Replace("\"", "\"\"")}\"";

    /// <summary>DateTime is "timestamp with time zone" like the kernel tables (EF's default); values are UTC.</summary>
    public override string TypeOf(ColumnSchema c) => c.Type switch
    {
        ColumnType.Guid => "uuid",
        ColumnType.String => $"varchar({c.Length})",
        ColumnType.Text => "text",
        ColumnType.Long => "bigint",
        ColumnType.Int => "integer",
        ColumnType.Decimal => $"numeric({c.Precision},{c.Scale})",
        ColumnType.Date => "date",
        ColumnType.DateTime => "timestamp with time zone",
        ColumnType.Bool => "boolean",
        _ => throw new ArgumentOutOfRangeException(nameof(c)),
    };

    public override string Page(string skipParam, string takeParam) => $"LIMIT {takeParam} OFFSET {skipParam}";

    public override string Contains(string column, string param) => $"{column} ILIKE {param} ESCAPE '\\'";

    protected override string AlterColumn(TableSchema t, ColumnSchema c) =>
        $"ALTER TABLE {Quote(t.Name)} ALTER COLUMN {Quote(c.Name)} TYPE {TypeOf(c)}";

    /// <summary>Npgsql writes DateOnly to date columns as it is.</summary>
    public override object ToDb(object? value) => value switch
    {
        null => DBNull.Value,
        DateTime dt => DateTime.SpecifyKind(dt, DateTimeKind.Utc),
        _ => value,
    };
}
