import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { NetAddress } from "@honeydrunk/honeyhub-types";
import type { WireClient } from "../../wire/client";
import { buildConnectUrl, isLoopbackHost, qrMatrix, tokenFromSearch } from "./mobilePairing";

export interface ConnectPhoneProps {
  client: WireClient;
  /** Mounted only when Settings is active (it subscribes to the network stream). */
  active: boolean;
}

const KIND_LABEL: Record<NetAddress["kind"], string> = {
  tailnet: "Tailscale",
  lan: "Wi-Fi / LAN",
  other: "Other"
};

/**
 * "Connect a phone" (mobile pairing). Shows a QR of the cockpit URL (with its pairing token)
 * so a phone can open the same hub. HONESTY: a QR is only the handoff — the phone can connect
 * ONLY if this host is bound to a reachable address. The desktop binds loopback by default,
 * so when the cockpit is being viewed over 127.0.0.1 we don't pretend a QR will work; we show
 * the reachable addresses we detected and the exact env var to bind one (Tailscale per
 * ADR-0091), then relaunch. Once bound reachable, the current URL *is* the phone URL → QR.
 */
export function ConnectPhone({ client, active }: Readonly<ConnectPhoneProps>): ReactElement {
  const [addresses, setAddresses] = useState<NetAddress[]>([]);
  const [selectedIp, setSelectedIp] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.payload.kind === "network_info") {
        setAddresses(event.payload.network.addresses);
      }
    });
    return unsubscribe;
  }, [client]);

  useEffect(() => {
    if (active) {
      void client.listNetwork().catch(() => undefined);
    }
  }, [active, client]);

  const location = globalThis.location;
  const loopback = isLoopbackHost(location.hostname);
  const token = tokenFromSearch(location.search);
  const port = location.port;

  // Default the address selector to the first detected (tailnet-first ordering from the host).
  useEffect(() => {
    if (selectedIp === undefined && addresses.length > 0) {
      setSelectedIp(addresses[0]?.ip);
    }
  }, [addresses, selectedIp]);

  // When already bound reachable, the current URL *is* the phone URL. When on loopback, there
  // is no working phone URL yet (the host isn't listening on a reachable interface).
  const phoneUrl = useMemo(() => {
    if (!loopback) {
      return buildConnectUrl({
        ip: location.hostname,
        port,
        token,
        protocol: location.protocol
      });
    }
    return undefined;
  }, [loopback, location.hostname, location.protocol, port, token]);

  const qr = useMemo(() => (phoneUrl === undefined ? undefined : qrMatrix(phoneUrl)), [phoneUrl]);

  const bindHint = selectedIp === undefined ? undefined : `${selectedIp}:${port || "8765"}`;

  const copy = (text: string): void => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };

  return (
    <fieldset className="connect-phone">
      <legend>Connect a phone</legend>
      <p className="connect-phone-intro">
        Scan a QR with your phone to open this hub there. Your phone must be able to reach this
        computer: same Wi-Fi, or on your Tailscale tailnet.
      </p>

      {phoneUrl !== undefined && qr !== undefined ? (
        <div className="connect-phone-ready">
          <svg
            className="connect-phone-qr"
            role="img"
            aria-label="Cockpit pairing QR code"
            viewBox={`-2 -2 ${qr.count + 4} ${qr.count + 4}`}
            width={208}
            height={208}
          >
            <rect x={-2} y={-2} width={qr.count + 4} height={qr.count + 4} fill="#ffffff" />
            <path d={qr.path} fill="#0b0e13" />
          </svg>
          <div className="connect-phone-url">
            <code>{phoneUrl}</code>
            <button type="button" onClick={() => copy(phoneUrl)}>
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      ) : (
        <div className="connect-phone-loopback">
          <p className="connect-phone-warn">
            This hub is only listening on <code>{location.hostname}</code> (this computer), so a
            phone can&rsquo;t reach it yet. Bind a reachable address, then relaunch:
          </p>
          {addresses.length === 0 ? (
            <p className="connect-phone-none">
              No reachable LAN or tailnet address detected. Connect to Wi-Fi or start Tailscale,
              then refresh.
            </p>
          ) : (
            <>
              <ul className="connect-phone-addrs">
                {addresses.map((address) => (
                  <li key={address.ip}>
                    <label>
                      <input
                        type="radio"
                        name="connect-phone-addr"
                        checked={selectedIp === address.ip}
                        onChange={() => setSelectedIp(address.ip)}
                      />
                      <code>{address.ip}</code>
                      <span className={`addr-kind addr-kind-${address.kind}`}>
                        {KIND_LABEL[address.kind]}
                      </span>
                      {address.interface !== undefined && (
                        <span className="addr-iface">{address.interface}</span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
              {bindHint !== undefined && (
                <div className="connect-phone-bind">
                  <p>Set this, then relaunch HoneyHub:</p>
                  <code>HONEYHUB_BRIDGE_ADDR={bindHint}</code>
                  <button type="button" onClick={() => copy(`HONEYHUB_BRIDGE_ADDR=${bindHint}`)}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              )}
              <p className="connect-phone-note">
                Tailscale (the tailnet address) is recommended; it stays reachable off your
                local network and isn&rsquo;t exposed to the public internet.
              </p>
            </>
          )}
        </div>
      )}
    </fieldset>
  );
}
