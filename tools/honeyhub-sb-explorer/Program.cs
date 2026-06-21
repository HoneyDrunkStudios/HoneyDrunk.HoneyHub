using System.Text.Json;
using Azure.Identity;
using Azure.Messaging.ServiceBus;
using Azure.Messaging.ServiceBus.Administration;

// HoneyHub Service Bus explorer helper — see the .csproj header for the why.
//
// Auth (HoneyHub connections, ADR-0094 D5): every verb takes EITHER `--connection-string`
// (a SAS string, cockpit-held, never persisted host-side) OR `--namespace <fqdn>` (Azure AD
// via DefaultAzureCredential, reusing `az login`). Data-plane verbs use ServiceBusClient;
// management + entity listing use ServiceBusAdministrationClient — both support either auth.
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

    return verb switch
    {
        "peek" => await PeekAsync(opts),
        "resubmit" => await ResubmitAsync(opts),
        "purge" => await PurgeAsync(opts),
        "send" => await SendAsync(opts),
        "receive" => await ReceiveAsync(opts),
        "entities" => await EntitiesAsync(opts),
        "create-queue" => await CreateQueueAsync(opts),
        "delete-queue" => await DeleteQueueAsync(opts),
        "update-queue" => await UpdateQueueAsync(opts),
        "create-topic" => await CreateTopicAsync(opts),
        "delete-topic" => await DeleteTopicAsync(opts),
        "update-topic" => await UpdateTopicAsync(opts),
        "create-subscription" => await CreateSubscriptionAsync(opts),
        "delete-subscription" => await DeleteSubscriptionAsync(opts),
        "update-subscription" => await UpdateSubscriptionAsync(opts),
        _ => await UnknownVerb(verb)
    };
}
catch (Exception ex)
{
    // Keep it short; the bridge decides the user-facing hint. Auth failures surface clearly.
    await Console.Error.WriteLineAsync(ex is CredentialUnavailableException or AuthenticationFailedException
        ? "not signed in (run az login) or missing the required Azure Service Bus role"
        : ex.Message);
    return 1;
}

static async Task<int> UnknownVerb(string verb)
{
    await Console.Error.WriteLineAsync($"unknown verb: {verb}");
    return 2;
}

// --- Auth: a client/admin-client from a connection string OR namespace + AAD. ---

static ServiceBusClient CreateClient(Dictionary<string, string> opts)
{
    if (opts.TryGetValue("connection-string", out var cs) && !string.IsNullOrWhiteSpace(cs))
    {
        return new ServiceBusClient(cs);
    }
    return new ServiceBusClient(Require(opts, "namespace"), new DefaultAzureCredential());
}

static ServiceBusAdministrationClient CreateAdmin(Dictionary<string, string> opts)
{
    if (opts.TryGetValue("connection-string", out var cs) && !string.IsNullOrWhiteSpace(cs))
    {
        return new ServiceBusAdministrationClient(cs);
    }
    return new ServiceBusAdministrationClient(Require(opts, "namespace"), new DefaultAzureCredential());
}

// --- Data-plane verbs ---

static async Task<int> PeekAsync(Dictionary<string, string> opts)
{
    var entity = Require(opts, "entity");
    opts.TryGetValue("subscription", out var subscription);
    var dlq = opts.ContainsKey("dlq");
    var count = opts.TryGetValue("count", out var rawCount) && int.TryParse(rawCount, out var c)
        ? Math.Clamp(c, 1, 100)
        : 20;

    await using var client = CreateClient(opts);
    var receiverOptions = new ServiceBusReceiverOptions { SubQueue = dlq ? SubQueue.DeadLetter : SubQueue.None };
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

    return await Ok(new { messages = rows });
}

// DESTRUCTIVE (write): drain up to N dead-letter messages back to their source. Confirmation
// gated by the bridge; the helper just performs the move.
static async Task<int> ResubmitAsync(Dictionary<string, string> opts)
{
    var entity = Require(opts, "entity");
    opts.TryGetValue("subscription", out var subscription);
    var count = opts.TryGetValue("count", out var rawCount) && int.TryParse(rawCount, out var c)
        ? Math.Clamp(c, 1, 100)
        : 1;

    await using var client = CreateClient(opts);
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
        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new { moved, error = ex.Message }));
        return 1;
    }

    return await Ok(new { moved });
}

// DESTRUCTIVE (write): drain ALL messages from a queue/subscription; `--dlq` drains the DLQ.
static async Task<int> PurgeAsync(Dictionary<string, string> opts)
{
    var entity = Require(opts, "entity");
    opts.TryGetValue("subscription", out var subscription);
    var dlq = opts.ContainsKey("dlq");

    await using var client = CreateClient(opts);
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

    return await Ok(new { purged });
}

// WRITE: publish a single message to a queue or topic.
static async Task<int> SendAsync(Dictionary<string, string> opts)
{
    var entity = Require(opts, "entity");
    var body = Require(opts, "body");
    opts.TryGetValue("subject", out var subject);
    opts.TryGetValue("content-type", out var contentType);

    await using var client = CreateClient(opts);
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

    return await Ok(new { sent = 1 });
}

// DESTRUCTIVE (write): consume + remove the next single message from a queue/subscription.
static async Task<int> ReceiveAsync(Dictionary<string, string> opts)
{
    var entity = Require(opts, "entity");
    opts.TryGetValue("subscription", out var subscription);
    var dlq = opts.ContainsKey("dlq");

    await using var client = CreateClient(opts);
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

    return await Ok(new { received });
}

// --- Management (admin client): list + create/delete/update entities + properties ---

static async Task<int> EntitiesAsync(Dictionary<string, string> opts)
{
    var admin = CreateAdmin(opts);

    var queues = new List<object>();
    await foreach (var q in admin.GetQueuesAsync())
    {
        var rt = (await admin.GetQueueRuntimePropertiesAsync(q.Name)).Value;
        queues.Add(new
        {
            name = q.Name,
            status = q.Status.ToString(),
            active = rt.ActiveMessageCount,
            deadLetter = rt.DeadLetterMessageCount,
            scheduled = rt.ScheduledMessageCount,
            maxSizeMb = q.MaxSizeInMegabytes,
            maxDeliveryCount = q.MaxDeliveryCount,
            lockDurationSeconds = (long)q.LockDuration.TotalSeconds,
            defaultTtlSeconds = ToSeconds(q.DefaultMessageTimeToLive),
            deadLetterOnExpiration = q.DeadLetteringOnMessageExpiration
        });
    }

    var topics = new List<object>();
    await foreach (var t in admin.GetTopicsAsync())
    {
        var subs = new List<object>();
        await foreach (var s in admin.GetSubscriptionsAsync(t.Name))
        {
            var srt = (await admin.GetSubscriptionRuntimePropertiesAsync(t.Name, s.SubscriptionName)).Value;
            subs.Add(new
            {
                name = s.SubscriptionName,
                status = s.Status.ToString(),
                active = srt.ActiveMessageCount,
                deadLetter = srt.DeadLetterMessageCount,
                maxDeliveryCount = s.MaxDeliveryCount,
                lockDurationSeconds = (long)s.LockDuration.TotalSeconds,
                defaultTtlSeconds = ToSeconds(s.DefaultMessageTimeToLive),
                deadLetterOnExpiration = s.DeadLetteringOnMessageExpiration
            });
        }
        topics.Add(new
        {
            name = t.Name,
            status = t.Status.ToString(),
            maxSizeMb = t.MaxSizeInMegabytes,
            defaultTtlSeconds = ToSeconds(t.DefaultMessageTimeToLive),
            subscriptions = subs
        });
    }

    return await Ok(new { queues, topics });
}

static async Task<int> CreateQueueAsync(Dictionary<string, string> opts)
{
    var admin = CreateAdmin(opts);
    var name = Require(opts, "entity");
    var options = new CreateQueueOptions(name);
    if (TryMb(opts, "max-size-mb", out var mb)) options.MaxSizeInMegabytes = mb;
    if (TryInt(opts, "max-delivery-count", out var mdc)) options.MaxDeliveryCount = mdc;
    if (TrySeconds(opts, "lock-duration-seconds", out var ld)) options.LockDuration = ld;
    if (TrySeconds(opts, "default-ttl-seconds", out var ttl)) options.DefaultMessageTimeToLive = ttl;
    if (TryBool(opts, "dead-letter-on-expiration", out var dle)) options.DeadLetteringOnMessageExpiration = dle;
    if (TryStatus(opts, out var status)) options.Status = status;
    await admin.CreateQueueAsync(options);
    return await Ok(new { created = name });
}

static async Task<int> DeleteQueueAsync(Dictionary<string, string> opts)
{
    var admin = CreateAdmin(opts);
    var name = Require(opts, "entity");
    await admin.DeleteQueueAsync(name);
    return await Ok(new { deleted = name });
}

static async Task<int> UpdateQueueAsync(Dictionary<string, string> opts)
{
    var admin = CreateAdmin(opts);
    var name = Require(opts, "entity");
    var props = (await admin.GetQueueAsync(name)).Value;
    if (TryMb(opts, "max-size-mb", out var mb)) props.MaxSizeInMegabytes = mb;
    if (TryInt(opts, "max-delivery-count", out var mdc)) props.MaxDeliveryCount = mdc;
    if (TrySeconds(opts, "lock-duration-seconds", out var ld)) props.LockDuration = ld;
    if (TrySeconds(opts, "default-ttl-seconds", out var ttl)) props.DefaultMessageTimeToLive = ttl;
    if (TryBool(opts, "dead-letter-on-expiration", out var dle)) props.DeadLetteringOnMessageExpiration = dle;
    if (TryStatus(opts, out var status)) props.Status = status;
    await admin.UpdateQueueAsync(props);
    return await Ok(new { updated = name });
}

static async Task<int> CreateTopicAsync(Dictionary<string, string> opts)
{
    var admin = CreateAdmin(opts);
    var name = Require(opts, "entity");
    var options = new CreateTopicOptions(name);
    if (TryMb(opts, "max-size-mb", out var mb)) options.MaxSizeInMegabytes = mb;
    if (TrySeconds(opts, "default-ttl-seconds", out var ttl)) options.DefaultMessageTimeToLive = ttl;
    if (TryStatus(opts, out var status)) options.Status = status;
    await admin.CreateTopicAsync(options);
    return await Ok(new { created = name });
}

static async Task<int> DeleteTopicAsync(Dictionary<string, string> opts)
{
    var admin = CreateAdmin(opts);
    var name = Require(opts, "entity");
    await admin.DeleteTopicAsync(name);
    return await Ok(new { deleted = name });
}

static async Task<int> UpdateTopicAsync(Dictionary<string, string> opts)
{
    var admin = CreateAdmin(opts);
    var name = Require(opts, "entity");
    var props = (await admin.GetTopicAsync(name)).Value;
    if (TryMb(opts, "max-size-mb", out var mb)) props.MaxSizeInMegabytes = mb;
    if (TrySeconds(opts, "default-ttl-seconds", out var ttl)) props.DefaultMessageTimeToLive = ttl;
    if (TryStatus(opts, out var status)) props.Status = status;
    await admin.UpdateTopicAsync(props);
    return await Ok(new { updated = name });
}

static async Task<int> CreateSubscriptionAsync(Dictionary<string, string> opts)
{
    var admin = CreateAdmin(opts);
    var topic = Require(opts, "entity");
    var subscription = Require(opts, "subscription");
    var options = new CreateSubscriptionOptions(topic, subscription);
    if (TryInt(opts, "max-delivery-count", out var mdc)) options.MaxDeliveryCount = mdc;
    if (TrySeconds(opts, "lock-duration-seconds", out var ld)) options.LockDuration = ld;
    if (TrySeconds(opts, "default-ttl-seconds", out var ttl)) options.DefaultMessageTimeToLive = ttl;
    if (TryBool(opts, "dead-letter-on-expiration", out var dle)) options.DeadLetteringOnMessageExpiration = dle;
    if (TryStatus(opts, out var status)) options.Status = status;
    await admin.CreateSubscriptionAsync(options);
    return await Ok(new { created = $"{topic}/{subscription}" });
}

static async Task<int> DeleteSubscriptionAsync(Dictionary<string, string> opts)
{
    var admin = CreateAdmin(opts);
    var topic = Require(opts, "entity");
    var subscription = Require(opts, "subscription");
    await admin.DeleteSubscriptionAsync(topic, subscription);
    return await Ok(new { deleted = $"{topic}/{subscription}" });
}

static async Task<int> UpdateSubscriptionAsync(Dictionary<string, string> opts)
{
    var admin = CreateAdmin(opts);
    var topic = Require(opts, "entity");
    var subscription = Require(opts, "subscription");
    var props = (await admin.GetSubscriptionAsync(topic, subscription)).Value;
    if (TryInt(opts, "max-delivery-count", out var mdc)) props.MaxDeliveryCount = mdc;
    if (TrySeconds(opts, "lock-duration-seconds", out var ld)) props.LockDuration = ld;
    if (TrySeconds(opts, "default-ttl-seconds", out var ttl)) props.DefaultMessageTimeToLive = ttl;
    if (TryBool(opts, "dead-letter-on-expiration", out var dle)) props.DeadLetteringOnMessageExpiration = dle;
    if (TryStatus(opts, out var status)) props.Status = status;
    await admin.UpdateSubscriptionAsync(props);
    return await Ok(new { updated = $"{topic}/{subscription}" });
}

// --- Helpers ---

static async Task<int> Ok(object payload)
{
    await Console.Out.WriteLineAsync(JsonSerializer.Serialize(payload));
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

// Service Bus uses TimeSpan.MaxValue for "never expires"; report it as a clamped large value
// rather than overflow. (long)TotalSeconds fits, but normalize the max sentinel to keep the UI
// from showing an absurd number.
static long ToSeconds(TimeSpan span)
{
    return span >= TimeSpan.FromDays(3650) ? -1 : (long)span.TotalSeconds;
}

static bool TryInt(Dictionary<string, string> opts, string key, out int value)
{
    value = 0;
    return opts.TryGetValue(key, out var raw) && int.TryParse(raw, out value);
}

static bool TryMb(Dictionary<string, string> opts, string key, out long value)
{
    value = 0;
    return opts.TryGetValue(key, out var raw) && long.TryParse(raw, out value);
}

static bool TrySeconds(Dictionary<string, string> opts, string key, out TimeSpan value)
{
    value = TimeSpan.Zero;
    if (opts.TryGetValue(key, out var raw) && long.TryParse(raw, out var seconds) && seconds > 0)
    {
        value = TimeSpan.FromSeconds(seconds);
        return true;
    }
    return false;
}

static bool TryBool(Dictionary<string, string> opts, string key, out bool value)
{
    value = false;
    if (opts.TryGetValue(key, out var raw) && bool.TryParse(raw, out value))
    {
        return true;
    }
    return false;
}

static bool TryStatus(Dictionary<string, string> opts, out EntityStatus value)
{
    value = EntityStatus.Active;
    return opts.TryGetValue("status", out var raw) && Enum.TryParse(raw, ignoreCase: true, out value);
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
