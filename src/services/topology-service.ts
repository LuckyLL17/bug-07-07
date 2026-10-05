import { DomainError } from '../core/errors';
import { newId } from '../core/id';
import { TwinStore } from '../domain/store';
import { TopologyEdge, TopologyVersion } from '../domain/types';

export interface ImpactEdge extends TopologyEdge { traceId:string }

// Deep-freeze a stored snapshot so accidental internal leakage cannot mutate
// history. Frozen state also guarantees snapshots are never shared-writable.
function deepFreeze<T>(value:T, seen:WeakMap<object,object> = new WeakMap()):T {
  if(value === null || typeof value !== 'object') return value;
  const existing = seen.get(value as object);
  if(existing) return existing as T;
  seen.set(value as object, value as object);
  for(const key of Reflect.ownKeys(value as object)){
    const child = (value as Record<PropertyKey, unknown>)[key as PropertyKey];
    if(child !== null && typeof child === 'object') deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

export class TopologyService {
  constructor(private store:TwinStore){}

  // Publish boundary: the input is cloned before validation/storage, and the
  // returned value is an independent copy of the frozen snapshot. Mutating the
  // caller's input afterwards (edges, nodes, metadata) cannot touch storage.
  publish(version:TopologyVersion):TopologyVersion {
    if(version.version !== this.store.topology.length + 1)
      throw new DomainError('VERSION_GAP','topology version must be sequential');
    const snapshot = deepFreeze(structuredClone(version));
    this.store.topology.push(snapshot);
    return structuredClone(snapshot);
  }

  // Resolve the effective version for a given time without exposing storage.
  // Public result: fresh deep copy; callers own it completely.
  current(at:number):TopologyVersion {
    return structuredClone(this.snapshot(at));
  }

  // Internal boundary: read-only frozen snapshot for services running an
  // analysis. Analysis code works from this stable view and must clone if it
  // needs to mark edges/nodes locally.
  private snapshot(at:number):Readonly<TopologyVersion> {
    let chosen:TopologyVersion | undefined;
    for(const v of this.store.topology){
      if(v.effectiveAt <= at) chosen = v;
    }
    if(!chosen) throw new DomainError('NO_TOPOLOGY','no effective topology');
    return chosen;
  }

  // Query boundary: each impact result is a fresh graph of fresh edge objects.
  impact(assetId:string,at:number):ImpactEdge[] {
    return this.impactWithin(this.snapshot(at), assetId);
  }

  // Root-cause analysis boundary: a private, mutable deep copy of one version.
  // An analyst may temporarily mark edges/nodes/metadata on this view without
  // touching storage, other versions, query results or concurrent analyses.
  view(at:number):TopologyVersion {
    return structuredClone(this.snapshot(at));
  }

  // Analysis boundary: evaluate impact against a view the caller already
  // holds, so an in-progress analysis is unaffected by later publishes, reads
  // or another analyst's temporary marks.
  impactWithin(topology:Readonly<TopologyVersion>, assetId:string):ImpactEdge[] {
    return topology.edges
      .filter(e => e.from === assetId || e.to === assetId)
      .sort((a,b) => b.weight - a.weight)
      .map(e => ({...structuredClone(e), traceId:newId('trace')}));
  }
}
