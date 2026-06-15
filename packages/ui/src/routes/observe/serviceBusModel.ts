import type { ServiceBusEntity, ServiceBusSnapshot } from "@honeydrunk/honeyhub-types";

// Pure helpers for the Service Bus panel: totals (so the header can headline the dead-letter
// backlog), and case-insensitive filtering across entity + namespace + topic. Kept out of the
// component so they're unit-testable.

export interface ServiceBusTotals {
  namespaces: number;
  entities: number;
  active: number;
  deadLetter: number;
}

export function serviceBusTotals(snapshot: ServiceBusSnapshot): ServiceBusTotals {
  let entities = 0;
  let active = 0;
  let deadLetter = 0;
  for (const ns of snapshot.namespaces) {
    for (const entity of ns.entities) {
      entities += 1;
      active += entity.active;
      deadLetter += entity.deadLetter;
    }
  }
  return { namespaces: snapshot.namespaces.length, entities, active, deadLetter };
}

/** Filter entities by a case-insensitive substring over name + namespace + topic (blank = all). */
export function filterEntities(entities: ServiceBusEntity[], query: string): ServiceBusEntity[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return entities;
  }
  return entities.filter((entity) => {
    const haystack = `${entity.name} ${entity.namespace} ${entity.topic ?? ""}`.toLowerCase();
    return haystack.includes(needle);
  });
}

/** Entities sorted so the ones that need attention (dead-letter, then active) float up. */
export function byAttention(entities: ServiceBusEntity[]): ServiceBusEntity[] {
  return [...entities].sort((a, b) => b.deadLetter - a.deadLetter || b.active - a.active);
}
