using System.Text.Json;
using Azure.Identity;
using Azure.Messaging.ServiceBus;

// HoneyHub Service Bus explorer helper — see the .csproj header for the why.
//
// Usage (read-only verbs only at this stage):
//   honeyhub-sb-explorer peek --namespace <ns.servicebus.windows.net> --entity <queueOrTopic>
//        [--subscription <name>] [--dlq] [--count N]
//
// On success: a JSON document on stdout, exit 0. On failure: a short message on stderr, exit 1
// (the bridge maps the exit/stderr to a sanitized hint; it never surfaces raw stderr to the UI).

try
{
    if (args.Length == 0)
    {
        await Console.Error.WriteLineAsync("usage: honeyhub-sb-explorer <verb> [options]");
        return 2;
    }

    var verb = args[0];
    var opts = ParseOptions(args.AsSpan(1));

    switch (verb)
    {
        case "peek":
            return await PeekAsync(opts);
        case "resubmit":
            return await ResubmitAsync(opts);
        case "purge":
            return await PurgeAsync(opts);
        case "send":
            return await SendAsync(opts);
        case "receive":
            return await ReceiveAsync(opts);
        default:
            await Console.Error.WriteLineAsync($"unknown verb: {verb}");
            return 2;
    }
}
catch (Exception ex)
{
    // Keep it short; the bridge decides the user-facing hint. Auth failures surface clearly.
    await Console.Error.WriteLineAsync(ex is CredentialUnavailableException or AuthenticationFailedException
        ? "not signed in (run az login) or missing the Azure Service Bus Data Receiver role"
        : ex.Message);
    return 1;
}

static async Task<int> PeekAsync(Dictionary<string, string> opts)
{
    var ns = Require(opts, "namespace");
    var entity = Require(opts, "entity");
    opts.TryGetValue("subscription", out var subscription);
    var dlq = opts.ContainsKey("dlq");
    var count = opts.TryGetValue("count", out var rawCount) && int.TryParse(rawCount, out var c)
        ? Math.Clamp(c, 1, 100)
        : 20;

    var credential = new DefaultAzureCredential();
    await using var client = new ServiceBusClient(ns, credential);
    var receiverOptions = new ServiceBusReceiverOptions
    {
        SubQueue = dlq ? SubQueue.DeadLetter : SubQueue.None
    };

    // A subscription peek needs (topic, subscription); a queue peek needs just the queue.
    await using ServiceBusReceiver receiver = string.IsNullOrWhiteSpace(subscription)
        ? client.CreateReceiver(entity, receiverOptions)
        : client.CreateReceiver(entity, subscription, receiverOptions);

    var messages = await receiver.PeekMessagesAsync(count);

    var rows = messages.Select(m => new
    {
        messageId = m.MessageId,
        sequenceNumber = m.SequenceNumber,
        enqueuedTime = m.EnqueuedTime.UtcDateTime.ToString("o"),
        subject = string.IsNullOrEmpty(m.Subject) ? null : m.Subject,
        contentType = string.IsNullOrEmpty(m.ContentType) ? null : m.ContentType,
        deliveryCount = m.DeliveryCount,
        body = SafeBody(m),
        deadLetterReason = m.DeadLetterReason,
        deadLetterErrorDescription = m.DeadLetterErrorDescription
    });

    var json = JsonSerializer.Serialize(new { messages = rows });
    await Console.Out.WriteLineAsync(json);
    return 0;
}

// DESTRUCTIVE (write): drain up to N dead-letter messages back to their source entity (a
// queue, or a topic when --subscription is given): receive from the DLQ, send a clone to the
// source, complete the original. Needs Data Receiver + Data Sender. The bridge gates this
// behind an explicit user confirmation; the helper just performs the move.
static async Task<int> ResubmitAsync(Dictionary<string, string> opts)
{
    var ns = Require(opts, "namespace");
    var entity = Require(opts, "entity");
    opts.TryGetValue("subscription", out var subscription);
    var count = opts.TryGetValue("count", out var rawCount) && int.TryParse(rawCount, out var c)
        ? Math.Clamp(c, 1, 100)
        : 1;

    var credential = new DefaultAzureCredential();
    await using var client = new ServiceBusClient(ns, credential);

    // Source = the queue, or the topic for a subscription. Receive from that entity's DLQ.
    await using ServiceBusSender sender = client.CreateSender(entity);
    var receiverOptions = new ServiceBusReceiverOptions
    {
        SubQueue = SubQueue.DeadLetter,
        ReceiveMode = ServiceBusReceiveMode.PeekLock
    };
    await using ServiceBusReceiver receiver = string.IsNullOrWhiteSpace(subscription)
        ? client.CreateReceiver(entity, receiverOptions)
        : client.CreateReceiver(entity, subscription, receiverOptions);

    var received = await receiver.ReceiveMessagesAsync(count, TimeSpan.FromSeconds(5));
    var moved = 0;
    try
    {
        foreach (var message in received)
        {
            var clone = new ServiceBusMessage(message.Body)
            {
                Subject = message.Subject,
                ContentType = message.ContentType,
                CorrelationId = message.CorrelationId,
                MessageId = message.MessageId
            };
            foreach (var property in message.ApplicationProperties)
            {
                clone.ApplicationProperties[property.Key] = property.Value;
            }
            await sender.SendMessageAsync(clone);
            await receiver.CompleteMessageAsync(message);
            moved++;
        }
    }
    catch (Exception ex)
    {
        // Report how many were moved before the failure, so a mid-loop lock-expiry/transient
        // error doesn't leave the operator blind (some were already resubmitted). stdout
        // carries the partial count + the error; exit non-zero so the bridge marks it failed.
        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new { moved, error = ex.Message }));
        return 1;
    }

    await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new { moved }));
    return 0;
}

// DESTRUCTIVE (write): drain ALL messages from a queue (or topic subscription); `--dlq`
// drains the dead-letter sub-queue. Uses ReceiveAndDelete in batches until empty (with a
// safety cap). Needs Data Receiver. The bridge gates this behind an explicit confirmation.
static async Task<int> PurgeAsync(Dictionary<string, string> opts)
{
    var ns = Require(opts, "namespace");
    var entity = Require(opts, "entity");
    opts.TryGetValue("subscription", out var subscription);
    var dlq = opts.ContainsKey("dlq");

    var credential = new DefaultAzureCredential();
    await using var client = new ServiceBusClient(ns, credential);
    var receiverOptions = new ServiceBusReceiverOptions
    {
        SubQueue = dlq ? SubQueue.DeadLetter : SubQueue.None,
        ReceiveMode = ServiceBusReceiveMode.ReceiveAndDelete
    };
    await using ServiceBusReceiver receiver = string.IsNullOrWhiteSpace(subscription)
        ? client.CreateReceiver(entity, receiverOptions)
        : client.CreateReceiver(entity, subscription, receiverOptions);

    const int safetyCap = 100_000;
    var purged = 0;
    while (purged < safetyCap)
    {
        var batch = await receiver.ReceiveMessagesAsync(100, TimeSpan.FromSeconds(2));
        if (batch.Count == 0)
        {
            break;
        }
        purged += batch.Count;
    }

    await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new { purged }));
    return 0;
}

// WRITE: publish a single message to a queue or topic. Needs Data Sender. The bridge gates
// this behind an explicit confirmation; the helper just sends what it's given.
static async Task<int> SendAsync(Dictionary<string, string> opts)
{
    var ns = Require(opts, "namespace");
    var entity = Require(opts, "entity");
    var body = Require(opts, "body");
    opts.TryGetValue("subject", out var subject);
    opts.TryGetValue("content-type", out var contentType);

    var credential = new DefaultAzureCredential();
    await using var client = new ServiceBusClient(ns, credential);
    await using ServiceBusSender sender = client.CreateSender(entity);

    var message = new ServiceBusMessage(body);
    if (!string.IsNullOrWhiteSpace(subject))
    {
        message.Subject = subject;
    }
    if (!string.IsNullOrWhiteSpace(contentType))
    {
        message.ContentType = contentType;
    }
    await sender.SendMessageAsync(message);

    await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new { sent = 1 }));
    return 0;
}

// DESTRUCTIVE (write): consume (ReceiveAndDelete) the next single message from a queue /
// subscription (or its DLQ) and return it — the message is removed. Needs Data Receiver. The
// bridge gates this behind an explicit confirmation. Returns `{"received": <msg>|null}`.
static async Task<int> ReceiveAsync(Dictionary<string, string> opts)
{
    var ns = Require(opts, "namespace");
    var entity = Require(opts, "entity");
    opts.TryGetValue("subscription", out var subscription);
    var dlq = opts.ContainsKey("dlq");

    var credential = new DefaultAzureCredential();
    await using var client = new ServiceBusClient(ns, credential);
    var receiverOptions = new ServiceBusReceiverOptions
    {
        SubQueue = dlq ? SubQueue.DeadLetter : SubQueue.None,
        ReceiveMode = ServiceBusReceiveMode.ReceiveAndDelete
    };
    await using ServiceBusReceiver receiver = string.IsNullOrWhiteSpace(subscription)
        ? client.CreateReceiver(entity, receiverOptions)
        : client.CreateReceiver(entity, subscription, receiverOptions);

    var message = await receiver.ReceiveMessageAsync(TimeSpan.FromSeconds(5));
    object? received = message is null
        ? null
        : new
        {
            messageId = message.MessageId,
            sequenceNumber = message.SequenceNumber,
            enqueuedTime = message.EnqueuedTime.UtcDateTime.ToString("o"),
            subject = string.IsNullOrEmpty(message.Subject) ? null : message.Subject,
            deliveryCount = message.DeliveryCount,
            body = SafeBody(message),
            deadLetterReason = message.DeadLetterReason
        };

    await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new { received }));
    return 0;
}

// Body may be binary; never throw on render. Truncate so a huge payload can't flood the wire.
static string SafeBody(ServiceBusReceivedMessage message)
{
    try
    {
        var text = message.Body.ToString();
        const int max = 4000;
        return text.Length > max ? text[..max] + "…" : text;
    }
    catch
    {
        return "(binary payload)";
    }
}

static Dictionary<string, string> ParseOptions(ReadOnlySpan<string> args)
{
    var opts = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    for (var i = 0; i < args.Length; i++)
    {
        var token = args[i];
        if (!token.StartsWith("--", StringComparison.Ordinal))
        {
            continue;
        }
        var key = token[2..];
        // A flag (e.g. --dlq) has no value; a value option consumes the next token.
        if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
        {
            opts[key] = args[++i];
        }
        else
        {
            opts[key] = "true";
        }
    }
    return opts;
}

static string Require(Dictionary<string, string> opts, string key)
{
    if (!opts.TryGetValue(key, out var value) || string.IsNullOrWhiteSpace(value))
    {
        throw new ArgumentException($"missing required --{key}");
    }
    return value;
}
