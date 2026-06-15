import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockWireClient } from "../../wire/mockClient";
import { ConnectPhone } from "./ConnectPhone";

describe("ConnectPhone", () => {
  it("on loopback, guides the user to bind a reachable address (no false QR)", async () => {
    // jsdom serves the page from http://localhost, i.e. a loopback host.
    const client = new MockWireClient();
    render(<ConnectPhone client={client} active />);

    // The mock scripts a tailnet + a LAN address.
    expect(await screen.findByText("100.110.120.130")).toBeTruthy();
    expect(screen.getByText("192.168.1.42")).toBeTruthy();
    // It does NOT pretend a QR works while loopback-bound.
    expect(screen.queryByRole("img", { name: /pairing QR/i })).toBeNull();
    // It surfaces the exact env var to bind the (tailnet-first) selected address.
    await waitFor(() =>
      expect(screen.getByText(/HONEYHUB_BRIDGE_ADDR=100\.110\.120\.130/)).toBeTruthy()
    );
  });

  it("does not query the host while inactive", () => {
    let calls = 0;
    const client = new MockWireClient();
    const original = client.listNetwork.bind(client);
    client.listNetwork = () => {
      calls += 1;
      return original();
    };
    render(<ConnectPhone client={client} active={false} />);
    expect(calls).toBe(0);
  });
});
