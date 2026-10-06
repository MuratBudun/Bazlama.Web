using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Bazlama.Tests.Engine;
using static Bazlama.Tests.TestHost;

namespace Bazlama.Tests.Code;

/// <summary>
/// A form's tools menu end to end: the method of the form's code gets the form as it is on the
/// screen, changes go back unsaved, and modals (defined in the app, with code of their own) are
/// asked for on the way — from the app's code and from a code library.
/// </summary>
public sealed class FormToolTests : IAsyncLifetime
{
    readonly TestHost host = new();
    HttpClient admin = null!;
    const string Dev = "/api/development/apps/siparis";
    const string Data = "/api/runtime/data/siparis";
    const string Tools = "/api/runtime/forms/siparis/siparis/tools";

    const string Code = """
        namespace Siparisler;

        [Form("siparis")]
        public class SiparisFormu : FormCode<Siparis>
        {
            // The form as it is on the screen: changes go back, nothing is stored.
            public ActionResult Doldur(Siparis s, IAppContext context)
            {
                if (s.SiparisNo is null) return ActionResult.Fail("Önce sipariş no girin.");
                s.Aciklama = $"{s.SiparisNo} / yeni: {s.Id == Guid.Empty} / {context.UserName}";
                s.Tarih = new DateOnly(2026, 10, 5);
                return ActionResult.Ok("Dolduruldu.");
            }

            public async Task<ActionResult> MusteriSec(Siparis s, IAppContext context)
            {
                s.Musteri = (await context.Records.ListAsync<Musteri>(search: "Aktif")).Single().Id;
                return ActionResult.Save();
            }

            public async Task<ActionResult> Aralik(Siparis s, IAppContext context)
            {
                var a = await context.Modals.ShowAsync<Aralik>(m => m.Not = s.SiparisNo);
                s.Tarih = a.Baslangic;
                return ActionResult.Ok($"{a.Baslangic:yyyy-MM-dd}..{a.Bitis:yyyy-MM-dd} {a.Not} firma:{a.Firma.HasValue}");
            }

            // Not in the form's tools menu: it cannot be called.
            public ActionResult Gizli(Siparis s, IAppContext context) => ActionResult.Ok("gizli");
        }

        public class AralikKodu : ModalCode<Aralik>
        {
            public override Task OpenAsync(Aralik m, IAppContext context)
            {
                m.Baslangic ??= DateOnly.FromDateTime(context.UtcNow);
                return Task.CompletedTask;
            }

            public override Task ValidateAsync(Aralik m, Errors errors, IAppContext context)
            {
                if (m.Bitis < m.Baslangic) errors.Add("bitis", "Bitiş başlangıçtan önce olamaz.");
                return Task.CompletedTask;
            }
        }
        """;

    /// <summary>The sample with a modal and a tools menu on the order form.</summary>
    static JsonObject Definition(string version, params string[] methods)
    {
        var app = Samples.Node("siparis");
        app["version"] = version;
        app["modals"] = new JsonArray(new JsonObject
        {
            ["key"] = "aralik",
            ["name"] = "Tarih aralığı",
            ["fields"] = new JsonArray(
                new JsonObject { ["key"] = "baslangic", ["label"] = "Başlangıç", ["type"] = "date", ["required"] = true },
                new JsonObject { ["key"] = "bitis", ["label"] = "Bitiş", ["type"] = "date", ["required"] = true },
                new JsonObject { ["key"] = "not", ["label"] = "Not", ["type"] = "text" },
                new JsonObject { ["key"] = "firma", ["label"] = "Firma", ["type"] = "company" }),
        });
        var form = app["forms"]!.AsArray().Single(f => f!["key"]!.GetValue<string>() == "siparis")!;
        form["tools"] = new JsonArray([.. methods.Select(m => new JsonObject { ["label"] = m, ["method"] = m })]);
        return app;
    }

    public async ValueTask InitializeAsync()
    {
        await host.SetupAsync();
        admin = host.Client();
        await admin.LoginAsync(AdminUser, AdminPassword);
        await Install(Definition("2.1.0", "Doldur", "MusteriSec", "Aralik"));
    }

    public ValueTask DisposeAsync() => host.DisposeAsync();

    async Task Install(JsonObject definition)
    {
        var res = await admin.PostAsJsonAsync("/api/management/apps/install", new { definition, confirmDestructive = false }, Ct);
        Assert.True(res.IsSuccessStatusCode, (await res.JsonAsync()).ToString());
    }

    async Task SaveFile(string path, string content) =>
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsJsonAsync($"{Dev}/files", new { path, content }, Ct)).StatusCode);

    async Task<(HttpStatusCode Status, JsonElement Body)> Post(string path, object body)
    {
        var res = await admin.PostAsJsonAsync(path, body, Ct);
        return (res.StatusCode, await res.JsonAsync());
    }

    async Task Build()
    {
        var (status, body) = await Post($"{Dev}/build", new { });
        Assert.True(status == HttpStatusCode.OK, body.ToString());
    }

    [Fact]
    public async Task A_tool_gets_the_unsaved_form_and_its_changes_go_back_without_being_stored()
    {
        await SaveFile("SiparisFormu.cs", Code);
        await Build();

        // A new record's form: nothing is saved yet.
        var (status, body) = await Post($"{Tools}/Doldur", new { values = new { siparis_no = "S-1", durum = "taslak" } });
        Assert.True(status == HttpStatusCode.OK, body.ToString());
        Assert.Equal("Dolduruldu.", body.GetProperty("message").GetString());
        Assert.False(body.GetProperty("save").GetBoolean());
        var values = body.GetProperty("values");
        Assert.Equal("S-1 / yeni: True / admin", values.GetProperty("aciklama").GetString());
        Assert.Equal("2026-10-05", values.GetProperty("tarih").GetString());
        Assert.Equal("taslak", values.GetProperty("durum").GetString()); // untouched fields come back as they were
        Assert.Equal(0, (await (await admin.GetAsync($"{Data}/siparis", Ct)).JsonAsync()).GetProperty("total").GetInt32());

        // The code refuses; a value that is not of the field's type is a field error.
        var (refused, why) = await Post($"{Tools}/Doldur", new { values = new { durum = "taslak" } });
        Assert.Equal(HttpStatusCode.BadRequest, refused);
        Assert.Equal("Önce sipariş no girin.", why.GetProperty("errors")[0].GetString());
        var (invalid, fields) = await Post($"{Tools}/Doldur", new { values = new { siparis_no = "S-1", tarih = "dün" } });
        Assert.Equal(HttpStatusCode.BadRequest, invalid);
        Assert.True(fields.GetProperty("fieldErrors").TryGetProperty("tarih", out _));

        // A changed reference comes back with the record's title; Save asks the form to be saved.
        var (_, customer) = await Post($"{Data}/musteri", new { values = new { unvan = "Aktif A.Ş." } });
        var (ok, chosen) = await Post($"{Tools}/MusteriSec", new { values = new { siparis_no = "S-1" } });
        Assert.True(ok == HttpStatusCode.OK, chosen.ToString());
        Assert.Equal(customer.GetProperty("id").GetGuid(), chosen.GetProperty("values").GetProperty("musteri").GetGuid());
        Assert.Equal("Aktif A.Ş.", chosen.GetProperty("titles").GetProperty("musteri").GetString());
        Assert.True(chosen.GetProperty("save").GetBoolean());

        // Only what the form's menu offers can be called.
        Assert.Equal(HttpStatusCode.NotFound, (await Post($"{Tools}/Gizli", new { values = new { } })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await Post("/api/runtime/forms/siparis/musteri/tools/Doldur", new { values = new { } })).Status);
    }

    [Fact]
    public async Task A_tool_asks_for_a_modal_and_runs_again_with_what_the_user_entered()
    {
        await SaveFile("SiparisFormu.cs", Code);
        await Build();
        var form = new { siparis_no = "S-7" };

        // No input yet: the modal to show, with what the caller and the modal's code start it with.
        var (status, asked) = await Post($"{Tools}/Aralik", new { values = form });
        Assert.True(status == HttpStatusCode.OK, asked.ToString());
        var modal = asked.GetProperty("modal");
        Assert.Equal("aralik", modal.GetProperty("key").GetString());
        Assert.Equal("S-7", modal.GetProperty("values").GetProperty("not").GetString());
        Assert.Equal("2026-10-01", modal.GetProperty("values").GetProperty("baslangic").GetString()); // OpenAsync: today (the test clock)
        Assert.Equal(JsonValueKind.Null, asked.GetProperty("values").ValueKind);

        // Refused by the engine (a required field) and by the modal's own code: the modal again, with the errors.
        var (_, missing) = await Post($"{Tools}/Aralik", new { values = form, inputs = new { aralik = new { baslangic = "2026-10-01" } } });
        Assert.Equal("Zorunlu alan.", missing.GetProperty("modal").GetProperty("fieldErrors").GetProperty("bitis").GetString());
        var (_, backwards) = await Post($"{Tools}/Aralik", new { values = form, inputs = new { aralik = new { baslangic = "2026-10-10", bitis = "2026-10-01" } } });
        Assert.Equal("Bitiş başlangıçtan önce olamaz.", backwards.GetProperty("modal").GetProperty("fieldErrors").GetProperty("bitis").GetString());
        Assert.Equal("2026-10-10", backwards.GetProperty("modal").GetProperty("values").GetProperty("baslangic").GetString());

        // A company the user may not work in is refused; one of theirs is accepted.
        var range = new { baslangic = "2026-10-01", bitis = "2026-10-31", not = "ekim" };
        var (_, foreign) = await Post($"{Tools}/Aralik", new { values = form, inputs = new { aralik = new { range.baslangic, range.bitis, firma = Guid.NewGuid() } } });
        Assert.Equal("Bu seçime yetkiniz yok.", foreign.GetProperty("modal").GetProperty("fieldErrors").GetProperty("firma").GetString());
        var company = (await (await admin.GetAsync("/api/auth/context/options", Ct)).JsonAsync())[0].GetProperty("id").GetGuid();

        var (done, result) = await Post($"{Tools}/Aralik", new { values = form, inputs = new { aralik = new { range.baslangic, range.bitis, range.not, firma = company } } });
        Assert.True(done == HttpStatusCode.OK, result.ToString());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("modal").ValueKind);
        Assert.Equal("2026-10-01..2026-10-31 ekim firma:True", result.GetProperty("message").GetString());
        Assert.Equal("2026-10-01", result.GetProperty("values").GetProperty("tarih").GetString());
    }

    [Fact]
    public async Task A_library_opens_a_modal_by_its_key_and_saves_cannot_open_one()
    {
        // The library knows no app: it asks for the modal by key and reads the values by field key.
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsJsonAsync("/api/development/libraries", new { key = "sor", name = "Sorular" }, Ct)).StatusCode);
        await admin.PutAsJsonAsync("/api/development/libraries/sor/files", new
        {
            path = "Sor.cs",
            content = """
                using System;
                using System.Collections.Generic;
                using System.Threading.Tasks;
                using Bazlama.Sdk;
                namespace Ortak;
                public static class Sor
                {
                    public static async Task<(DateOnly Ilk, DateOnly Son)> AralikAsync(IAppContext context, string modal)
                    {
                        var v = await context.Modals.ShowAsync(modal, new Dictionary<string, object?> { ["not"] = "kütüphaneden" });
                        return ((DateOnly)v["baslangic"]!, (DateOnly)v["bitis"]!);
                    }
                }
                """,
        }, Ct);
        var publish = await admin.PostAsJsonAsync("/api/development/libraries/sor/publish", new { version = "1.0.0" }, Ct);
        Assert.True(publish.IsSuccessStatusCode, (await publish.JsonAsync()).ToString());
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PutAsJsonAsync($"{Dev}/libraries", new[] { new { key = "sor", version = "1.0.0" } }, Ct)).StatusCode);

        await Install(Definition("2.2.0", "Kutuphane"));
        await SaveFile("SiparisFormu.cs", """
            [Form("siparis")]
            public class SiparisFormu : FormCode<Siparis>
            {
                public async Task<ActionResult> Kutuphane(Siparis s, IAppContext context)
                {
                    var (ilk, son) = await Ortak.Sor.AralikAsync(context, "aralik");
                    return ActionResult.Ok($"{son.DayNumber - ilk.DayNumber} gün");
                }
            }

            public class SiparisEvents : EntityEvents<Siparis>
            {
                public override async Task BeforeSaveAsync(Siparis s, bool isNew, IAppContext context)
                {
                    if (s.SiparisNo == "MODAL") await context.Modals.ShowAsync<Aralik>();
                }
            }
            """);
        await Build();

        var (_, asked) = await Post($"{Tools}/Kutuphane", new { values = new { } });
        Assert.Equal("kütüphaneden", asked.GetProperty("modal").GetProperty("values").GetProperty("not").GetString());
        var (status, result) = await Post($"{Tools}/Kutuphane", new { values = new { }, inputs = new { aralik = new { baslangic = "2026-10-01", bitis = "2026-10-08" } } });
        Assert.True(status == HttpStatusCode.OK, result.ToString());
        Assert.Equal("7 gün", result.GetProperty("message").GetString());

        // No user is waiting for a save's code to ask something: it fails with the reason.
        var (saved, why) = await Post($"{Data}/siparis", new { values = new { siparis_no = "MODAL", durum = "taslak" } });
        Assert.Equal(HttpStatusCode.BadRequest, saved);
        Assert.Contains("Modal yalnız bir kullanıcı eylemi sırasında", why.GetProperty("errors")[0].GetString());
    }

    [Fact]
    public async Task The_check_outlines_the_forms_code_for_the_designer()
    {
        var check = await (await admin.PostAsJsonAsync($"{Dev}/check", new
        {
            files = new[]
            {
                new { path = "Formlar/SiparisFormu.cs", content = Code },
                new { path = "Formlar/Ek.cs", content = "namespace Siparisler;\npublic partial class Bos { }" },
            },
        }, Ct)).JsonAsync();
        var form = Assert.Single(check.GetProperty("forms").EnumerateArray());
        Assert.Equal(("siparis", "SiparisFormu", "Siparis", "Formlar/SiparisFormu.cs"),
            (form.GetProperty("form").GetString(), form.GetProperty("class").GetString(), form.GetProperty("record").GetString(), form.GetProperty("path").GetString()));

        // Where the class is and where it ends: a new method goes in before its closing brace.
        var lines = Code.ReplaceLineEndings("\n").Split('\n');
        Assert.Contains("public class SiparisFormu", lines[form.GetProperty("line").GetInt32() - 1]);
        Assert.Equal("public class ".Length + 1, form.GetProperty("column").GetInt32());
        Assert.Equal("}", lines[form.GetProperty("endLine").GetInt32() - 1].Trim());
        Assert.Contains("public class AralikKodu", lines[form.GetProperty("endLine").GetInt32() + 1]);

        // The methods a tool may call, with where each is (also one that is not in the menu).
        var methods = form.GetProperty("methods").EnumerateArray().ToList();
        Assert.Equal(["Doldur", "MusteriSec", "Aralik", "Gizli"], methods.Select(m => m.GetProperty("name").GetString()));
        var aralik = methods[2];
        var line = lines[aralik.GetProperty("line").GetInt32() - 1];
        Assert.Equal("Aralik", line.Substring(aralik.GetProperty("column").GetInt32() - 1, 6));
        Assert.Equal("Formlar/SiparisFormu.cs", aralik.GetProperty("path").GetString());

        // Not a tool's method: another signature, static, or not public.
        var other = await (await admin.PostAsJsonAsync($"{Dev}/check", new
        {
            files = new[]
            {
                new
                {
                    path = "X.cs",
                    content = """
                        [Form("siparis")]
                        public class X : FormCode<Siparis>
                        {
                            public ActionResult Olur(Siparis s, IAppContext c) => ActionResult.Ok();
                            public ActionResult BaskaKayit(Musteri m, IAppContext c) => ActionResult.Ok();
                            public ActionResult TekParametre(Siparis s) => ActionResult.Ok();
                            public static ActionResult Statik(Siparis s, IAppContext c) => ActionResult.Ok();
                            ActionResult Gizli(Siparis s, IAppContext c) => ActionResult.Ok();
                        }
                        """,
                },
            },
        }, Ct)).JsonAsync();
        Assert.Equal(["Olur"], other.GetProperty("forms")[0].GetProperty("methods").EnumerateArray().Select(m => m.GetProperty("name").GetString()));
    }

    [Fact]
    public async Task Code_is_checked_against_the_forms_tools()
    {
        // The menu has three tools; the class has one of them, for the wrong record.
        async Task<string[]> Problems(string code)
        {
            var check = await (await admin.PostAsJsonAsync($"{Dev}/check", new { files = new[] { new { path = "SiparisFormu.cs", content = code } } }, Ct)).JsonAsync();
            return [.. check.GetProperty("diagnostics").EnumerateArray().Where(d => d.GetProperty("code").GetString() == "BZ0003").Select(d => d.GetProperty("message").GetString()!)];
        }

        Assert.Contains("'siparis' formunun araçları için kod yok: [Form(\"siparis\")] ile işaretli bir FormCode<Siparis> sınıfı gerekli.", await Problems("public class Bos { }"));
        Assert.Contains("SiparisFormu: 'siparis' formu Siparis kaydıyla çalışır; FormCode<Musteri> olamaz.",
            await Problems("""[Form("siparis")] public class SiparisFormu : FormCode<Musteri> { }"""));
        Assert.Contains("[Form(\"yok\")]: uygulamada bu anahtarla bir form yok.", await Problems("""[Form("yok")] public class X : FormCode<Siparis> { }"""));
        var missing = await Problems("""
            [Form("siparis")]
            public class SiparisFormu : FormCode<Siparis>
            {
                public ActionResult Doldur(Siparis s, IAppContext context) => ActionResult.Ok();
                public ActionResult MusteriSec(Musteri m, IAppContext context) => ActionResult.Ok();
            }
            """);
        Assert.Equal(2, missing.Length);
        Assert.Contains(missing, m => m.Contains("SiparisFormu.MusteriSec(Siparis record, IAppContext context)"));
        Assert.Contains(missing, m => m.Contains("SiparisFormu.Aralik(Siparis record, IAppContext context)"));
        Assert.Empty(await Problems(Code));

        // A build without the code of the tools fails; so does publishing a draft that adds a tool.
        await SaveFile("SiparisFormu.cs", "public class Bos { }");
        Assert.Equal(HttpStatusCode.BadRequest, (await Post($"{Dev}/build", new { })).Status);
        await SaveFile("SiparisFormu.cs", Code);
        await Build();
        Assert.Equal(HttpStatusCode.OK, (await admin.PutAsJsonAsync($"{Dev}/draft", Definition("2.1.0", "Doldur", "Yeni"), Ct)).StatusCode);
        var (status, body) = await Post($"{Dev}/publish", new { version = "2.2.0", confirmDestructive = false });
        Assert.Equal(HttpStatusCode.BadRequest, status);
        Assert.Contains(body.GetProperty("code").GetProperty("diagnostics").EnumerateArray(), d => d.GetProperty("message").GetString()!.Contains("SiparisFormu.Yeni("));
    }
}
