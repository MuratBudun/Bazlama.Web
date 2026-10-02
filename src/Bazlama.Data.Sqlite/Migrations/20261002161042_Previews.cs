using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Bazlama.Data.Sqlite.Migrations
{
    /// <inheritdoc />
    public partial class Previews : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "sys_app_previews",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    AppKey = table.Column<string>(type: "TEXT", maxLength: 50, nullable: false),
                    Definition = table.Column<string>(type: "TEXT", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                    UpdatedBy = table.Column<Guid>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_app_previews", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_sys_app_previews_AppKey",
                table: "sys_app_previews",
                column: "AppKey",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "sys_app_previews");
        }
    }
}
