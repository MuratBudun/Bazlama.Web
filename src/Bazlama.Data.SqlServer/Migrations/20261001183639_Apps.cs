using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Bazlama.Data.SqlServer.Migrations
{
    /// <inheritdoc />
    public partial class Apps : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "sys_apps",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Key = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    Version = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: false),
                    Metadata = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    InstalledAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_apps", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "sys_app_versions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    AppId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Version = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: false),
                    Metadata = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    Changes = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    InstalledAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    InstalledBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_app_versions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_sys_app_versions_sys_apps_AppId",
                        column: x => x.AppId,
                        principalTable: "sys_apps",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_sys_app_versions_AppId",
                table: "sys_app_versions",
                column: "AppId");

            migrationBuilder.CreateIndex(
                name: "IX_sys_apps_Key",
                table: "sys_apps",
                column: "Key",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "sys_app_versions");

            migrationBuilder.DropTable(
                name: "sys_apps");
        }
    }
}
