using System.Data;
using System.Data.Common;
using Bazlama.Engine.Schema;
using Bazlama.Engine.Sql;

namespace Bazlama.Data.SqlServer;

public sealed class SqlServerDialect : SqlDialect
{
    public override string Provider => "SqlServer";

    public override string Quote(string identifier) => $"[{identifier.Replace("]", "]]")}]";

    public override string TypeOf(ColumnSchema c) => c.Type switch
    {
        ColumnType.Guid => "uniqueidentifier",
        ColumnType.String => $"nvarchar({c.Length})",
        ColumnType.Text => "nvarchar(max)",
        ColumnType.Long => "bigint",
        ColumnType.Int => "int",
        ColumnType.Decimal => $"decimal({c.Precision},{c.Scale})",
        ColumnType.Date => "date",
        ColumnType.DateTime => "datetime2",
        ColumnType.Bool => "bit",
        _ => throw new ArgumentOutOfRangeException(nameof(c)),
    };

    public override string Page(string skipParam, string takeParam) => $"OFFSET {skipParam} ROWS FETCH NEXT {takeParam} ROWS ONLY";

    protected override string AlterColumn(TableSchema t, ColumnSchema c) =>
        $"ALTER TABLE {Quote(t.Name)} ALTER COLUMN {Quote(c.Name)} {TypeOf(c)} NULL";

    protected override string DropIndex(string table, string index) => $"DROP INDEX {Quote(index)} ON {Quote(table)}";

    protected override void Prepare(DbParameter parameter, object? value)
    {
        if (value is DateTime) parameter.DbType = DbType.DateTime2;
        else if (value is DateOnly) parameter.DbType = DbType.Date;
    }
}
