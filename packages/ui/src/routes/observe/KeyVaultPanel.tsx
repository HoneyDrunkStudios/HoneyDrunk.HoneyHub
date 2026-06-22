import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  AzureSubscription,
  AzureSubscriptionList,
  KeyVault,
  KeyVaultList,
  VaultObject,
  VaultObjects
} from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { formatRelative, useRelativeNow } from "../../relativeTime";
import {
  expiryState,
  filterVaultObjects,
  filterVaults,
  initialSelection,
  loadSelectedSubscriptions,
  parseInstantMs,
  saveSelectedSubscriptions,
  subscriptionKey,
  type ExpiryState
} from "./keyVaultModel";

/** The vault currently expanded to browse its objects (echoed back to correlate responses). */
interface ExpandedVault {
  vault: string;
  subscriptionId: string;
}

/**
 * The Azure Key Vault panel: pick the subscriptions to look at, see their vaults, then expand a
 * vault to browse its secrets / keys / certificates (metadata only) with expiry badges, and reveal
 * a single secret's value on demand. Read-only; rides the operator's host `az` sign-in, with honest
 * not-signed-in / no-access states like the other connectors. A revealed value lives only in this
 * component's state (never persisted or logged) and is cleared on hide / collapse.
 */
export function KeyVaultPanel({
  client,
  active
}: Readonly<{ client: WireClient; active: boolean }>): ReactElement {
  const [subscriptions, setSubscriptions] = useState<AzureSubscriptionList | undefined>(undefined);
  const [selected, setSelected] = useState<string[]>([]);
  const [vaultList, setVaultList] = useState<KeyVaultList | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | undefined>(undefined);
  const now = useRelativeNow(active);
  // The key of the most-recently-requested subscription set, so a stale/out-of-order `key_vaults`
  // response for a previous selection is ignored rather than clobbering the current list.
  const requestedKey = useRef<string>("");

  // Object browse (one expanded vault at a time, accordion-style).
  const [expanded, setExpanded] = useState<ExpandedVault | undefined>(undefined);
  // Mirror of `expanded` for the subscribe handler to correlate vault_objects / secret_reveal
  // responses without re-subscribing on every expand.
  const expandedRef = useRef<ExpandedVault | undefined>(undefined);
  const [objects, setObjects] = useState<VaultObjects | undefined>(undefined);
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [objectQuery, setObjectQuery] = useState("");
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealError, setRevealError] = useState<Record<string, string>>({});
  const [revealing, setRevealing] = useState<string | undefined>(undefined);

  const loadVaults = useCallback(
    (ids: string[]) => {
      requestedKey.current = subscriptionKey(ids);
      setLoading(true);
      client.listKeyVaults(ids).catch(() => {
        setError("could not read Key Vaults");
        setLoading(false);
      });
    },
    [client]
  );

  // Apply a new subscription selection: remember it, then re-list the vaults for it.
  const applySelection = useCallback(
    (ids: string[]) => {
      setSelected(ids);
      saveSelectedSubscriptions(ids);
      loadVaults(ids);
    },
    [loadVaults]
  );

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      const { payload } = event;
      if (payload.kind === "azure_subscriptions") {
        setSubscriptions(payload.subscriptions);
        if (payload.subscriptions.available) {
          const ids = initialSelection(
            payload.subscriptions.subscriptions,
            loadSelectedSubscriptions()
          );
          setSelected(ids);
          loadVaults(ids);
        } else {
          setLoading(false);
        }
      } else if (payload.kind === "key_vaults") {
        // Ignore a response whose echoed subscription set no longer matches the current request.
        if (subscriptionKey(payload.vaults.subscriptionIds ?? []) !== requestedKey.current) {
          return;
        }
        setVaultList(payload.vaults);
        setUpdatedAt(Date.now());
        setLoading(false);
        setError(undefined);
      } else if (payload.kind === "vault_objects") {
        // Only accept objects for the vault we currently have expanded.
        const incoming = payload.objects;
        const target = expandedRef.current;
        if (
          target !== undefined &&
          incoming.vault === target.vault &&
          incoming.subscriptionId === target.subscriptionId
        ) {
          setObjects(incoming);
          setObjectsLoading(false);
        }
      } else if (payload.kind === "secret_reveal") {
        const result = payload.reveal;
        const target = expandedRef.current;
        // Correlate by vault AND subscription so a same-named vault in another subscription can't
        // misattribute a reveal.
        if (
          target === undefined ||
          result.vault !== target.vault ||
          result.subscriptionId !== target.subscriptionId
        ) {
          return;
        }
        setRevealing(undefined);
        if (result.ok && result.value !== undefined) {
          const value = result.value;
          setRevealed((prev) => ({ ...prev, [result.name]: value }));
        } else {
          setRevealError((prev) => ({
            ...prev,
            [result.name]: result.error ?? "could not reveal"
          }));
        }
      }
    });
    return unsubscribe;
  }, [client, loadVaults]);

  // On activation, (re)read the subscription list; subscriptions change rarely, so no poll.
  const refresh = useCallback(() => {
    setLoading(true);
    setError(undefined);
    client.listAzureSubscriptions().catch(() => {
      setError("could not read subscriptions");
      setLoading(false);
    });
  }, [client]);

  useEffect(() => {
    if (active) {
      refresh();
    }
  }, [active, refresh]);

  const collapse = useCallback(() => {
    setExpanded(undefined);
    expandedRef.current = undefined;
    setObjects(undefined);
    setObjectsLoading(false);
    setObjectQuery("");
    setRevealed({});
    setRevealError({});
    setRevealing(undefined);
  }, []);

  const toggleExpand = useCallback(
    (vault: KeyVault) => {
      if (expanded?.vault === vault.name && expanded.subscriptionId === vault.subscriptionId) {
        collapse();
        return;
      }
      const target: ExpandedVault = { vault: vault.name, subscriptionId: vault.subscriptionId };
      setExpanded(target);
      expandedRef.current = target;
      setObjects(undefined);
      setObjectQuery("");
      setRevealed({});
      setRevealError({});
      setRevealing(undefined);
      setObjectsLoading(true);
      client.listVaultObjects(vault.name, vault.subscriptionId).catch(() => {
        setObjectsLoading(false);
        setObjects({
          available: false,
          error: "could not read the vault",
          vault: vault.name,
          subscriptionId: vault.subscriptionId,
          objects: []
        });
      });
    },
    [client, expanded, collapse]
  );

  const reveal = useCallback(
    (name: string) => {
      const target = expandedRef.current;
      if (target === undefined) {
        return;
      }
      setRevealing(name);
      setRevealError((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      client.revealSecret(target.vault, target.subscriptionId, name).catch(() => {
        setRevealing(undefined);
        setRevealError((prev) => ({ ...prev, [name]: "could not reveal" }));
      });
    },
    [client]
  );

  const hide = useCallback((name: string) => {
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    setRevealError((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }, []);

  const toggleSubscription = (id: string): void => {
    const next = selected.includes(id)
      ? selected.filter((value) => value !== id)
      : [...selected, id];
    applySelection(next);
  };

  const subscriptionName = useCallback(
    (id: string): string =>
      subscriptions?.subscriptions.find((subscription) => subscription.id === id)?.name ?? id,
    [subscriptions]
  );

  const vaults = useMemo(
    () => (vaultList === undefined ? [] : filterVaults(vaultList.vaults, query)),
    [vaultList, query]
  );

  const subscriptionsUnavailable = subscriptions !== undefined && !subscriptions.available;
  const vaultsUnavailable = vaultList !== undefined && !vaultList.available;
  const unreadable = vaultList?.available ? vaultList.unreadable ?? [] : [];
  const vaultEmptyMessage =
    query.trim() === "" ? "No Key Vaults in the selected subscriptions." : `No vaults match “${query}”.`;

  return (
    <div className="kv-panel sb-panel">
      <div className="sb-head">
        <h3>Azure Key Vault</h3>
        <div className="sb-actions">
          {updatedAt !== undefined && (
            <span className="updated-stamp">updated {formatRelative(now, updatedAt)}</span>
          )}
          <input
            className="sb-search"
            type="search"
            aria-label="Filter Key Vaults"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name / group / location…"
          />
          <button type="button" onClick={refresh} disabled={loading}>
            {loading ? "Reading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error !== undefined && (
        <p role="alert" className="sb-error">
          {error}
        </p>
      )}

      {subscriptionsUnavailable && (
        <p className="sb-unavailable">Key Vault: {subscriptions?.error ?? "not available"}</p>
      )}

      {subscriptions === undefined && !subscriptionsUnavailable && (
        <p className="sb-empty">{loading ? "Reading subscriptions…" : "No subscriptions yet."}</p>
      )}

      {subscriptions?.available && (
        <>
          <KeyVaultSubscriptions
            subscriptions={subscriptions.subscriptions}
            selected={selected}
            onToggle={toggleSubscription}
          />
          {vaultsUnavailable && (
            <p className="sb-unavailable">Key Vault: {vaultList?.error ?? "not available"}</p>
          )}
          {unreadable.length > 0 && (
            <p className="sb-unavailable">
              Could not read {unreadable.length} subscription
              {unreadable.length === 1 ? "" : "s"}: {unreadable.map(subscriptionName).join(", ")}
            </p>
          )}
          {vaultList?.available &&
            (vaults.length === 0 ? (
              <p className="sb-empty">{vaultEmptyMessage}</p>
            ) : (
              <ul className="kv-vaults">
                {vaults.map((vault) => (
                  <VaultRow
                    key={`${vault.subscriptionId}/${vault.name}`}
                    vault={vault}
                    subscriptionName={subscriptionName}
                    expanded={
                      expanded?.vault === vault.name &&
                      expanded.subscriptionId === vault.subscriptionId
                    }
                    onToggle={() => toggleExpand(vault)}
                    objects={objects}
                    objectsLoading={objectsLoading}
                    objectQuery={objectQuery}
                    onObjectQuery={setObjectQuery}
                    nowMs={now}
                    revealed={revealed}
                    revealError={revealError}
                    revealing={revealing}
                    onReveal={reveal}
                    onHide={hide}
                  />
                ))}
              </ul>
            ))}
        </>
      )}
    </div>
  );
}

/** The subscription multi-select: one checkbox per subscription (default-tagged). */
function KeyVaultSubscriptions({
  subscriptions,
  selected,
  onToggle
}: Readonly<{
  subscriptions: AzureSubscription[];
  selected: string[];
  onToggle: (id: string) => void;
}>): ReactElement {
  if (subscriptions.length === 0) {
    return <p className="sb-empty">No subscriptions found.</p>;
  }
  return (
    <fieldset className="kv-subs">
      <legend>Subscriptions</legend>
      {subscriptions.map((subscription) => (
        <label key={subscription.id} className="kv-sub">
          <input
            type="checkbox"
            checked={selected.includes(subscription.id)}
            onChange={() => onToggle(subscription.id)}
          />
          <span className="kv-sub-name">{subscription.name}</span>
          {subscription.isDefault && <span className="kv-sub-default">default</span>}
        </label>
      ))}
    </fieldset>
  );
}

/** One vault row: a disclosure button (name / group / location / subscription) that expands to the
    vault's secrets/keys/certificates. */
function VaultRow({
  vault,
  subscriptionName,
  expanded,
  onToggle,
  objects,
  objectsLoading,
  objectQuery,
  onObjectQuery,
  nowMs,
  revealed,
  revealError,
  revealing,
  onReveal,
  onHide
}: Readonly<{
  vault: KeyVault;
  subscriptionName: (id: string) => string;
  expanded: boolean;
  onToggle: () => void;
  objects: VaultObjects | undefined;
  objectsLoading: boolean;
  objectQuery: string;
  onObjectQuery: (value: string) => void;
  nowMs: number;
  revealed: Record<string, string>;
  revealError: Record<string, string>;
  revealing: string | undefined;
  onReveal: (name: string) => void;
  onHide: (name: string) => void;
}>): ReactElement {
  return (
    <li className={`kv-vault ${expanded ? "is-expanded" : ""}`}>
      <button type="button" className="kv-vault-row" aria-expanded={expanded} onClick={onToggle}>
        <span className="kv-caret" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="kv-vault-name">{vault.name}</span>
        <span className="kv-vault-rg">{vault.resourceGroup}</span>
        {vault.location !== undefined && <span className="kv-vault-loc">{vault.location}</span>}
        <span className="kv-vault-sub">{subscriptionName(vault.subscriptionId)}</span>
      </button>
      {expanded && (
        <VaultObjectsView
          objects={objects}
          loading={objectsLoading}
          query={objectQuery}
          onQuery={onObjectQuery}
          nowMs={nowMs}
          revealed={revealed}
          revealError={revealError}
          revealing={revealing}
          onReveal={onReveal}
          onHide={onHide}
        />
      )}
    </li>
  );
}

/** The expanded vault's body: loading / unavailable / empty states, or the filtered object list. */
function VaultObjectsView({
  objects,
  loading,
  query,
  onQuery,
  nowMs,
  revealed,
  revealError,
  revealing,
  onReveal,
  onHide
}: Readonly<{
  objects: VaultObjects | undefined;
  loading: boolean;
  query: string;
  onQuery: (value: string) => void;
  nowMs: number;
  revealed: Record<string, string>;
  revealError: Record<string, string>;
  revealing: string | undefined;
  onReveal: (name: string) => void;
  onHide: (name: string) => void;
}>): ReactElement {
  const filtered = useMemo(
    () => (objects === undefined ? [] : filterVaultObjects(objects.objects, query)),
    [objects, query]
  );

  if (loading) {
    return <p className="sb-empty kv-objects-status">Reading the vault…</p>;
  }
  if (objects === undefined) {
    return <p className="sb-empty kv-objects-status">No contents yet.</p>;
  }
  if (!objects.available) {
    return <p className="sb-unavailable kv-objects-status">{objects.error ?? "not available"}</p>;
  }

  return (
    <div className="kv-objects">
      <input
        className="sb-search kv-objects-search"
        type="search"
        aria-label={`Filter ${objects.vault} contents`}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        placeholder="Filter by name / kind…"
      />
      {filtered.length === 0 ? (
        <p className="sb-empty kv-objects-status">
          {objects.objects.length === 0
            ? "No secrets, keys, or certificates (or no access to them)."
            : `No contents match “${query}”.`}
        </p>
      ) : (
        <ul className="kv-object-list">
          {filtered.map((object) => (
            <ObjectRow
              key={`${object.kind}/${object.name}`}
              object={object}
              nowMs={nowMs}
              revealedValue={revealed[object.name]}
              revealErrorText={revealError[object.name]}
              revealing={revealing === object.name}
              onReveal={() => onReveal(object.name)}
              onHide={() => onHide(object.name)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

const KIND_BADGE: Record<VaultObject["kind"], string> = {
  secret: "S",
  key: "K",
  certificate: "C"
};

/** One object row: kind badge, name, disabled tag, expiry badge, and (for secrets) reveal/hide. */
function ObjectRow({
  object,
  nowMs,
  revealedValue,
  revealErrorText,
  revealing,
  onReveal,
  onHide
}: Readonly<{
  object: VaultObject;
  nowMs: number;
  revealedValue: string | undefined;
  revealErrorText: string | undefined;
  revealing: boolean;
  onReveal: () => void;
  onHide: () => void;
}>): ReactElement {
  return (
    <li className="kv-object">
      <div className="kv-object-head">
        <span className={`kv-object-kind kv-object-kind-${object.kind}`} title={object.kind}>
          {KIND_BADGE[object.kind]}
        </span>
        <span className="kv-object-name">{object.name}</span>
        {!object.enabled && <span className="kv-object-disabled">disabled</span>}
        <ExpiryBadge expires={object.expires} nowMs={nowMs} />
        {object.kind === "secret" && (
          <span className="kv-object-actions">
            {revealedValue === undefined ? (
              <button type="button" className="kv-reveal-btn" disabled={revealing} onClick={onReveal}>
                {revealing ? "Revealing…" : "Reveal"}
              </button>
            ) : (
              <button type="button" className="link-button" onClick={onHide}>
                Hide
              </button>
            )}
          </span>
        )}
      </div>
      {revealErrorText !== undefined && (
        <p className="sb-unavailable kv-reveal-error">{revealErrorText}</p>
      )}
      {revealedValue !== undefined && <SecretValue value={revealedValue} />}
    </li>
  );
}

/** The expiry badge: nothing when no expiry is set; otherwise a dated, state-coloured pill. */
function ExpiryBadge({
  expires,
  nowMs
}: Readonly<{ expires: string | undefined; nowMs: number }>): ReactElement | null {
  const state: ExpiryState = expiryState(expires, nowMs);
  if (state === "none") {
    return null;
  }
  const at = parseInstantMs(expires);
  const date = at === undefined ? "" : new Date(at).toISOString().slice(0, 10);
  const label = state === "expired" ? `expired ${date}` : `expires ${date}`;
  return <span className={`kv-expiry kv-expiry-${state}`}>{label}</span>;
}

/** A revealed secret value: shown in a monospace box with a copy button. Held only in component
    state (never persisted or logged); cleared on Hide / collapse. */
function SecretValue({ value }: Readonly<{ value: string }>): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(value).then(
      () => setCopied(true),
      () => undefined
    );
  };
  return (
    <div className="kv-secret-value">
      <code className="kv-secret-text">{value}</code>
      <button type="button" className="link-button" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
