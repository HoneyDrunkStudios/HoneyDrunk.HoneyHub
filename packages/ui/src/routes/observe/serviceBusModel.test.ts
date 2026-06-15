import { describe, expect, it } from "vitest";
import type { ServiceBusEntity, ServiceBusSnapshot } from "@honeydrunk/honeyhub-types";
import { byAttention, filterEntities, serviceBusTotals } from "./serviceBusModel";

function entity(partial: Partial<ServiceBusEntity> & Pick<ServiceBusEntity, "name">): ServiceBusEntity {
  return {
    kind: "queue",
    namespace: "ns",
    status: "Active",
    active: 0,
    deadLetter: 0,
    scheduled: 0,
    ...partial
  };
}

describe("serviceBusModel", () => {
  it("totals namespaces, entities, active, and dead-letter", () => {
    const snapshot: ServiceBusSnapshot = {
      available: true,
      namespaces: [
        {
          name: "ns1",
          resourceGroup: "rg",
          entities: [entity({ name: "q1", active: 5, deadLetter: 2 }), entity({ name: "q2", active: 1 })]
        },
        { name: "ns2", resourceGroup: "rg", entities: [entity({ name: "q3", deadLetter: 4 })] }
      ]
    };
    expect(serviceBusTotals(snapshot)).toEqual({
      namespaces: 2,
      entities: 3,
      active: 6,
      deadLetter: 6
    });
  });

  it("filters by name, namespace, and topic", () => {
    const items = [
      entity({ name: "orders", namespace: "hd-bus" }),
      entity({ name: "sub", namespace: "hd-bus", topic: "events", kind: "subscription" })
    ];
    expect(filterEntities(items, "events").map((e) => e.name)).toEqual(["sub"]);
    expect(filterEntities(items, "ORDERS").map((e) => e.name)).toEqual(["orders"]);
    expect(filterEntities(items, "")).toHaveLength(2);
  });

  it("sorts dead-letter first, then active", () => {
    const items = [
      entity({ name: "a", active: 9, deadLetter: 0 }),
      entity({ name: "b", active: 0, deadLetter: 3 }),
      entity({ name: "c", active: 1, deadLetter: 3 })
    ];
    expect(byAttention(items).map((e) => e.name)).toEqual(["c", "b", "a"]);
  });
});
