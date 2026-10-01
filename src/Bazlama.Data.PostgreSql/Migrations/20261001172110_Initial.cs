using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Bazlama.Data.PostgreSql.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "sys_audit_events",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    At = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    Category = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Action = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: true),
                    UserName = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    SessionId = table.Column<Guid>(type: "uuid", nullable: true),
                    EntityType = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    EntityId = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    Data = table.Column<string>(type: "text", nullable: true),
                    IpAddress = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_audit_events", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "sys_companies",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Code = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    Name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    IsActive = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_companies", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "sys_data_protection_keys",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    FriendlyName = table.Column<string>(type: "text", nullable: true),
                    Xml = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_data_protection_keys", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "sys_groups",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Code = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    Name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Description = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    RequireMfa = table.Column<bool>(type: "boolean", nullable: false),
                    IsSystem = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_groups", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "sys_settings",
                columns: table => new
                {
                    Key = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Value = table.Column<string>(type: "character varying(4000)", maxLength: 4000, nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_settings", x => x.Key);
                });

            migrationBuilder.CreateTable(
                name: "sys_users",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserName = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    NormalizedUserName = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    DisplayName = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Email = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    IsActive = table.Column<bool>(type: "boolean", nullable: false),
                    PasswordHash = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    PasswordChangedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    MustChangePassword = table.Column<bool>(type: "boolean", nullable: false),
                    FailedLoginCount = table.Column<int>(type: "integer", nullable: false),
                    LockoutEndsAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    TotpSecret = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    TotpEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    TotpLastStep = table.Column<long>(type: "bigint", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LastLoginAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LastCompanyId = table.Column<Guid>(type: "uuid", nullable: true),
                    LastLocationId = table.Column<Guid>(type: "uuid", nullable: true),
                    LastPlantId = table.Column<Guid>(type: "uuid", nullable: true),
                    LastPeriodId = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_users", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "sys_locations",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CompanyId = table.Column<Guid>(type: "uuid", nullable: false),
                    Code = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    Name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    TimeZone = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    IsActive = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_locations", x => x.Id);
                    table.ForeignKey(
                        name: "FK_sys_locations_sys_companies_CompanyId",
                        column: x => x.CompanyId,
                        principalTable: "sys_companies",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "sys_periods",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    CompanyId = table.Column<Guid>(type: "uuid", nullable: false),
                    Code = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    Name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    StartDate = table.Column<DateOnly>(type: "date", nullable: false),
                    EndDate = table.Column<DateOnly>(type: "date", nullable: false),
                    IsClosed = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_periods", x => x.Id);
                    table.ForeignKey(
                        name: "FK_sys_periods_sys_companies_CompanyId",
                        column: x => x.CompanyId,
                        principalTable: "sys_companies",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "sys_group_permissions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    GroupId = table.Column<Guid>(type: "uuid", nullable: false),
                    Permission = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_group_permissions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_sys_group_permissions_sys_groups_GroupId",
                        column: x => x.GroupId,
                        principalTable: "sys_groups",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "sys_user_password_history",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    PasswordHash = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_user_password_history", x => x.Id);
                    table.ForeignKey(
                        name: "FK_sys_user_password_history_sys_users_UserId",
                        column: x => x.UserId,
                        principalTable: "sys_users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "sys_user_recovery_codes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    CodeHash = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    UsedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_user_recovery_codes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_sys_user_recovery_codes_sys_users_UserId",
                        column: x => x.UserId,
                        principalTable: "sys_users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "sys_user_sessions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Status = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    Channel = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LastSeenAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    EndedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    EndReason = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: true),
                    IpAddress = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                    UserAgent = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    CompanyId = table.Column<Guid>(type: "uuid", nullable: true),
                    LocationId = table.Column<Guid>(type: "uuid", nullable: true),
                    PlantId = table.Column<Guid>(type: "uuid", nullable: true),
                    PeriodId = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_user_sessions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_sys_user_sessions_sys_users_UserId",
                        column: x => x.UserId,
                        principalTable: "sys_users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "sys_group_members",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    GroupId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    LocationId = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_group_members", x => x.Id);
                    table.ForeignKey(
                        name: "FK_sys_group_members_sys_groups_GroupId",
                        column: x => x.GroupId,
                        principalTable: "sys_groups",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_sys_group_members_sys_locations_LocationId",
                        column: x => x.LocationId,
                        principalTable: "sys_locations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_sys_group_members_sys_users_UserId",
                        column: x => x.UserId,
                        principalTable: "sys_users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "sys_plants",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    LocationId = table.Column<Guid>(type: "uuid", nullable: false),
                    Code = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    Name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    IsActive = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_plants", x => x.Id);
                    table.ForeignKey(
                        name: "FK_sys_plants_sys_locations_LocationId",
                        column: x => x.LocationId,
                        principalTable: "sys_locations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "sys_user_org_access",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    CompanyId = table.Column<Guid>(type: "uuid", nullable: false),
                    LocationId = table.Column<Guid>(type: "uuid", nullable: true),
                    PlantId = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sys_user_org_access", x => x.Id);
                    table.ForeignKey(
                        name: "FK_sys_user_org_access_sys_companies_CompanyId",
                        column: x => x.CompanyId,
                        principalTable: "sys_companies",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_sys_user_org_access_sys_locations_LocationId",
                        column: x => x.LocationId,
                        principalTable: "sys_locations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_sys_user_org_access_sys_plants_PlantId",
                        column: x => x.PlantId,
                        principalTable: "sys_plants",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_sys_user_org_access_sys_users_UserId",
                        column: x => x.UserId,
                        principalTable: "sys_users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_sys_audit_events_At",
                table: "sys_audit_events",
                column: "At");

            migrationBuilder.CreateIndex(
                name: "IX_sys_audit_events_EntityType_EntityId",
                table: "sys_audit_events",
                columns: new[] { "EntityType", "EntityId" });

            migrationBuilder.CreateIndex(
                name: "IX_sys_companies_Code",
                table: "sys_companies",
                column: "Code",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_sys_group_members_GroupId_UserId",
                table: "sys_group_members",
                columns: new[] { "GroupId", "UserId" });

            migrationBuilder.CreateIndex(
                name: "IX_sys_group_members_LocationId",
                table: "sys_group_members",
                column: "LocationId");

            migrationBuilder.CreateIndex(
                name: "IX_sys_group_members_UserId",
                table: "sys_group_members",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_sys_group_permissions_GroupId_Permission",
                table: "sys_group_permissions",
                columns: new[] { "GroupId", "Permission" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_sys_groups_Code",
                table: "sys_groups",
                column: "Code",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_sys_locations_CompanyId_Code",
                table: "sys_locations",
                columns: new[] { "CompanyId", "Code" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_sys_periods_CompanyId_Code",
                table: "sys_periods",
                columns: new[] { "CompanyId", "Code" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_sys_plants_LocationId_Code",
                table: "sys_plants",
                columns: new[] { "LocationId", "Code" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_sys_user_org_access_CompanyId",
                table: "sys_user_org_access",
                column: "CompanyId");

            migrationBuilder.CreateIndex(
                name: "IX_sys_user_org_access_LocationId",
                table: "sys_user_org_access",
                column: "LocationId");

            migrationBuilder.CreateIndex(
                name: "IX_sys_user_org_access_PlantId",
                table: "sys_user_org_access",
                column: "PlantId");

            migrationBuilder.CreateIndex(
                name: "IX_sys_user_org_access_UserId",
                table: "sys_user_org_access",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_sys_user_password_history_UserId",
                table: "sys_user_password_history",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_sys_user_recovery_codes_UserId",
                table: "sys_user_recovery_codes",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_sys_user_sessions_UserId_Status",
                table: "sys_user_sessions",
                columns: new[] { "UserId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_sys_users_NormalizedUserName",
                table: "sys_users",
                column: "NormalizedUserName",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "sys_audit_events");

            migrationBuilder.DropTable(
                name: "sys_data_protection_keys");

            migrationBuilder.DropTable(
                name: "sys_group_members");

            migrationBuilder.DropTable(
                name: "sys_group_permissions");

            migrationBuilder.DropTable(
                name: "sys_periods");

            migrationBuilder.DropTable(
                name: "sys_settings");

            migrationBuilder.DropTable(
                name: "sys_user_org_access");

            migrationBuilder.DropTable(
                name: "sys_user_password_history");

            migrationBuilder.DropTable(
                name: "sys_user_recovery_codes");

            migrationBuilder.DropTable(
                name: "sys_user_sessions");

            migrationBuilder.DropTable(
                name: "sys_groups");

            migrationBuilder.DropTable(
                name: "sys_plants");

            migrationBuilder.DropTable(
                name: "sys_users");

            migrationBuilder.DropTable(
                name: "sys_locations");

            migrationBuilder.DropTable(
                name: "sys_companies");
        }
    }
}
