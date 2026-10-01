using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Bazlama.Data.SqlServer.Migrations
{
    /// <inheritdoc />
    public partial class Code : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "sys_app_builds",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    AppKey = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: false),
                    Number = table.Column<int>(type: "int", nullable: false),
                    AppVersion = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: false),
                    Image = table.Column<byte[]>(type: "varbinary(max)", nullable: false),
                    Hash = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Sources = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    Libraries = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    IsActive = table.Column<bool>(type: "bit", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_app_builds", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "sys_app_code_files",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    AppKey = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: false),
                    Path = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    Content = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_app_code_files", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "sys_app_workspaces",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    AppKey = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: false),
                    Libraries = table.Column<string>(type: "nvarchar(max)", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_app_workspaces", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "sys_code_libraries",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Key = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    Description = table.Column<string>(type: "nvarchar(1000)", maxLength: 1000, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_code_libraries", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "sys_code_library_files",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    LibraryId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Path = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    Content = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_code_library_files", x => x.Id);
                    table.ForeignKey(
                        name: "FK_sys_code_library_files_sys_code_libraries_LibraryId",
                        column: x => x.LibraryId,
                        principalTable: "sys_code_libraries",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "sys_code_library_versions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    LibraryId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Version = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: false),
                    Sources = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    Image = table.Column<byte[]>(type: "varbinary(max)", nullable: false),
                    Hash = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    CreatedBy = table.Column<Guid>(type: "uniqueidentifier", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_code_library_versions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_sys_code_library_versions_sys_code_libraries_LibraryId",
                        column: x => x.LibraryId,
                        principalTable: "sys_code_libraries",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_sys_app_builds_AppKey_Number",
                table: "sys_app_builds",
                columns: new[] { "AppKey", "Number" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_sys_app_code_files_AppKey_Path",
                table: "sys_app_code_files",
                columns: new[] { "AppKey", "Path" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_sys_app_workspaces_AppKey",
                table: "sys_app_workspaces",
                column: "AppKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_sys_code_libraries_Key",
                table: "sys_code_libraries",
                column: "Key",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_sys_code_library_files_LibraryId_Path",
                table: "sys_code_library_files",
                columns: new[] { "LibraryId", "Path" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_sys_code_library_versions_LibraryId_Version",
                table: "sys_code_library_versions",
                columns: new[] { "LibraryId", "Version" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "sys_app_builds");

            migrationBuilder.DropTable(
                name: "sys_app_code_files");

            migrationBuilder.DropTable(
                name: "sys_app_workspaces");

            migrationBuilder.DropTable(
                name: "sys_code_library_files");

            migrationBuilder.DropTable(
                name: "sys_code_library_versions");

            migrationBuilder.DropTable(
                name: "sys_code_libraries");
        }
    }
}
