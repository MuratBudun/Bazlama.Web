using System.Data.Common;
using System.Globalization;
using System.Text;
using Bazlama.Engine.Schema;

namespace Bazlama.Engine.Sql;

/// <summary>
/// What differs between SqlServer, PostgreSql and Sqlite for app tables: DDL, types, quoting,
/// paging, case-insensitive search and value conversion. Every value goes in as a parameter.
/// </summary>
public abstract class SqlDialect
{
    /// <summary>Matches IDatabaseProvider.Name.</summary>
    public abstract string Provider { get; }

    public abstract string Quote(string identifier);
    public abstract string TypeOf(ColumnSchema column);

    /// <summary>"LIMIT/OFFSET" or "OFFSET/FETCH" after an ORDER BY.</summary>
    public abstract string Page(string skipParam, string takeParam);

    /// <summary>A case-insensitive "contains" (the parameter holds an escaped %term%).</summary>
    public virtual string Contains(string column, string param) => $"LOWER({column}) LIKE LOWER({param}) ESCAPE '\\'";

    /// <summary>Some providers can add a foreign key to an existing table; SQLite cannot (it declares them with the column).</summary>
    protected virtual bool AlterAddsForeignKeys => true;

    /// <summary>Run outside the migration transaction, before and after it.</summary>
    public virtual IReadOnlyList<string> BeforeMigration => [];
    public virtual IReadOnlyList<string> AfterMigration => [];

    // ── DDL ────────────────────────────────────────────────────────────────

    public virtual IReadOnlyList<string> Statements(IReadOnlyList<SchemaChange> changes) => [.. changes.SelectMany(Statements)];

    protected virtual IEnumerable<string> Statements(SchemaChange c) => c.Kind switch
    {
        ChangeKind.CreateTable => [CreateTable(c.New!, inlineForeignKeys: !AlterAddsForeignKeys)],
        ChangeKind.DropTable => [$"DROP TABLE {Quote(c.Table)}"],
        ChangeKind.AddColumn => [AddColumn(c.New!, c.New!.Column(c.Column!)!, c.ForeignKey)],
        ChangeKind.DropColumn => DropColumn(c),
        ChangeKind.AlterColumn => [AlterColumn(c.New!, c.New!.Column(c.Column!)!)],
        ChangeKind.CreateIndex => [$"CREATE INDEX {Quote(c.Index!.Name)} ON {Quote(c.Table)} ({string.Join(", ", c.Index.Columns.Select(Quote))})"],
        ChangeKind.DropIndex => [DropIndex(c.Table, c.Index!.Name)],
        ChangeKind.AddForeignKey => AlterAddsForeignKeys ? [AddForeignKey(c.Table, c.ForeignKey!)] : [],
        _ => throw new ArgumentOutOfRangeException(nameof(c)),
    };

    public string CreateTable(TableSchema t, bool inlineForeignKeys)
    {
        var sb = new StringBuilder($"CREATE TABLE {Quote(t.Name)} (");
        sb.AppendJoin(", ", t.Columns.Select(c => $"{Quote(c.Name)} {TypeOf(c)}{(c.Nullable ? " NULL" : " NOT NULL")}"));
        sb.Append($", CONSTRAINT {Quote($"pk_{t.Name}")} PRIMARY KEY ({Quote("id")})");
        if (inlineForeignKeys)
            foreach (var fk in t.ForeignKeys)
                sb.Append($", CONSTRAINT {Quote(SchemaBuilder.ForeignKeyName(t.Name, fk.Column))} FOREIGN KEY ({Quote(fk.Column)}) REFERENCES {Quote(fk.RefTable)} ({Quote(fk.RefColumn)})");
        sb.Append(')');
        return sb.ToString();
    }

    protected virtual string AddColumn(TableSchema t, ColumnSchema c, ForeignKeySchema? fk) =>
        $"ALTER TABLE {Quote(t.Name)} ADD {Quote(c.Name)} {TypeOf(c)} NULL";

    protected virtual IEnumerable<string> DropColumn(SchemaChange c)
    {
        if (c.Old!.ForeignKey(c.Column!) is not null)
            yield return $"ALTER TABLE {Quote(c.Table)} DROP CONSTRAINT {Quote(SchemaBuilder.ForeignKeyName(c.Table, c.Column!))}";
        yield return $"ALTER TABLE {Quote(c.Table)} DROP COLUMN {Quote(c.Column!)}";
    }

    protected abstract string AlterColumn(TableSchema t, ColumnSchema c);

    protected virtual string DropIndex(string table, string index) => $"DROP INDEX {Quote(index)}";

    protected string AddForeignKey(string table, ForeignKeySchema fk) =>
        $"ALTER TABLE {Quote(table)} ADD CONSTRAINT {Quote(SchemaBuilder.ForeignKeyName(table, fk.Column))} FOREIGN KEY ({Quote(fk.Column)}) REFERENCES {Quote(fk.RefTable)} ({Quote(fk.RefColumn)})";

    // ── Values ─────────────────────────────────────────────────────────────

    /// <summary>A CLR value as the provider wants it in a parameter.</summary>
    public virtual object ToDb(object? value) => value switch
    {
        null => DBNull.Value,
        DateOnly d => d.ToDateTime(TimeOnly.MinValue),
        _ => value,
    };

    /// <summary>A value read from a reader, as the CLR type of the column.</summary>
    public virtual object? FromDb(object value, ColumnType type)
    {
        if (value is DBNull) return null;
        return type switch
        {
            ColumnType.Guid => value is Guid g ? g : Guid.Parse(Convert.ToString(value, CultureInfo.InvariantCulture)!),
            ColumnType.Long => Convert.ToInt64(value, CultureInfo.InvariantCulture),
            ColumnType.Int => Convert.ToInt32(value, CultureInfo.InvariantCulture),
            ColumnType.Decimal => Convert.ToDecimal(value, CultureInfo.InvariantCulture),
            ColumnType.Bool => value is bool b ? b : Convert.ToInt64(value, CultureInfo.InvariantCulture) != 0,
            ColumnType.Date => DateOnly.FromDateTime(value is DateTime dt ? dt : DateTime.Parse(Convert.ToString(value, CultureInfo.InvariantCulture)!, CultureInfo.InvariantCulture)),
            ColumnType.DateTime => DateTime.SpecifyKind(value is DateTime dt2 ? dt2 : DateTime.Parse(Convert.ToString(value, CultureInfo.InvariantCulture)!, CultureInfo.InvariantCulture), DateTimeKind.Utc),
            _ => Convert.ToString(value, CultureInfo.InvariantCulture),
        };
    }

    public DbParameter Parameter(DbCommand cmd, string name, object? value)
    {
        var p = cmd.CreateParameter();
        p.ParameterName = name;
        p.Value = ToDb(value);
        Prepare(p, value);
        cmd.Parameters.Add(p);
        return p;
    }

    /// <summary>Provider-specific parameter settings (e.g. datetime2 on SQL Server).</summary>
    protected virtual void Prepare(DbParameter parameter, object? value) { }

    /// <summary>A LIKE pattern for "contains", with %, _ and \ escaped.</summary>
    public static string ContainsPattern(string term) =>
        "%" + term.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
}
