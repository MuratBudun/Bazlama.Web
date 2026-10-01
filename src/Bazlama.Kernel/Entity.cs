namespace Bazlama.Kernel;

/// <summary>Base of kernel entities: Guid v7 ids (time ordered, unique across installations).</summary>
public abstract class Entity
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
}

/// <summary>Marks entities whose changes are written to the audit log.</summary>
public interface IAudited;
