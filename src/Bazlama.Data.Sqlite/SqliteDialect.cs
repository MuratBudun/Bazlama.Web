using System.Globalization;
using Bazlama.Engine.Schema;
using Bazlama.Engine.Sql;

namespace Bazlama.Data.Sqlite;

/// <summary>
/// SQLite stores values like EF Core does for the kernel tables (Guids as upper-case text,
/// dates as ISO text), so app tables can reference kernel tables. It cannot alter or drop
/// constrained columns: those tables are rebuilt.
/// </summary>
public sealed class SqliteDialect : SqlDialect
{
    public override string Provider => "Sqlite";

    public override string Quote(string identifier) => $"\"{identifier.Replace("\"", "\"\"")}\"";

    public override string TypeOf(ColumnSchema c) => c.Type switch
    {
        ColumnType.Long or ColumnType.Int or ColumnType.Bool => "INTEGER",
        ColumnType.Decimal => "NUMERIC",
        _ => "TEXT",
    };

    public override string Page(string skipParam, string takeParam) => $"LIMIT {takeParam} OFFSET {skipParam}";

    protected override bool AlterAddsForeignKeys => false;

    // A table rebuild drops and renames tables that others refer to.
    public override IReadOnlyList<string> BeforeMigration => ["PRAGMA foreign_keys = OFF"];
    public override IReadOnlyList<string> AfterMigration => ["PRAGMA foreign_keys = ON"];

    /// <summary>A reference column is declared with its REFERENCES clause (allowed with ADD COLUMN when the default is NULL).</summary>
    protected override string AddColumn(TableSchema t, ColumnSchema c, ForeignKeySchema? fk) =>
        $"ALTER TABLE {Quote(t.Name)} ADD COLUMN {Quote(c.Name)} {TypeOf(c)} NULL"
        + (fk is null ? "" : $" REFERENCES {Quote(fk.RefTable)} ({Quote(fk.RefColumn)})");

    /// <summary>TEXT has no length: widening is nothing to do.</summary>
    protected override string AlterColumn(TableSchema t, ColumnSchema c) => "";

    /// <summary>A table losing columns is rebuilt once, with its final shape; its other changes are part of that.</summary>
    public override IReadOnlyList<string> Statements(IReadOnlyList<SchemaChange> changes)
    {
        var rebuilt = changes.Where(c => c.Kind == ChangeKind.DropColumn).Select(c => c.Table).ToHashSet();
        var done = new HashSet<string>();
        var sql = new List<string>();
        foreach (var c in changes)
        {
            if (!rebuilt.Contains(c.Table) || c.Kind is ChangeKind.CreateTable or ChangeKind.DropTable)
            {
                sql.AddRange(base.Statements([c]).Where(s => s.Length > 0));
                continue;
            }
            if (done.Add(c.Table)) sql.AddRange(Rebuild(c.Old!, c.New!));
        }
        return sql;
    }

    IEnumerable<string> Rebuild(TableSchema old, TableSchema next)
    {
        var temp = $"_rebuild_{next.Name}";
        var common = next.Columns.Where(c => old.Column(c.Name) is not null).Select(c => Quote(c.Name)).ToList();
        yield return CreateTable(next with { Name = temp }, inlineForeignKeys: true);
        yield return $"INSERT INTO {Quote(temp)} ({string.Join(", ", common)}) SELECT {string.Join(", ", common)} FROM {Quote(old.Name)}";
        yield return $"DROP TABLE {Quote(old.Name)}";
        yield return $"ALTER TABLE {Quote(temp)} RENAME TO {Quote(next.Name)}";
        foreach (var i in next.Indexes)
            yield return $"CREATE INDEX {Quote(i.Name)} ON {Quote(next.Name)} ({string.Join(", ", i.Columns.Select(Quote))})";
    }

    public override object ToDb(object? value) => value switch
    {
        null => DBNull.Value,
        Guid g => g.ToString().ToUpperInvariant(),
        DateTime dt => dt.ToString("yyyy-MM-dd HH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture),
        DateOnly d => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        bool b => b ? 1 : 0,
        decimal m => m,
        _ => value,
    };
}
