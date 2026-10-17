using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using MimeKit;

namespace SmtpProxy.Core.Graph;

/// <summary>
/// Sends a received MIME message through Microsoft Graph as the sender mailbox. Graph takes the recipients from
/// the headers, not from an envelope: envelope recipients missing in To/Cc/Bcc are added as Bcc, header recipients
/// without envelope entry are removed, so exactly the SMTP recipients receive the message.
/// Up to about 3 MB the MIME goes to sendMail unchanged; larger messages become a draft without attachments,
/// the attachments are uploaded (upload session up to 150 MB) and the draft is sent.
/// </summary>
public sealed class GraphMailer(GraphClient graph)
{
    /// <summary>Base64 of the MIME must stay below the 4 MB request limit of Graph.</summary>
    public const int DirectLimit = 3 * 1024 * 1024 - 64 * 1024;
    const int SmallAttachment = 3 * 1024 * 1024 - 256 * 1024;
    const int Chunk = 320 * 1024 * 10;

    public async Task SendAsync(string from, IReadOnlyList<string> recipients, byte[] mime, CancellationToken ct)
    {
        var message = MimeMessage.Load(new MemoryStream(mime));
        AlignRecipients(message, recipients);
        var user = Uri.EscapeDataString(from);

        var bytes = Serialize(message);
        if (bytes.Length <= DirectLimit)
        {
            await graph.PostAsync($"/users/{user}/sendMail", MimeContent(bytes), ct);
            return;
        }

        // large: draft without attachments, attachments separately, then send
        var attachments = message.Attachments.OfType<MimePart>().ToList();
        foreach (var a in attachments) Remove(message, a);
        var draftBytes = Serialize(message);
        if (draftBytes.Length > DirectLimit)
            throw new GraphException(HttpStatusCode.RequestEntityTooLarge, "tooLarge",
                $"Nachrichtentext ohne Anhänge ist mit {draftBytes.Length / 1024} KB zu groß für Microsoft Graph.");

        var draft = await graph.PostAsync($"/users/{user}/messages", MimeContent(draftBytes), ct);
        var id = Uri.EscapeDataString(draft!["id"]!.GetValue<string>());
        try
        {
            foreach (var a in attachments) await UploadAttachmentAsync(user, id, a, ct);
            await graph.PostAsync($"/users/{user}/messages/{id}/send", null, ct);
        }
        catch
        {
            try { await graph.DeleteAsync($"/users/{user}/messages/{id}", CancellationToken.None); } catch { }
            throw;
        }
    }

    static StringContent MimeContent(byte[] mime) => new(Convert.ToBase64String(mime), Encoding.ASCII, "text/plain");

    static byte[] Serialize(MimeMessage m)
    {
        using var ms = new MemoryStream();
        m.WriteTo(FormatOptions.Default, ms);
        return ms.ToArray();
    }

    internal static void AlignRecipients(MimeMessage m, IReadOnlyList<string> envelope)
    {
        var wanted = new HashSet<string>(envelope, StringComparer.OrdinalIgnoreCase);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var list in new[] { m.To, m.Cc, m.Bcc })
        {
            foreach (var mb in list.Mailboxes.ToList())
            {
                if (wanted.Contains(mb.Address)) seen.Add(mb.Address);
                else RemoveMailbox(list, mb);
            }
        }
        foreach (var r in envelope.Where(r => !seen.Contains(r))) m.Bcc.Add(MailboxAddress.Parse(r));
    }

    static void RemoveMailbox(InternetAddressList list, MailboxAddress mb)
    {
        if (list.Remove(mb)) return;
        foreach (var g in list.OfType<GroupAddress>()) RemoveMailbox(g.Members, mb);
    }

    static void Remove(MimeMessage message, MimeEntity entity)
    {
        var iter = new MimeIterator(message);
        while (iter.MoveNext())
            if (iter.Parent is Multipart parent && ReferenceEquals(iter.Current, entity)) { parent.Remove(entity); return; }
    }

    async Task UploadAttachmentAsync(string user, string messageId, MimePart part, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        part.Content?.DecodeTo(ms);
        var data = ms.ToArray();
        var name = part.FileName ?? "attachment";
        var contentType = part.ContentType.MimeType;
        var inline = part.ContentDisposition?.Disposition == ContentDisposition.Inline;

        if (data.Length < SmallAttachment)
        {
            var body = new JsonObject
            {
                ["@odata.type"] = "#microsoft.graph.fileAttachment",
                ["name"] = name,
                ["contentType"] = contentType,
                ["contentBytes"] = Convert.ToBase64String(data),
                ["isInline"] = inline,
            };
            if (part.ContentId is { } cid) body["contentId"] = cid;
            await graph.PostAsync($"/users/{user}/messages/{messageId}/attachments", body, ct);
            return;
        }

        var item = new JsonObject
        {
            ["attachmentType"] = "file",
            ["name"] = name,
            ["size"] = data.Length,
            ["contentType"] = contentType,
            ["isInline"] = inline,
        };
        if (part.ContentId is { } id) item["contentId"] = id;
        var session = await graph.PostAsync($"/users/{user}/messages/{messageId}/attachments/createUploadSession",
            new JsonObject { ["AttachmentItem"] = item }, ct);
        var url = session!["uploadUrl"]!.GetValue<string>();
        for (var offset = 0; offset < data.Length; offset += Chunk)
            await GraphClient.PutChunkAsync(url, data, offset, Math.Min(Chunk, data.Length - offset), data.Length, ct);
    }
}
